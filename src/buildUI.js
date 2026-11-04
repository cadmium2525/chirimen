// 建設画面（一時停止中の別画面・上から見た床グリッド）。企画書 2.1 / 3.2 / 5章
import { ROOM, GRID, MACHINES, LAYOUT, PILE } from './config.js';
import { DIRS } from './factory.js';

const TOOLS = [
  { id: 'pan', label: '✋ 移動' },
  { id: 'conveyor' }, { id: 'hopper' }, { id: 'packer' }, { id: 'crane' },
  { id: 'rotate', label: '⟳ 向き変更' },
  { id: 'remove', label: '✖ 撤去' },
];
const COLORS = { conveyor: '#59636b', hopper: '#d9822b', packer: '#2f6fb3', crane: '#e8b827' };
const ICON = { conveyor: '', hopper: 'ホ', packer: '包', crane: 'ク' };

export class BuildScreen {
  constructor(onClose) {
    this.onClose = onClose;
    const root = document.createElement('div');
    root.id = 'build';
    root.className = 'screen';
    root.hidden = true;
    root.innerHTML = `<div class="build-wrap">
      <div class="build-top">
        <b>建設</b><span id="bMoney" class="chip"></span><span id="bStatus" class="muted small"></span>
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
      : this.tool === 'pan' ? 'ドラッグで見る場所を動かす。設備を選ぶとマスをタップ／クリックで設置（コンベアはドラッグで連続設置）。'
        : this.tool === 'remove' ? 'タップした設備を撤去（代金の半分が戻る。中身は床に落ちる）。'
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
    let panning = null, laying = null, pointers = 0;
    this.cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pointers++;
      this.cv.setPointerCapture(e.pointerId);
      if (this.tool === 'pan' || e.button === 1 || e.button === 2 || pointers > 1) {
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
    const up = () => { pointers = Math.max(0, pointers - 1); panning = null; laying = null; this.draw(); };
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
    } else if (this.tool === 'rotate') {
      if (m) { factory.rotate(i, j); this.status = '向きを変えた'; }
    } else if (MACHINES[this.tool]) {
      if (m && m.type === this.tool) { factory.rotate(i, j); this.status = '向きを変えた'; } else this._place(this.tool, i, j, this.dir);
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
    const names = ['計量機', '完成パック', '保護ケース', '購入端末'];
    factory.staticBoxes.forEach((o, k) => {
      const [sx, sy] = this.toScreen(o.minX, o.minZ);
      g.fillStyle = k === 0 ? '#7a2e2e' : '#3b4a55';
      g.fillRect(sx, sy, (o.maxX - o.minX) * s, (o.maxZ - o.minZ) * s);
      if (names[k]) label(names[k], (o.minX + o.maxX) / 2, (o.minZ + o.maxZ) / 2);
    });
    label('しらすの山', PILE.cx, PILE.cz);
    // 設備
    for (const m of factory.machines.values()) {
      const x = factory.cx(m.i), z = factory.cz(m.j);
      const [sx, sy] = this.toScreen(x - c / 2, z - c / 2);
      const w = c * s;
      g.fillStyle = COLORS[m.type];
      g.globalAlpha = m.on ? 1 : 0.5;
      g.fillRect(sx + 1, sy + 1, w - 2, w - 2);
      g.globalAlpha = 1;
      this._arrow(g, x, z, m.dir, m.type === 'conveyor' ? '#e8b827' : '#fff');
      if (ICON[m.type]) label(ICON[m.type], x, z);
      if (m.type === 'crane') {
        const [cx, cy] = this.toScreen(x, z);
        g.strokeStyle = 'rgba(232,184,39,0.6)';
        g.setLineDash([6, 6]);
        g.beginPath(); g.arc(cx, cy, MACHINES.crane.reach * s, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
      }
    }
    // プレイヤー
    const [px, py] = this.toScreen(player.x, player.z);
    g.fillStyle = '#ff5a4a';
    g.beginPath(); g.arc(px, py, Math.max(5, 0.22 * s), 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ff5a4a'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(px, py); g.lineTo(px - Math.sin(player.yaw) * 0.6 * s, py - Math.cos(player.yaw) * 0.6 * s); g.stroke();
    // カーソル
    if (this.hover && MACHINES[this.tool]) {
      const [i, j] = this.hover;
      const can = factory.get(i, j)?.type === this.tool ? { ok: true } : factory.canPlace(this.tool, i, j, player);
      const [sx, sy] = this.toScreen(factory.cx(i) - c / 2, factory.cz(j) - c / 2);
      g.fillStyle = can.ok ? 'rgba(126,226,160,0.55)' : 'rgba(255,90,74,0.5)';
      g.fillRect(sx, sy, c * s, c * s);
      this._arrow(g, factory.cx(i), factory.cz(j), this.dir, '#fff');
      if (this.tool === 'crane') {
        const [cx, cy] = this.toScreen(factory.cx(i), factory.cz(j));
        g.strokeStyle = '#fff'; g.setLineDash([4, 4]);
        g.beginPath(); g.arc(cx, cy, MACHINES.crane.reach * s, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      }
      if (!can.ok) this.status = `ここには置けない：${can.reason}`;
    }
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
