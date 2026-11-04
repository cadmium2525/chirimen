// 建設画面（一時停止中の別画面・上から見た床グリッド）。企画書 2.1 / 3.2 / 5章
import { ROOM, GRID, MACHINES, LAYOUT, PILE, POWER_PANEL, PRIO_NAMES } from './config.js';
import { DIRS } from './factory.js';

const TOOLS = [
  { id: 'pan', label: '✋ 移動' },
  { id: 'conveyor' }, { id: 'hopper' }, { id: 'packer' }, { id: 'crane' }, { id: 'sorter' },
  { id: 'generator' }, { id: 'pole' },
  { id: 'rotate', label: '⟳ 向き変更' },
  { id: 'prio', label: '⚡ 優先度' },
  { id: 'remove', label: '✖ 撤去' },
];
const COLORS = { conveyor: '#59636b', hopper: '#d9822b', packer: '#2f6fb3', crane: '#e8b827', sorter: '#3a8c5c', generator: '#4d6b4f', pole: '#7a6a55' };
const ICON = { conveyor: '', hopper: 'ホ', packer: '包装', crane: 'ク', sorter: '選', generator: '発電', pole: '柱' };
const POWER_TOOLS = new Set(['generator', 'pole', 'prio']);

export class BuildScreen {
  constructor(onClose) {
    this.onClose = onClose;
    const root = document.createElement('div');
    root.id = 'build';
    root.className = 'screen';
    root.hidden = true;
    root.innerHTML = `<div class="build-wrap">
      <div class="build-top">
        <b>建設</b><span id="bMoney" class="chip"></span><span id="bPower" class="chip"></span><span id="bStatus" class="muted small"></span>
        <span class="grow"></span>
        <button id="bZoomOut">−</button><button id="bZoomIn">＋</button>
        <button id="bClose" class="primary">閉じる</button>
      </div>
      <canvas id="bCanvas"></canvas>
      <div class="build-tools" id="bTools"></div>
      <div class="muted small build-hint" id="bHint"></div>
    </div>`;
    document.getElementById('app').appendChild(root);
    this.root = root;
    this.cv = root.querySelector('#bCanvas');
    this.tool = 'pan';
    this.dir = 0;
    this.zoom = 1;
    this.view = { x: 0, z: 0 };
    this.hover = null;
    this.status = '';
    root.querySelector('#bClose').addEventListener('click', () => this.close());
    root.querySelector('#bZoomIn').addEventListener('click', () => { this.zoom = Math.min(4, this.zoom * 1.4); this.draw(); });
    root.querySelector('#bZoomOut').addEventListener('click', () => { this.zoom = Math.max(0.6, this.zoom / 1.4); this.draw(); });
    this._bindCanvas();
    addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.code === 'KeyR') { this.dir = (this.dir + 1) & 3; this._renderTools(); this.draw(); }
      if (e.code === 'Escape' || e.code === 'KeyB') this.close();
    });
    addEventListener('resize', () => { if (!this.root.hidden) this._resize(); });
  }

  open(ctx) {
    this.ctx = ctx;
    this.root.hidden = false;
    this.view = { x: ctx.player.x, z: ctx.player.z };
    this.zoom = 1.6;
    this._renderTools();
    this._resize();
  }

  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.onClose();
  }

  _renderTools() {
    const el = this.root.querySelector('#bTools');
    const arrow = ['→', '↓', '←', '↑'][this.dir];
    el.innerHTML = TOOLS.map((t) => {
      const def = MACHINES[t.id];
      const label = def ? `${def.name}<br><small>${def.price.toLocaleString()}円</small>` : t.label;
      return `<button data-tool="${t.id}" class="${this.tool === t.id ? 'on' : ''}">${label}</button>`;
    }).join('') + `<button data-dir="1" title="R">向き ${arrow}<br><small>[R]</small></button>`;
    el.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => { this.tool = b.dataset.tool; this._renderTools(); this.draw(); }));
    el.querySelector('[data-dir]').addEventListener('click', () => { this.dir = (this.dir + 1) & 3; this._renderTools(); this.draw(); });
    const def = MACHINES[this.tool];
    this.root.querySelector('#bHint').textContent = def
      ? `${def.name}：${def.desc}`
      : this.tool === 'pan' ? 'ドラッグで見る場所を動かす（2本指でピンチ拡大、PCはホイール）。設備を選ぶとマスをタップ／クリックで設置（コンベアはドラッグで連続設置）。'
        : this.tool === 'remove' ? 'タップした設備を撤去（代金の半分が戻る。中身は床に落ちる）。'
          : this.tool === 'prio' ? '電力が足りないとき、優先度の高い設備から電気が回る。タップで 高→中→低 と切り替え。'
            : 'タップした設備の向きを変える。';
  }

  _resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.cv.width = Math.max(10, r.width * dpr);
    this.cv.height = Math.max(10, r.height * dpr);
    this.dpr = dpr;
    this.draw();
  }

  // 座標変換
  get scale() {
    const W = ROOM.maxX - ROOM.minX, D = ROOM.maxZ - ROOM.minZ;
    return Math.min(this.cv.width / W, this.cv.height / D) * this.zoom;
  }
  toScreen(x, z) { const s = this.scale; return [(x - this.view.x) * s + this.cv.width / 2, (z - this.view.z) * s + this.cv.height / 2]; }
  toWorld(px, py) { const s = this.scale; return [(px - this.cv.width / 2) / s + this.view.x, (py - this.cv.height / 2) / s + this.view.z]; }
  _cellFromEvent(e) {
    const r = this.cv.getBoundingClientRect();
    const [x, z] = this.toWorld((e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr);
    return this.ctx.factory.cellOf(x, z);
  }

  _bindCanvas() {
    let panning = null, laying = null, pinch = null;
    const pts = new Map(); // 2本指でピンチ拡大・移動
    const pinchState = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    };
    this.cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.cv.setPointerCapture(e.pointerId);
      if (pts.size === 2) {
        const p0 = pinchState();
        pinch = { ...p0, zoom: this.zoom, vx: this.view.x, vz: this.view.z };
        panning = null; laying = null;
        return;
      }
      if (this.tool === 'pan' || e.button === 1 || e.button === 2) {
        panning = { x: e.clientX, y: e.clientY, vx: this.view.x, vz: this.view.z };
        laying = null;
        return;
      }
      const [i, j] = this._cellFromEvent(e);
      if (this.tool === 'conveyor') {
        laying = { i, j, placed: this._place('conveyor', i, j, this.dir) };
      } else {
        this._apply(i, j);
      }
    });
    this.cv.addEventListener('pointermove', (e) => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const p1 = pinchState();
        this.zoom = Math.max(0.6, Math.min(5, pinch.zoom * (p1.d / Math.max(10, pinch.d))));
        const sc = this.scale / this.dpr;
        this.view.x = pinch.vx - (p1.cx - pinch.cx) / sc;
        this.view.z = pinch.vz - (p1.cy - pinch.cy) / sc;
        this.draw();
        return;
      }
      if (panning) {
        const s = this.scale / this.dpr;
        this.view.x = panning.vx - (e.clientX - panning.x) / s;
        this.view.z = panning.vz - (e.clientY - panning.y) / s;
        this.draw();
        return;
      }
      const [i, j] = this._cellFromEvent(e);
      if (laying && (i !== laying.i || j !== laying.j)) {
        // 隣のマスへ進んだら、前のマスのベルトをそちらへ向けて次を置く
        const di = Math.sign(i - laying.i), dj = Math.sign(j - laying.j);
        const step = di !== 0 ? [di, 0] : [0, dj];
        const dir = DIRS.findIndex(([a, b]) => a === step[0] && b === step[1]);
        const prev = this.ctx.factory.get(laying.i, laying.j);
        if (prev && prev.type === 'conveyor' && laying.placed) { prev.dir = dir; this.ctx.factory.version++; }
        const ni = laying.i + step[0], nj = laying.j + step[1];
        this.dir = dir;
        laying = { i: ni, j: nj, placed: this._place('conveyor', ni, nj, dir) };
        this._renderTools();
      }
      if (!this.hover || this.hover[0] !== i || this.hover[1] !== j) { this.hover = [i, j]; this.draw(); }
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; panning = null; laying = null; this.draw(); };
    this.cv.addEventListener('pointerup', up);
    this.cv.addEventListener('pointercancel', up);
    this.cv.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    this.cv.addEventListener('contextmenu', (e) => e.preventDefault());
    this.cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.6, Math.min(4, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.draw();
    }, { passive: false });
  }

  _place(type, i, j, dir) {
    const { factory, player } = this.ctx;
    const r = factory.place(type, i, j, dir, player);
    this.status = r.ok ? `${MACHINES[type].name}を設置した` : `設置できない：${r.reason}`;
    this.ctx.onChange?.();
    this.draw();
    return r.ok;
  }

  _apply(i, j) {
    const { factory } = this.ctx;
    const m = factory.get(i, j);
    if (this.tool === 'remove') {
      if (m) { factory.remove(i, j); this.status = `${MACHINES[m.type].name}を撤去した（${Math.floor(MACHINES[m.type].price / 2).toLocaleString()}円 戻った）`; }
      this.ctx.onChange?.();
    } else if (this.tool === 'rotate' || (MACHINES[this.tool] && m && m.type === this.tool)) {
      if (m) { const r = factory.rotate(i, j); this.status = r.ok ? '向きを変えた' : `向きを変えられない：${r.reason}`; }
    } else if (this.tool === 'prio') {
      if (m && MACHINES[m.type].power != null) { factory.cyclePrio(m); this.status = `${MACHINES[m.type].name}の優先度：${PRIO_NAMES[m.prio]}`; }
    } else if (MACHINES[this.tool]) {
      this._place(this.tool, i, j, this.dir);
    }
    this.draw();
  }

  // ===== 描画 =====
  draw() {
    if (this.root.hidden || !this.ctx) return;
    const { factory, pile, player, game } = this.ctx;
    const g = this.cv.getContext('2d');
    const s = this.scale, c = GRID.cell;
    g.fillStyle = '#1a252d';
    g.fillRect(0, 0, this.cv.width, this.cv.height);
    // 床
    let [x0, y0] = this.toScreen(ROOM.minX, ROOM.minZ);
    g.fillStyle = '#6f7579';
    g.fillRect(x0, y0, (ROOM.maxX - ROOM.minX) * s, (ROOM.maxZ - ROOM.minZ) * s);
    const F = LAYOUT.freeFloor;
    [x0, y0] = this.toScreen(F.minX, F.minZ);
    g.fillStyle = 'rgba(160,200,220,0.18)';
    g.fillRect(x0, y0, (F.maxX - F.minX) * s, (F.maxZ - F.minZ) * s);
    // 山（現在の高さ）
    for (let i = 0; i < factory.cols; i++) for (let j = 0; j < factory.rows; j++) {
      const x = factory.cx(i), z = factory.cz(j);
      if (Math.hypot(x - PILE.cx, z - PILE.cz) > PILE.radius + 0.4) continue;
      let h = 0;
      for (const [ox, oz] of [[0, 0], [-0.2, -0.2], [0.2, 0.2], [-0.2, 0.2], [0.2, -0.2]]) h = Math.max(h, pile.heightAt(x + ox, z + oz));
      if (h <= 0.03) continue;
      const [sx, sy] = this.toScreen(x - c / 2, z - c / 2);
      const v = Math.min(1, h / PILE.height);
      g.fillStyle = `rgb(${200 + v * 40},${192 + v * 40},${170 + v * 50})`;
      g.fillRect(sx, sy, c * s + 0.5, c * s + 0.5);
    }
    // グリッド
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i <= factory.cols; i++) { const [sx, sy] = this.toScreen(ROOM.minX + i * c, ROOM.minZ); g.moveTo(sx, sy); g.lineTo(sx, sy + (ROOM.maxZ - ROOM.minZ) * s); }
    for (let j = 0; j <= factory.rows; j++) { const [sx, sy] = this.toScreen(ROOM.minX, ROOM.minZ + j * c); g.moveTo(sx, sy); g.lineTo(sx + (ROOM.maxX - ROOM.minX) * s, sy); }
    g.stroke();
    // 作業場の設備
    const label = (txt, x, z) => {
      const [sx, sy] = this.toScreen(x, z);
      g.fillStyle = '#fff';
      g.font = `${Math.max(10, 0.28 * s)}px sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, sx, sy);
    };
    const names = ['計量機', '完成パック', '保護ケース', '購入端末', '受電盤'];
    factory.staticBoxes.forEach((o, k) => {
      const [sx, sy] = this.toScreen(o.minX, o.minZ);
      g.fillStyle = k === 0 ? '#7a2e2e' : '#3b4a55';
      g.fillRect(sx, sy, (o.maxX - o.minX) * s, (o.maxZ - o.minZ) * s);
      if (names[k]) label(names[k], (o.minX + o.maxX) / 2, (o.minZ + o.maxZ) / 2);
    });
    label('しらすの山', PILE.cx, PILE.cz);
    // 電力：配電範囲と電線
    factory.powerSummary();
    const strong = POWER_TOOLS.has(this.tool);
    const nodes = [{ x: POWER_PANEL.x, z: POWER_PANEL.z, cov: POWER_PANEL.coverage }];
    for (const m of factory.machines.values()) if (m.type === 'generator' || m.type === 'pole') { const cc = factory.center(m); nodes.push({ x: cc.x, z: cc.z, cov: MACHINES[m.type].coverage }); }
    for (const nd of nodes) {
      const [cx, cy] = this.toScreen(nd.x, nd.z);
      g.fillStyle = strong ? 'rgba(255,210,63,0.13)' : 'rgba(255,210,63,0.05)';
      g.beginPath(); g.arc(cx, cy, nd.cov * s, 0, Math.PI * 2); g.fill();
      g.strokeStyle = strong ? 'rgba(255,210,63,0.6)' : 'rgba(255,210,63,0.2)';
      g.stroke();
    }
    g.strokeStyle = '#ffd23f'; g.lineWidth = 2;
    for (const [a, b] of factory.links || []) {
      const [ax, ay] = this.toScreen(a.x, a.z), [bx, by] = this.toScreen(b.x, b.z);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    }
    // 設備（占有マスごと）
    for (const m of factory.machines.values()) {
      g.fillStyle = COLORS[m.type];
      g.globalAlpha = m.on ? 1 : 0.5;
      for (const [a, b] of factory.cells(m)) {
        const [sx, sy] = this.toScreen(factory.cx(a) - c / 2, factory.cz(b) - c / 2);
        g.fillRect(sx + 1, sy + 1, c * s - 2, c * s - 2);
      }
      g.globalAlpha = 1;
      const cc = factory.center(m);
      if (m.type === 'generator') {
        g.strokeStyle = 'rgba(126,226,160,0.5)'; g.setLineDash([3, 3]);
        const [rx, ry] = this.toScreen(factory.cx(m.i - 1) - c / 2, factory.cz(m.j - 1) - c / 2);
        g.strokeRect(rx, ry, 4 * c * s, 4 * c * s); g.setLineDash([]);
      }
      if (m.type !== 'generator' && m.type !== 'pole') this._arrow(g, m.type === 'packer' ? factory.cx(m.i) : cc.x, m.type === 'packer' ? factory.cz(m.j) : cc.z, m.dir, m.type === 'conveyor' ? '#e8b827' : '#fff');
      if (ICON[m.type]) label(ICON[m.type], cc.x, cc.z + (m.type === 'packer' ? 0 : 0));
      if (m.type === 'crane') {
        const [cx, cy] = this.toScreen(cc.x, cc.z);
        g.strokeStyle = 'rgba(232,184,39,0.6)';
        g.setLineDash([6, 6]);
        g.beginPath(); g.arc(cx, cy, MACHINES.crane.reach * s, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
      }
      const iss = factory.issues(m).filter((x) => x !== '停止中');
      if (iss.length) {
        const [sx, sy] = this.toScreen(factory.cx(m.i) + c * 0.28, factory.cz(m.j) - c * 0.28);
        g.fillStyle = iss.some((x) => x.includes('減速')) && iss.length === 1 ? '#ffd23f' : '#ff5a4a';
        g.beginPath(); g.arc(sx, sy, Math.max(5, 0.13 * s), 0, Math.PI * 2); g.fill();
        g.fillStyle = '#000'; g.font = `bold ${Math.max(9, 0.2 * s)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('!', sx, sy + 1);
      }
      if (strong && MACHINES[m.type].power != null) label(PRIO_NAMES[m.prio], cc.x, cc.z + 0.17);
    }
    // プレイヤー
    const [px, py] = this.toScreen(player.x, player.z);
    g.fillStyle = '#ff5a4a';
    g.beginPath(); g.arc(px, py, Math.max(5, 0.22 * s), 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ff5a4a'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(px, py); g.lineTo(px - Math.sin(player.yaw) * 0.6 * s, py - Math.cos(player.yaw) * 0.6 * s); g.stroke();
    // カーソル
    if (this.hover) {
      const [i, j] = this.hover;
      const existing = factory.get(i, j);
      if (MACHINES[this.tool] && !(existing && existing.type === this.tool)) {
        const can = factory.canPlace(this.tool, i, j, player, { dir: this.dir });
        g.fillStyle = can.ok ? 'rgba(126,226,160,0.55)' : 'rgba(255,90,74,0.5)';
        for (const [a, b] of factory.cellsFor(this.tool, i, j, this.dir)) {
          const [sx, sy] = this.toScreen(factory.cx(a) - c / 2, factory.cz(b) - c / 2);
          g.fillRect(sx, sy, c * s, c * s);
        }
        if (this.tool === 'generator') {
          g.strokeStyle = '#fff'; g.setLineDash([3, 3]);
          const [rx, ry] = this.toScreen(factory.cx(i - 1) - c / 2, factory.cz(j - 1) - c / 2);
          g.strokeRect(rx, ry, 4 * c * s, 4 * c * s); g.setLineDash([]);
        } else if (this.tool !== 'pole') this._arrow(g, factory.cx(i), factory.cz(j), this.dir, '#fff');
        if (this.tool === 'packer') {
          const [fi, fj] = factory._frontOf('packer', i, j, this.dir);
          const [sx, sy] = this.toScreen(factory.cx(fi) - c / 2, factory.cz(fj) - c / 2);
          g.strokeStyle = '#fff'; g.setLineDash([3, 3]); g.strokeRect(sx + 2, sy + 2, c * s - 4, c * s - 4); g.setLineDash([]);
        }
        const cov = this.tool === 'crane' ? MACHINES.crane.reach : MACHINES[this.tool].coverage;
        if (cov) {
          const cells = factory.cellsFor(this.tool, i, j, this.dir);
          const mx = cells.reduce((acc, [a]) => acc + factory.cx(a), 0) / cells.length;
          const mz = cells.reduce((acc, [, b]) => acc + factory.cz(b), 0) / cells.length;
          const [cx, cy] = this.toScreen(mx, mz);
          g.strokeStyle = '#fff'; g.setLineDash([4, 4]);
          g.beginPath(); g.arc(cx, cy, cov * s, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        }
        this.status = can.ok ? `${MACHINES[this.tool].name}：${MACHINES[this.tool].price.toLocaleString()}円` : `ここには置けない：${can.reason}`;
      } else if (existing) {
        const def = MACHINES[existing.type];
        const iss = factory.issues(existing);
        const pw = def.power != null ? ` ${def.power}kW・優先度${PRIO_NAMES[existing.prio]}` : '';
        this.status = `${def.name}${pw}${iss.length ? '：' + iss.join('／') : '：正常'}`;
      }
    }
    const ps = factory.powerSummary();
    const pEl = this.root.querySelector('#bPower');
    pEl.textContent = `⚡ 需要 ${ps.demand.toFixed(1)} / 供給 ${ps.supply.toFixed(1)} kW${ps.unpowered ? `・電源なし ${ps.unpowered}台` : ''}`;
    pEl.style.color = ps.short || ps.unpowered ? '#ff7a6b' : '#7ee2a0';
    this.root.querySelector('#bMoney').textContent = `所持金 ${Math.floor(game.money).toLocaleString()}円`;
    this.root.querySelector('#bStatus').textContent = this.status;
  }

  _arrow(g, x, z, dir, color) {
    const [dx, dz] = DIRS[dir];
    const s = this.scale, L = 0.18;
    const [ax, ay] = this.toScreen(x - dx * L, z - dz * L);
    const [bx, by] = this.toScreen(x + dx * L, z + dz * L);
    g.strokeStyle = color; g.fillStyle = color;
    g.lineWidth = Math.max(2, 0.05 * s);
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    const nx = -dz, nz = dx, h = 0.09;
    const [c1x, c1y] = this.toScreen(x + dx * (L - h) + nx * h, z + dz * (L - h) + nz * h);
    const [c2x, c2y] = this.toScreen(x + dx * (L - h) - nx * h, z + dz * (L - h) - nz * h);
    g.beginPath(); g.moveTo(bx, by); g.lineTo(c1x, c1y); g.lineTo(c2x, c2y); g.closePath(); g.fill();
  }
}
