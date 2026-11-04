// 搬送設備のシミュレーション（企画書 3章・P3）。three.js 非依存。
//
// - 設備は 0.5m 四方の床グリッド上に置く（1設備＝1マス、向き 0:+X 1:+Z 2:-X 3:-Z）。
// - 運ばれるのは実在する個体ID。クレーンは山の「未処理として残っているID」を取り除く（pile.scrape）。
// - ベルト上の個体は「バッチ（IDの配列）」単位で流れる。描画更新とは独立に固定ステップで進む。

import { ROOM, GRID, MACHINES, BELT, LAYOUT, PACK_SIZE } from './config.js';

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const DIR_NAMES = ['→', '↓', '←', '↑']; // 上から見た図（+Z が下）

const STEP = 0.05;
const SCALE_BOX = { minX: LAYOUT.scale.x - 0.45, maxX: LAYOUT.scale.x + 0.45, minZ: LAYOUT.scale.z - 0.45, maxZ: LAYOUT.scale.z + 0.45 };

export class Factory {
  constructor(game, saved = null) {
    this.game = game;
    this.cols = Math.round((ROOM.maxX - ROOM.minX) / GRID.cell);
    this.rows = Math.round((ROOM.maxZ - ROOM.minZ) / GRID.cell);
    this.machines = new Map(); // "i,j" -> machine
    this.nextId = 1;
    this.acc = 0;
    this.version = 0;          // 配置が変わるたびに増える
    this.staticBoxes = [];     // 計量機・棚などの占有範囲
    if (saved) this._load(saved);
  }

  setStaticBoxes(boxes) { this.staticBoxes = boxes; }

  // ===== グリッド =====
  key(i, j) { return `${i},${j}`; }
  get(i, j) { return this.machines.get(this.key(i, j)); }
  cx(i) { return ROOM.minX + (i + 0.5) * GRID.cell; }
  cz(j) { return ROOM.minZ + (j + 0.5) * GRID.cell; }
  cellOf(x, z) { return [Math.floor((x - ROOM.minX) / GRID.cell), Math.floor((z - ROOM.minZ) / GRID.cell)]; }
  inGrid(i, j) { return i >= 0 && j >= 0 && i < this.cols && j < this.rows; }
  front(m) { const [dx, dz] = DIRS[m.dir]; return [m.i + dx, m.j + dz]; }

  cellBox(i, j) {
    const x = this.cx(i), z = this.cz(j), h = GRID.cell / 2;
    return { minX: x - h, maxX: x + h, minZ: z - h, maxZ: z + h };
  }

  /** 設置できるか。ok=false のとき reason に理由 */
  canPlace(type, i, j, player = null, { ignoreMoney = false } = {}) {
    const def = MACHINES[type];
    if (!def) return { ok: false, reason: '不明な設備' };
    if (!this.inGrid(i, j) || i === 0 || j === 0 || i === this.cols - 1 || j === this.rows - 1) return { ok: false, reason: '壁ぎわには置けない' };
    if (this.get(i, j)) return { ok: false, reason: 'ほかの設備がある' };
    const b = this.cellBox(i, j);
    for (const o of this.staticBoxes) {
      if (b.minX < o.maxX && b.maxX > o.minX && b.minZ < o.maxZ && b.maxZ > o.minZ) return { ok: false, reason: '作業場の設備と重なる' };
    }
    const pile = this.game.pile;
    const pts = [[0, 0], [-0.24, -0.24], [0.24, -0.24], [-0.24, 0.24], [0.24, 0.24]];
    for (const [ox, oz] of pts) {
      if (pile.heightAt(this.cx(i) + ox, this.cz(j) + oz) > 0.03) return { ok: false, reason: 'しらすの山がある（掘れば置ける）' };
    }
    if (def.blocks && player) {
      const r = 0.3;
      if (player.x > b.minX - r && player.x < b.maxX + r && player.z > b.minZ - r && player.z < b.maxZ + r) return { ok: false, reason: '自分が立っている' };
    }
    if (type === 'crane') {
      const d = Math.hypot(this.cx(i) - pile.cx, this.cz(j) - pile.cz);
      if (d > pile.radius + 1.6) return { ok: false, reason: '山から遠すぎる（クレーンの腕が届かない）' };
    }
    if (!ignoreMoney && this.game.money < def.price) return { ok: false, reason: 'お金が足りない' };
    return { ok: true };
  }

  place(type, i, j, dir, player = null) {
    const can = this.canPlace(type, i, j, player);
    if (!can.ok) return can;
    const def = MACHINES[type];
    this.game.money -= def.price;
    const m = { id: this.nextId++, type, i, j, dir: dir & 3, on: true, batches: [], buffer: [], timer: 0, phase: 'idle', t: 0, tx: 0, tz: 0, holding: [], packs: 0 };
    this.machines.set(this.key(i, j), m);
    this.version++;
    this.game.emit('changed');
    return { ok: true, machine: m };
  }

  /** 撤去。中身は床に落とし、代金の半分が戻る */
  remove(i, j) {
    const m = this.get(i, j);
    if (!m) return false;
    const ids = this.contents(m);
    if (ids.length) this.game.dropIdsToFloor(ids, { x: this.cx(i), z: this.cz(j) });
    this.machines.delete(this.key(i, j));
    this.game.money += Math.floor(MACHINES[m.type].price / 2);
    this.version++;
    this.game.emit('changed');
    return true;
  }

  rotate(i, j, d = 1) {
    const m = this.get(i, j);
    if (!m) return;
    m.dir = (m.dir + d + 4) & 3;
    this.version++;
  }

  toggle(m) { m.on = !m.on; this.version++; this.game.emit('machineToggle', { machine: m }); }

  contents(m) {
    const ids = [];
    for (const b of m.batches) ids.push(...b.ids);
    ids.push(...m.buffer, ...m.holding);
    return ids;
  }

  count() {
    let n = 0;
    for (const m of this.machines.values()) {
      for (const b of m.batches) n += b.ids.length;
      n += m.buffer.length + m.holding.length;
    }
    return n;
  }

  allIds() {
    const ids = [];
    for (const m of this.machines.values()) ids.push(...this.contents(m));
    return ids;
  }

  hasChiri(m) {
    const pile = this.game.pile;
    return this.contents(m).some((id) => pile.isChirimon(id));
  }

  /** 立ち入れない設備の範囲（プレイヤーの当たり判定用） */
  obstacles() {
    const out = [];
    for (const m of this.machines.values()) if (MACHINES[m.type].blocks) out.push(this.cellBox(m.i, m.j));
    return out;
  }

  // ===== 受け渡し =====
  _batch(ids) {
    const pile = this.game.pile;
    return { ids, pos: 0, chiri: ids.filter((id) => pile.isChirimon(id)) };
  }

  /** 設備 m がバッチを受け取れるか試し、受け取ったら true */
  accept(m, ids) {
    if (!m || !ids.length) return false;
    if (m.type === 'conveyor') {
      const last = m.batches[m.batches.length - 1];
      if (last && last.pos < BELT.spacing) return false;
      m.batches.push(this._batch(ids));
      return true;
    }
    if (m.type === 'hopper') {
      if (m.buffer.length + ids.length > MACHINES.hopper.capacity) return false;
      m.buffer.push(...ids);
      return true;
    }
    if (m.type === 'packer') {
      if (m.buffer.length >= MACHINES.packer.capacity) return false;
      m.buffer.push(...ids);
      return true;
    }
    return false;
  }

  /** マス (i,j) へ届ける。設備か計量機があれば受け取る */
  deliver(i, j, ids) {
    const m = this.get(i, j);
    if (m) return this.accept(m, ids);
    const x = this.cx(i), z = this.cz(j);
    if (x > SCALE_BOX.minX && x < SCALE_BOX.maxX && z > SCALE_BOX.minZ && z < SCALE_BOX.maxZ) {
      this.game.factoryToScale(ids);
      return true;
    }
    return false;
  }

  /** 手から入れる（入った数を返す） */
  insertFromHand(m, ids) {
    if (m.type === 'crane') return 0;
    if (m.type === 'conveyor') {
      const take = ids.slice(0, 200);
      return this.accept(m, take) ? take.length : 0;
    }
    const cap = MACHINES[m.type].capacity;
    const n = Math.max(0, Math.min(ids.length, cap - m.buffer.length));
    if (n) m.buffer.push(...ids.slice(0, n));
    return n;
  }

  /** 手で取り出す（ちりモン優先） */
  takeFrom(m, room) {
    if (room <= 0) return [];
    const pile = this.game.pile;
    const out = [];
    const takeChiri = (arr) => {
      for (let k = arr.length - 1; k >= 0 && out.length < room; k--) {
        if (pile.isChirimon(arr[k])) { out.push(arr[k]); arr.splice(k, 1); }
      }
    };
    for (const b of m.batches) { takeChiri(b.ids); b.chiri = b.ids.filter((id) => pile.isChirimon(id)); }
    takeChiri(m.buffer);
    takeChiri(m.holding);
    // 残りはしらす（ベルトなら一番手前のバッチから）
    while (out.length < room) {
      if (m.batches.length) {
        const b = m.batches[m.batches.length - 1];
        out.push(...b.ids.splice(-(room - out.length)));
        if (!b.ids.length) m.batches.pop();
      } else if (m.buffer.length) {
        out.push(...m.buffer.splice(-(room - out.length)));
      } else break;
    }
    m.batches = m.batches.filter((b) => b.ids.length);
    return out;
  }

  // ===== 時間経過 =====
  tick(dt) {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this._step(STEP);
    }
  }

  _step(dt) {
    for (const m of this.machines.values()) {
      if (!m.on) continue;
      if (m.type === 'conveyor') this._belt(m, dt);
      else if (m.type === 'hopper') this._hopper(m, dt);
      else if (m.type === 'packer') this._packer(m, dt);
      else if (m.type === 'crane') this._crane(m, dt);
    }
  }

  _belt(m, dt) {
    const b = m.batches;
    for (let k = 0; k < b.length; k++) {
      const limit = k === 0 ? 1 : b[k - 1].pos - BELT.spacing;
      b[k].pos = Math.max(b[k].pos, Math.min(limit, b[k].pos + BELT.speed * dt));
    }
    if (b.length && b[0].pos >= 1) {
      const [ni, nj] = this.front(m);
      if (this.deliver(ni, nj, b[0].ids)) b.shift();
    }
  }

  _hopper(m, dt) {
    m.timer -= dt;
    if (m.timer > 0 || !m.buffer.length) return;
    m.timer = BELT.hopperInterval;
    const batch = m.buffer.slice(0, BELT.hopperBatch);
    const [ni, nj] = this.front(m);
    if (this.deliver(ni, nj, batch)) m.buffer.splice(0, batch.length);
  }

  _packer(m, dt) {
    m.timer -= dt;
    if (m.timer > 0 || m.buffer.length < PACK_SIZE) return;
    m.timer = BELT.packInterval;
    this.game.shipPack(m.buffer.splice(0, PACK_SIZE), 'packer');
    m.packs++;
  }

  /** クレーン：待機 → 腕を伸ばす → つかむ → 戻す → 降ろす */
  _crane(m, dt) {
    const def = MACHINES.crane;
    m.t += dt;
    const x = this.cx(m.i), z = this.cz(m.j);
    if (m.phase === 'idle') {
      if (m.t < 0.4) return;
      const target = this._craneTarget(x, z, def.reach);
      if (!target) { m.t = -1; return; } // 届く範囲に山がない
      m.tx = target.x; m.tz = target.z;
      m.phase = 'out'; m.t = 0;
    } else if (m.phase === 'out' && m.t >= def.cycle * 0.35) {
      m.phase = 'grab'; m.t = 0;
    } else if (m.phase === 'grab' && m.t >= def.cycle * 0.12) {
      m.holding = this.game.machineGrab(m.tx, m.tz, 0.2, def.grab);
      m.phase = 'back'; m.t = 0;
    } else if (m.phase === 'back' && m.t >= def.cycle * 0.35) {
      m.phase = 'drop'; m.t = 0;
    } else if (m.phase === 'drop' && m.t >= def.cycle * 0.18) {
      const [ni, nj] = this.front(m);
      if (!m.holding.length || this.deliver(ni, nj, m.holding)) {
        m.holding = [];
        m.phase = 'idle'; m.t = 0;
      } else {
        m.t = def.cycle * 0.18 - 0.3; // 受け取り先が空くまで待つ
      }
    }
  }

  /** 可動範囲の中で一番高い所 */
  _craneTarget(x, z, reach) {
    const pile = this.game.pile;
    let best = null, bh = 0.02;
    for (const c of pile.colsInRadius(x, z, reach)) {
      const h = pile.topH[c];
      if (h > bh) { bh = h; best = c; }
    }
    if (best == null) return null;
    return { x: pile.colCenterX(best), z: pile.colCenterZ(best), h: bh };
  }

  /** クレーンの腕の先の位置（描画用）0..1 の補間 */
  craneArm(m) {
    const def = MACHINES.crane;
    const x = this.cx(m.i), z = this.cz(m.j);
    const [dx, dz] = DIRS[m.dir];
    const home = { x: x + dx * 0.5, z: z + dz * 0.5 };
    const tgt = { x: m.tx || home.x, z: m.tz || home.z };
    const pile = this.game.pile;
    const th = pile.heightAt(tgt.x, tgt.z);
    const ease = (t) => t * t * (3 - 2 * t);
    let p = 0, drop = 0;
    if (m.phase === 'out') p = ease(Math.min(1, m.t / (def.cycle * 0.35)));
    else if (m.phase === 'grab') { p = 1; drop = Math.sin(Math.min(1, m.t / (def.cycle * 0.12)) * Math.PI); }
    else if (m.phase === 'back') p = 1 - ease(Math.min(1, m.t / (def.cycle * 0.35)));
    else if (m.phase === 'drop') { p = 0; drop = 0.4; }
    let y = 2.2;
    if (m.phase === 'grab') y = 2.2 + (th + 0.06 - 2.2) * drop;
    else if (m.phase === 'drop') y = 1.45;
    return { x: home.x + (tgt.x - home.x) * p, z: home.z + (tgt.z - home.z) * p, y, holding: m.holding.length };
  }

  // ===== 新しい山・保存 =====
  clearContents() {
    for (const m of this.machines.values()) { m.batches = []; m.buffer = []; m.holding = []; m.phase = 'idle'; m.t = 0; }
    this.version++;
  }

  toJSON() {
    return {
      nextId: this.nextId,
      machines: [...this.machines.values()].map((m) => ({
        id: m.id, type: m.type, i: m.i, j: m.j, dir: m.dir, on: m.on,
        batches: m.batches.map((b) => ({ ids: b.ids, pos: b.pos })), buffer: m.buffer, holding: m.holding,
        timer: m.timer, phase: m.phase, t: m.t, tx: m.tx, tz: m.tz, packs: m.packs,
      })),
    };
  }

  _load(s) {
    this.nextId = s.nextId || 1;
    const pile = this.game.pile;
    for (const d of s.machines || []) {
      const m = { buffer: [], holding: [], batches: [], timer: 0, phase: 'idle', t: 0, tx: 0, tz: 0, packs: 0, ...d };
      m.batches = (d.batches || []).map((b) => ({ ids: b.ids, pos: b.pos, chiri: b.ids.filter((id) => pile.isChirimon(id)) }));
      this.machines.set(this.key(m.i, m.j), m);
    }
  }
}
