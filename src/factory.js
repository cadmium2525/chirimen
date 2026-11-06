// 搬送・工場設備のシミュレーション（企画書 3章・P3〜P4）。three.js 非依存。
//
// - 床は 0.5m 四方のグリッド。設備ごとに占有マス・向き・入口／出口を持つ（3.2）。
// - 電力は「発電量」と「消費量」の簡易シミュレーション。発電機・電柱・受電盤が電力網をつくり、
//   範囲内の設備へ配電する。不足すると優先度の低い設備から停止・速度低下する（3.3）。
// - 運ばれるのは実在する個体ID。クレーンは山に残っているIDを取り除き、選別機は検出率に応じて
//   ちりモンを回収箱へ分ける。見落とされたちりモンが包装されると誤出荷（3.4）。

import { ROOM, GRID, MACHINES, BELT, LAYOUT, PACK_SIZE, POWER_PANEL, PILE_BLOCK_HEIGHT } from './config.js';
import { hash01 } from './rng.js';

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const DIR_NAMES = ['→', '↓', '←', '↑']; // 上から見た図（+Z が下）

const STEP = 0.05;
const CRANE_STANDBY_KW = 0.3; // 届く範囲が空のクレーンの待機電力
// 計量機の本体（world.js の障害物と同じ範囲）。これに重なるマスへ出せば、どの面からでも計量機に入る
const SCALE_BOX = { minX: LAYOUT.scale.x - 0.4, maxX: LAYOUT.scale.x + 0.4, minZ: LAYOUT.scale.z - 0.4, maxZ: LAYOUT.scale.z + 0.4 };
const CONSUMERS = new Set(['conveyor', 'hopper', 'packer', 'crane', 'sorter']);

export class Factory {
  constructor(game, saved = null) {
    this.game = game;
    this.cols = Math.round((ROOM.maxX - ROOM.minX) / GRID.cell);
    this.rows = Math.round((ROOM.maxZ - ROOM.minZ) / GRID.cell);
    this.machines = new Map(); // id -> machine
    this.occ = new Map();      // "i,j" -> machine（占有マス）
    this.nextId = 1;
    this.acc = 0;
    this.version = 0;          // 配置が変わるたびに増える
    this.staticBoxes = [];     // 計量機・棚などの占有範囲
    this.nets = [];
    this.netVersion = -1;
    this.powerT = 0;
    this.noFuelWarned = false;
    if (saved) this._load(saved);
  }

  setStaticBoxes(boxes) { this.staticBoxes = boxes; this.version++; }

  // ===== グリッド =====
  key(i, j) { return `${i},${j}`; }
  get(i, j) { return this.occ.get(this.key(i, j)); }
  cx(i) { return ROOM.minX + (i + 0.5) * GRID.cell; }
  cz(j) { return ROOM.minZ + (j + 0.5) * GRID.cell; }
  cellOf(x, z) { return [Math.floor((x - ROOM.minX) / GRID.cell), Math.floor((z - ROOM.minZ) / GRID.cell)]; }
  inGrid(i, j) { return i >= 0 && j >= 0 && i < this.cols && j < this.rows; }
  isEdge(i, j) { return i === 0 || j === 0 || i === this.cols - 1 || j === this.rows - 1; }

  /** 設備が占めるマス */
  cellsFor(type, i, j, dir) {
    if (type === 'generator') return [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]];
    const [, d] = MACHINES[type].size;
    const [dx, dz] = DIRS[dir];
    const out = [];
    for (let k = 0; k < d; k++) out.push([i + dx * k, j + dz * k]);
    return out;
  }
  cells(m) { return this.cellsFor(m.type, m.i, m.j, m.dir); }

  /** 設備の中心（ワールド座標） */
  center(m) {
    const cs = this.cells(m);
    let x = 0, z = 0;
    for (const [i, j] of cs) { x += this.cx(i); z += this.cz(j); }
    return { x: x / cs.length, z: z / cs.length };
  }

  /** 出口のマス（向きの方向で、占有マスのすぐ先） */
  front(m) {
    const cs = this.cells(m);
    const [li, lj] = cs[cs.length - 1];
    const [dx, dz] = DIRS[m.dir];
    return [li + dx, lj + dz];
  }

  /** 発電機の周囲1マス（通路として空けておくマス） */
  ringFor(i, j) {
    const out = [];
    for (let a = -1; a <= 2; a++) for (let b = -1; b <= 2; b++) {
      if (a >= 0 && a <= 1 && b >= 0 && b <= 1) continue;
      out.push([i + a, j + b]);
    }
    return out;
  }

  cellBox(i, j) {
    const x = this.cx(i), z = this.cz(j), h = GRID.cell / 2;
    return { minX: x - h, maxX: x + h, minZ: z - h, maxZ: z + h };
  }

  _staticAt(i, j, margin = 0) {
    const b = this.cellBox(i, j);
    for (const o of this.staticBoxes) {
      if (b.minX < o.maxX + margin && b.maxX > o.minX - margin && b.minZ < o.maxZ + margin && b.maxZ > o.minZ - margin) return true;
    }
    return false;
  }

  _pileAt(i, j, limit = 0.03) {
    const pile = this.game.pile;
    for (const [ox, oz] of [[0, 0], [-0.24, -0.24], [0.24, -0.24], [-0.24, 0.24], [0.24, 0.24]]) {
      if (pile.heightAt(this.cx(i) + ox, this.cz(j) + oz) > limit) return true;
    }
    return false;
  }

  /** 設置できるか。ok=false のとき reason に理由 */
  canPlace(type, i, j, player = null, { ignoreMoney = false, dir = 0, ignore = null } = {}) {
    const def = MACHINES[type];
    if (!def) return { ok: false, reason: '不明な設備' };
    const cells = this.cellsFor(type, i, j, dir);
    for (const [a, b] of cells) {
      if (!this.inGrid(a, b) || this.isEdge(a, b)) return { ok: false, reason: '壁ぎわには置けない' };
      const o = this.get(a, b);
      if (o && o !== ignore) return { ok: false, reason: 'ほかの設備がある' };
      if (this._staticAt(a, b)) return { ok: false, reason: '作業場の設備と重なる' };
      if (this._pileAt(a, b)) return { ok: false, reason: 'しらすの山がある（掘れば置ける）' };
      if (this._inGeneratorRing(a, b, ignore)) return { ok: false, reason: '発電機のまわりは通路として空ける' };
      if (this._isPackerExit(a, b, ignore)) return { ok: false, reason: '包装機の出荷口なので空けておく' };
    }
    if (type === 'generator') {
      for (const [a, b] of this.ringFor(i, j)) {
        if (!this.inGrid(a, b) || this.isEdge(a, b)) return { ok: false, reason: '発電機のまわりに通路が取れない（壁が近い）' };
        const o = this.get(a, b);
        if ((o && o !== ignore) || this._staticAt(a, b) || this._pileAt(a, b)) return { ok: false, reason: '発電機のまわり1マスを空けて置く' };
      }
    }
    if (type === 'packer') {
      const [fi, fj] = this._frontOf(type, i, j, dir);
      if (!this.inGrid(fi, fj) || this.isEdge(fi, fj) || this._staticAt(fi, fj) || (this.get(fi, fj) && this.get(fi, fj) !== ignore)) {
        return { ok: false, reason: '包装機の正面（出荷口）のマスを空けておく' };
      }
    }
    if (def.blocks && player) {
      const r = 0.3;
      for (const [a, b] of cells) {
        const bx = this.cellBox(a, b);
        if (player.x > bx.minX - r && player.x < bx.maxX + r && player.z > bx.minZ - r && player.z < bx.maxZ + r) return { ok: false, reason: '自分が立っている' };
      }
    }
    if (type === 'crane') {
      const pile = this.game.pile;
      const d = Math.hypot(this.cx(i) - pile.cx, this.cz(j) - pile.cz);
      if (d > pile.radius + this.craneReach() - 0.6) return { ok: false, reason: '山から遠すぎる（クレーンの腕が届かない）' };
    }
    if (def.blocks && !this._pathsOk(cells, ignore, player)) return { ok: false, reason: '人の通路がふさがる（計量機・ケース・端末・山へ歩いて行けなくなる）' };
    if (!ignoreMoney && this.game.money < this.priceOf(type)) return { ok: false, reason: 'お金が足りない' };
    return { ok: true };
  }

  _frontOf(type, i, j, dir) {
    const cs = this.cellsFor(type, i, j, dir);
    const [li, lj] = cs[cs.length - 1];
    const [dx, dz] = DIRS[dir];
    return [li + dx, lj + dz];
  }

  _isPackerExit(a, b, ignore) {
    for (const m of this.machines.values()) {
      if (m.type !== 'packer' || m === ignore) continue;
      const [fi, fj] = this.front(m);
      if (fi === a && fj === b) return true;
    }
    return false;
  }

  _inGeneratorRing(a, b, ignore) {
    for (const m of this.machines.values()) {
      if (m.type !== 'generator' || m === ignore) continue;
      if (a >= m.i - 1 && a <= m.i + 2 && b >= m.j - 1 && b <= m.j + 2) return true;
    }
    return false;
  }

  // ===== 人の通路（歩いて主要な場所へ行けるか） =====
  _walkable(i, j, extraBlocked, ignore) {
    if (!this.inGrid(i, j) || this.isEdge(i, j)) return false;
    if (extraBlocked.has(this.key(i, j))) return false;
    const m = this.get(i, j);
    if (m && m !== ignore && MACHINES[m.type].blocks) return false;
    if (this._staticAt(i, j)) return false;
    const pile = this.game.pile;
    if (pile.heightAt(this.cx(i), this.cz(j)) > PILE_BLOCK_HEIGHT) return false;
    return true;
  }

  /** 歩ける範囲の連結成分を調べ、重要な場所すべてに行けるか */
  _pathsOk(newCells, ignore = null, player = null) {
    const extra = new Set(newCells.map(([a, b]) => this.key(a, b)));
    const goals = this._goalCells();
    let start = null;
    if (player) {
      const [pi, pj] = this.cellOf(player.x, player.z);
      if (this._walkable(pi, pj, extra, ignore)) start = [pi, pj];
    }
    const groups = goals.map((g) => g.filter(([a, b]) => this._walkable(a, b, extra, ignore)));
    if (groups.some((g) => !g.length)) return false;
    if (!start) start = groups[0][0];
    const seen = new Uint8Array(this.cols * this.rows);
    const q = [start];
    seen[start[1] * this.cols + start[0]] = 1;
    while (q.length) {
      const [a, b] = q.pop();
      for (const [dx, dz] of DIRS) {
        const na = a + dx, nb = b + dz;
        if (!this.inGrid(na, nb) || seen[nb * this.cols + na]) continue;
        if (!this._walkable(na, nb, extra, ignore)) continue;
        seen[nb * this.cols + na] = 1;
        q.push([na, nb]);
      }
    }
    return groups.every((g) => g.some(([a, b]) => seen[b * this.cols + a]));
  }

  /** 計量機・棚・ケース・端末・受電盤のまわりのマス、山の裾のマス */
  _goalCells() {
    if (this._goalsV === this.version && this._goals) return this._goals;
    const groups = [];
    for (const o of this.staticBoxes) {
      const g = [];
      for (let i = 1; i < this.cols - 1; i++) for (let j = 1; j < this.rows - 1; j++) {
        if (this._staticAt(i, j)) continue;
        if (this._staticAt(i, j, 0.5) && this._nearBox(i, j, o)) g.push([i, j]);
      }
      groups.push(g);
    }
    const pile = this.game.pile;
    const edge = [];
    for (let i = 1; i < this.cols - 1; i++) for (let j = 1; j < this.rows - 1; j++) {
      const d = Math.hypot(this.cx(i) - pile.cx, this.cz(j) - pile.cz);
      if (d > pile.radius - 0.2 && d < pile.radius + 0.8) edge.push([i, j]);
    }
    groups.push(edge);
    this._goals = groups;
    this._goalsV = this.version;
    return groups;
  }

  _nearBox(i, j, o) {
    const b = this.cellBox(i, j), m = 0.5;
    return b.minX < o.maxX + m && b.maxX > o.minX - m && b.minZ < o.maxZ + m && b.maxZ > o.minZ - m;
  }

  // ===== 設置・撤去 =====
  place(type, i, j, dir, player = null) {
    const can = this.canPlace(type, i, j, player, { dir });
    if (!can.ok) return can;
    const def = MACHINES[type];
    const paid = this.priceOf(type);
    this.game.money -= paid;
    const m = {
      id: this.nextId++, type, i, j, dir: dir & 3, on: true, prio: def.prio ?? 1, paid,
      batches: [], buffer: [], bin: [], timer: 0, phase: 'idle', t: 0, tx: 0, tz: 0, holding: [], packs: 0, power: 0,
    };
    this._occupy(m);
    this.version++;
    this.game.emit('changed');
    return { ok: true, machine: m };
  }

  _occupy(m) {
    this.machines.set(m.id, m);
    for (const [a, b] of this.cells(m)) this.occ.set(this.key(a, b), m);
  }

  _unoccupy(m) {
    for (const [a, b] of this.cells(m)) this.occ.delete(this.key(a, b));
    this.machines.delete(m.id);
  }

  /** 撤去。中身は床に落とし、代金の半分（クレーンは全額）が戻る */
  remove(i, j) {
    const m = this.get(i, j);
    if (!m) return false;
    const ids = this.contents(m);
    const c = this.center(m);
    if (ids.length) this.game.dropIdsToFloor(ids, c);
    this._unoccupy(m);
    this.game.money += this.refundOf(m);
    this.version++;
    this.game.emit('changed');
    return true;
  }

  /** 向きを変える（複数マスの設備は置き直せるときだけ） */
  rotate(i, j, d = 1) {
    const m = this.get(i, j);
    if (!m) return { ok: false };
    const nd = (m.dir + d + 4) & 3;
    if (MACHINES[m.type].size[1] > 1) {
      const can = this.canPlace(m.type, m.i, m.j, null, { ignoreMoney: true, dir: nd, ignore: m });
      if (!can.ok) return can;
      this._unoccupy(m);
      m.dir = nd;
      this._occupy(m);
    } else m.dir = nd;
    this.version++;
    return { ok: true };
  }

  /** いまの値段（台数で上がる設備は、持っている台数に応じて） */
  priceOf(type) {
    const def = MACHINES[type];
    if (!def.priceGrowth) return def.price;
    let n = 0;
    for (const m of this.machines.values()) if (m.type === type) n++;
    return Math.round(def.price * def.priceGrowth ** n / 100) * 100;
  }

  /** 撤去で戻る金額 */
  refundOf(m) {
    const def = MACHINES[m.type];
    return Math.floor((m.paid ?? def.price) * (def.refund ?? 0.5));
  }

  // 工場の改良を反映した値
  craneReach() { return this.game.upgradeValue('craneReach', MACHINES.crane.reach); }
  craneCycle() { return this.game.upgradeValue('craneCycle', MACHINES.crane.cycle); }
  craneGrab() { return this.game.upgradeValue('craneGrab', MACHINES.crane.grab); }
  packInterval() { return this.game.upgradeValue('packInterval', BELT.packInterval); }

  /** 消費電力（届く範囲にしらすがないクレーンは待機電力だけ） */
  demandOf(m) {
    const p = MACHINES[m.type].power;
    if (m.type === 'crane') return m.starved ? CRANE_STANDBY_KW : p;
    // 空で何も運んでいない設備は待機電力（1/5）だけ
    const idle = m.type === 'conveyor' ? !m.batches.length
      : m.type === 'packer' ? m.buffer.length < PACK_SIZE : !m.buffer.length; // 包装機は20匹たまるまで待機
    return idle ? p * 0.2 : p;
  }

  /** クレーンをここに置いたとき、届く範囲に残っている匹数 */
  reachCount(i, j) {
    const pile = this.game.pile;
    let n = 0;
    for (const c of pile.colsInRadius(this.cx(i), this.cz(j), this.craneReach())) n += pile.remaining(c);
    return n;
  }

  cyclePrio(m) { m.prio = (m.prio + 2) % 3; this.version++; }

  toggle(m) { m.on = !m.on; this.version++; this.game.emit('machineToggle', { machine: m }); }

  contents(m) {
    const ids = [];
    for (const b of m.batches) ids.push(...b.ids);
    ids.push(...m.buffer, ...m.holding, ...m.bin);
    return ids;
  }

  count() {
    let n = 0;
    for (const m of this.machines.values()) {
      for (const b of m.batches) n += b.ids.length;
      n += m.buffer.length + m.holding.length + m.bin.length;
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
    for (const m of this.machines.values()) {
      if (!MACHINES[m.type].blocks) continue;
      // マスより少し内側を当たり判定にする（設備の間の1マスの通路を、人が実際に通れるように）
      for (const [a, b] of this.cells(m)) {
        const c = this.cellBox(a, b);
        out.push({ minX: c.minX + 0.1, maxX: c.maxX - 0.1, minZ: c.minZ + 0.1, maxZ: c.maxZ - 0.1 });
      }
    }
    return out;
  }

  // ===== 受け渡し =====
  _batch(ids) {
    const pile = this.game.pile;
    return { ids, pos: 0, chiri: ids.filter((id) => pile.isChirimon(id)) };
  }

  /**
   * 設備 m がマス (i,j) で、進行方向 travel から来たバッチを受け取れるか試す。
   * 入口の決まり：コンベア＝正面以外から / ホッパー＝どこからでも / 包装機・選別機＝後ろの面から
   */
  accept(m, ids, travel = null, i = m.i, j = m.j) {
    if (!m || !ids.length) return false;
    if (m.type === 'conveyor') {
      if (travel != null && travel === ((m.dir + 2) & 3)) return false; // 正面衝突
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
    if (m.type === 'packer' || m.type === 'sorter') {
      if (travel != null && (travel !== m.dir || i !== m.i || j !== m.j)) return false; // 後ろの面からだけ
      if (m.buffer.length >= MACHINES[m.type].capacity) return false;
      m.buffer.push(...ids);
      return true;
    }
    return false;
  }

  /** マス (i,j) へ届ける。設備か計量機があれば受け取る */
  deliver(i, j, ids, travel = null) {
    const m = this.get(i, j);
    if (m) return this.accept(m, ids, travel, i, j);
    if (this.isScaleCell(i, j)) {
      this.game.factoryToScale(ids);
      return true;
    }
    return false;
  }

  /** 出口の先に受け取り手がいるか（建設画面の警告用） */
  outputTarget(m) {
    const [fi, fj] = this.front(m);
    const t = this.get(fi, fj);
    if (t) {
      if (t.type === 'conveyor') return t.dir !== ((m.dir + 2) & 3);
      if (t.type === 'hopper') return true;
      if (t.type === 'packer' || t.type === 'sorter') return t.dir === m.dir && fi === t.i && fj === t.j;
      return false;
    }
    return this.isScaleCell(fi, fj);
  }

  /** マスが計量機の本体に重なっているか */
  isScaleCell(i, j) {
    const b = this.cellBox(i, j);
    return b.minX < SCALE_BOX.maxX && b.maxX > SCALE_BOX.minX && b.minZ < SCALE_BOX.maxZ && b.maxZ > SCALE_BOX.minZ;
  }

  /** 設備の問題点（建設画面・照準表示用） */
  issues(m) {
    const out = [];
    if (CONSUMERS.has(m.type)) {
      if (m.net == null) out.push('電源なし');
      else if (m.on && m.power < 0.999) out.push(m.power <= 0 ? '電力不足で停止' : `電力不足で減速（${Math.round(m.power * 100)}%）`);
    }
    if (['conveyor', 'hopper', 'crane', 'sorter'].includes(m.type) && !this.outputTarget(m)) out.push('出口の先に受け取る設備がない');
    if (m.type === 'packer') {
      const [fi, fj] = this.front(m);
      if (this.get(fi, fj) || this._staticAt(fi, fj)) out.push('出荷口がふさがれている');
    }
    if (m.type === 'sorter' && m.bin.length >= MACHINES.sorter.bin) out.push('回収箱がいっぱい（ちりモンを取り出して）');
    if (m.type === 'crane' && m.on && m.starved) out.push('届く範囲にしらすがない（撤去すると全額戻るので、山の別の場所へ移そう）');
    if (m.type === 'packer' && m.buffer.length >= MACHINES.packer.capacity * 0.9) out.push('包装が追いつかない（包装機を増やす／高速包装機）');
    if (m.type === 'generator' && m.on && this.fuelDebt >= 1 && this.game.money < 1) out.push(`燃料費を後払い中（${Math.floor(this.fuelDebt)}円）`);
    if (!m.on) out.push('停止中');
    return out;
  }

  /** 手から入れる（入った数を返す） */
  insertFromHand(m, ids) {
    if (!CONSUMERS.has(m.type) || m.type === 'crane') return 0;
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
    takeChiri(m.bin);
    for (const b of m.batches) { takeChiri(b.ids); b.chiri = b.ids.filter((id) => pile.isChirimon(id)); }
    takeChiri(m.buffer);
    takeChiri(m.holding);
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

  // ===== 電力（3.3） =====
  /** 電力網の構成（配置が変わったときだけ作り直す） */
  _buildNets() {
    this.netVersion = this.version;
    const nodes = [{ panel: true, x: POWER_PANEL.x, z: POWER_PANEL.z, cov: POWER_PANEL.coverage, link: POWER_PANEL.link }];
    for (const m of this.machines.values()) {
      if (m.type !== 'generator' && m.type !== 'pole') continue;
      const c = this.center(m), def = MACHINES[m.type];
      nodes.push({ m, x: c.x, z: c.z, cov: def.coverage, link: def.link });
    }
    // つながり（どちらかの電線が届く距離）
    const parent = nodes.map((_, k) => k);
    const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    const links = [];
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
      if (d <= Math.max(nodes[a].link, nodes[b].link)) { parent[find(a)] = find(b); links.push([nodes[a], nodes[b]]); }
    }
    const nets = new Map();
    nodes.forEach((n, k) => {
      const r = find(k);
      if (!nets.has(r)) nets.set(r, { id: nets.size, nodes: [], consumers: [], panel: false, gens: [] });
      const net = nets.get(r);
      net.nodes.push(n);
      if (n.panel) net.panel = true;
      if (n.m && n.m.type === 'generator') net.gens.push(n.m);
      if (n.m) n.m.net = net.id;
    });
    this.nets = [...nets.values()];
    this.links = links;
    for (const m of this.machines.values()) {
      if (!CONSUMERS.has(m.type)) continue;
      m.net = null;
      const c = this.center(m);
      for (const net of this.nets) {
        if (net.nodes.some((n) => Math.hypot(n.x - c.x, n.z - c.z) <= n.cov)) { m.net = net.id; net.consumers.push(m); break; }
      }
      if (m.net == null) m.power = 0;
    }
  }

  /** 供給と需要を配分する。優先度の高い設備から満たし、足りない分は減速・停止 */
  _allocate(dt) {
    if (this.netVersion !== this.version) this._buildNets();
    const game = this.game;
    let fuel = 0;
    for (const net of this.nets) {
      // 燃料費は後払いできる（所持金が0でも発電機は動き、売上から払う）
      const genAvail = net.gens.filter((g) => g.on);
      const panelOut = net.panel ? POWER_PANEL.output : 0;
      const genOut = genAvail.length * MACHINES.generator.output;
      const supply = panelOut + genOut;
      // 優先度の高い順に配る。足りなくなった優先度の設備は、同じ割合でそろって減速する
      // （1台だけ止まってラインが詰まることがないように）。それより低い優先度は停止
      const list = net.consumers.filter((m) => m.on);
      let remain = supply, demand = 0;
      for (const prio of [2, 1, 0]) {
        const tier = list.filter((m) => (m.prio ?? 1) === prio);
        if (!tier.length) continue;
        const need = tier.reduce((a, m) => a + this.demandOf(m), 0);
        demand += need;
        const ratio = need <= remain + 1e-9 ? 1 : Math.max(0, remain / need);
        for (const m of tier) m.power = ratio;
        remain = Math.max(0, remain - need * ratio);
      }
      for (const m of net.consumers) if (!m.on) m.power = 0;
      const load = supply - remain;
      const genLoad = Math.max(0, load - panelOut);
      for (const g of net.gens) g.load = genAvail.includes(g) ? genLoad / Math.max(1, genAvail.length) : 0;
      net.supply = supply; net.demand = demand; net.load = load;
      fuel += genLoad * MACHINES.generator.fuelCost * dt;
    }
    if (fuel > 0) {
      // 燃料費は 1円 たまるごとに払う（所持金を整数のまま保つ）
      this.fuelDebt = (this.fuelDebt || 0) + fuel;
    }
    // 1円 たまるごとに、払える分だけ払う（払えない分は次の売上から）
    const pay = Math.min(Math.floor(this.fuelDebt || 0), Math.floor(game.money));
    if (pay > 0) {
      this.fuelDebt -= pay;
      game.money -= pay;
      game.stats.fuel = (game.stats.fuel || 0) + pay;
    }
  }

  /** HUD 用の電力まとめ */
  powerSummary() {
    this._allocate(0); // 一時停止中でも最新の配置で計算（燃料は消費しない）
    let supply = 0, demand = 0, short = false, unpowered = 0;
    for (const n of this.nets) { supply += n.supply || 0; demand += n.demand || 0; if ((n.demand || 0) > (n.supply || 0) + 1e-9) short = true; }
    for (const m of this.machines.values()) if (CONSUMERS.has(m.type) && m.net == null) unpowered++;
    return { supply, demand, short, unpowered };
  }

  // ===== 時間経過 =====
  tick(dt) {
    this.game.pile.settle(); // 崩れ（1フレームに動かす数には上限がある）
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this._step(STEP);
    }
  }

  _step(dt) {
    this._allocate(dt);
    for (const m of this.machines.values()) {
      if (!m.on || !CONSUMERS.has(m.type) || m.power <= 0) continue;
      const d = dt * m.power; // 電力が足りないと遅くなる
      if (m.type === 'conveyor') this._belt(m, d);
      else if (m.type === 'hopper') this._hopper(m, d);
      else if (m.type === 'packer') this._packer(m, d);
      else if (m.type === 'crane') this._crane(m, d);
      else if (m.type === 'sorter') this._sorter(m, d);
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
      if (this.deliver(ni, nj, b[0].ids, m.dir)) b.shift();
    }
  }

  _hopper(m, dt) {
    m.timer -= dt;
    if (m.timer > 0 || !m.buffer.length) return;
    m.timer = Math.max(m.timer, -dt) + BELT.hopperInterval; // 端数は次へ持ち越す（刻み幅で遅くならない）
    const batch = m.buffer.slice(0, BELT.hopperBatch);
    const [ni, nj] = this.front(m);
    if (this.deliver(ni, nj, batch, m.dir)) m.buffer.splice(0, batch.length);
  }

  _packer(m, dt) {
    m.timer -= dt;
    if (m.timer > 0 || m.buffer.length < PACK_SIZE) return;
    const [fi, fj] = this.front(m);
    if (this.get(fi, fj) || this._staticAt(fi, fj)) return; // 出荷口がふさがれている
    m.timer = Math.max(m.timer, -dt) + this.packInterval();
    this.game.shipPack(m.buffer.splice(0, PACK_SIZE), 'packer');
    m.packs++;
  }

  /** 選別機：ちりモンを検出率に応じて回収箱へ。しらすは前へ */
  _sorter(m, dt) {
    const def = MACHINES.sorter;
    m.timer -= dt;
    if (m.timer > 0 || !m.buffer.length) return;
    if (m.bin.length >= def.bin) return; // 回収箱がいっぱいなら止まる
    m.timer = Math.max(m.timer, -dt) + def.interval;
    const pile = this.game.pile;
    const batch = m.buffer.splice(0, BELT.hopperBatch);
    const pass = [];
    let caught = 0;
    for (const id of batch) {
      if (pile.isChirimon(id) && m.bin.length < def.bin && hash01(pile.seed, id, 91) < def.detect) { m.bin.push(id); caught++; }
      else pass.push(id);
    }
    if (caught) this.game.emit('sorterCaught', { count: caught });
    if (pass.length) {
      const [ni, nj] = this.front(m);
      if (!this.deliver(ni, nj, pass, m.dir)) { m.buffer.unshift(...pass); m.timer = 0.1; }
    }
  }

  /** クレーン：待機 → 腕を伸ばす → つかむ → 戻す → 降ろす */
  _crane(m, dt) {
    const cycle = this.craneCycle();
    m.t += dt;
    const x = this.cx(m.i), z = this.cz(m.j);
    if (m.phase === 'idle') {
      if (m.t < 0.4) return;
      const target = this._craneTarget(x, z, this.craneReach());
      // 届く範囲が空なら待機（消費電力を下げ、建設画面で知らせる）。しばらくしてから探し直す
      if (!target) { m.starved = true; m.t = -1.6; return; }
      m.starved = false;
      m.tx = target.x; m.tz = target.z;
      m.phase = 'out'; m.t = 0;
    } else if (m.phase === 'out' && m.t >= cycle * 0.35) {
      m.phase = 'grab'; m.t = 0;
    } else if (m.phase === 'grab' && m.t >= cycle * 0.12) {
      m.holding = this.game.machineGrab(m.tx, m.tz, 0.2, this.craneGrab());
      m.phase = 'back'; m.t = 0;
    } else if (m.phase === 'back' && m.t >= cycle * 0.35) {
      m.phase = 'drop'; m.t = 0;
    } else if (m.phase === 'drop' && m.t >= cycle * 0.18) {
      const [ni, nj] = this.front(m);
      if (!m.holding.length || this.deliver(ni, nj, m.holding, m.dir)) {
        m.holding = [];
        m.phase = 'idle'; m.t = 0;
      } else {
        m.t = cycle * 0.18 - 0.3;
      }
    }
  }

  _craneTarget(x, z, reach) {
    const pile = this.game.pile;
    // 残っている個体があれば低い柱もつかむ（山を最後まで片付けられるように）
    let best = null, bh = -Infinity;
    for (const c of pile.colsInRadius(x, z, reach)) {
      if (!pile.hasAny(c)) continue;
      const h = pile.topH[c];
      if (h > bh) { bh = h; best = c; }
    }
    if (best == null) return null;
    return { x: pile.colCenterX(best), z: pile.colCenterZ(best), h: bh };
  }

  /** クレーンの腕の先の位置（描画用） */
  craneArm(m) {
    const x = this.cx(m.i), z = this.cz(m.j);
    const [dx, dz] = DIRS[m.dir];
    const home = { x: x + dx * 0.5, z: z + dz * 0.5 };
    const tgt = { x: m.tx || home.x, z: m.tz || home.z };
    const th = this.game.pile.heightAt(tgt.x, tgt.z);
    const ease = (t) => t * t * (3 - 2 * t);
    let p = 0, drop = 0;
    if (m.phase === 'out') p = ease(Math.min(1, m.t / (this.craneCycle() * 0.35)));
    else if (m.phase === 'grab') { p = 1; drop = Math.sin(Math.min(1, m.t / (this.craneCycle() * 0.12)) * Math.PI); }
    else if (m.phase === 'back') p = 1 - ease(Math.min(1, m.t / (this.craneCycle() * 0.35)));
    let y = 2.2;
    if (m.phase === 'grab') y = 2.2 + (th + 0.06 - 2.2) * drop;
    else if (m.phase === 'drop') y = 1.45;
    return { x: home.x + (tgt.x - home.x) * p, z: home.z + (tgt.z - home.z) * p, y, holding: m.holding.length };
  }

  // ===== 新しい山・保存 =====
  clearContents() {
    for (const m of this.machines.values()) { m.batches = []; m.buffer = []; m.holding = []; m.bin = []; m.phase = 'idle'; m.t = 0; }
    this.version++;
  }

  toJSON() {
    return {
      nextId: this.nextId,
      machines: [...this.machines.values()].map((m) => ({
        id: m.id, type: m.type, i: m.i, j: m.j, dir: m.dir, on: m.on, prio: m.prio,
        batches: m.batches.map((b) => ({ ids: b.ids, pos: b.pos })), buffer: m.buffer, holding: m.holding, bin: m.bin,
        timer: m.timer, phase: m.phase, t: m.t, tx: m.tx, tz: m.tz, packs: m.packs, paid: m.paid,
      })),
      fuelDebt: this.fuelDebt || 0,
    };
  }

  _load(s) {
    this.nextId = s.nextId || 1;
    this.fuelDebt = s.fuelDebt || 0;
    const pile = this.game.pile;
    const list = [...(s.machines || [])].sort((x, y) => (MACHINES[x.type].size[1] > 1 || x.type === 'generator' ? 1 : 0) - (MACHINES[y.type].size[1] > 1 || y.type === 'generator' ? 1 : 0));
    for (const d of list) {
      const m = { timer: 0, phase: 'idle', t: 0, tx: 0, tz: 0, packs: 0, power: 0, ...d };
      // セーブの配列をコピーする（復元中に元データを書き換えないため）
      m.buffer = [...(d.buffer || [])]; m.holding = [...(d.holding || [])]; m.bin = [...(d.bin || [])];
      if (m.prio == null) m.prio = MACHINES[m.type].prio ?? 1;
      m.batches = (d.batches || []).map((b) => ({ ids: [...b.ids], pos: b.pos, chiri: b.ids.filter((id) => pile.isChirimon(id)) }));
      if (!m.id) m.id = this.nextId++;
      // 旧版（P3）の包装機は1マスだった。2マス目が埋まっていたら撤去して全額返す
      if (this.cells(m).some(([a, b2]) => this.get(a, b2) || !this.inGrid(a, b2))) {
        this.game.dropIdsToFloor(this.contents(m), { x: this.cx(m.i), z: this.cz(m.j) });
        this.game.money += MACHINES[m.type].price;
        this.loadNotes = this.loadNotes || [];
        this.loadNotes.push(`${MACHINES[m.type].name}が新しい大きさ（2マス）で置けないため撤去し、代金を返しました`);
        continue;
      }
      this._occupy(m);
    }
  }
}
