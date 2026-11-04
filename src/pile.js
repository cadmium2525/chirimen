// しらすの山の実体モデル（企画書 4章）
//
// - 10,000,000匹それぞれが固有ID（0 .. total-1）を持つ。
// - 山は cell×cell の「柱（チャンク）」に分割。柱 c は ID 範囲 [start[c], start[c+1]) を持ち、
//   柱の中では k=0 が一番上、k が大きいほど深い。
// - 各個体の座標・回転・形状バリエーションは (seed, id) から毎回再計算する（Meshは作らない）。
// - 除去状態は 1個体1ビットのビットセット（1,000万ビット ≒ 1.25MB）。
// - 各柱の「現在の一番上」は top[c]（除去済みでない最初の k）で、ビットセットから再現できる。
//
// three.js に依存しない純粋なモジュール（テスト可能）。

import { hash01, mulberry32 } from './rng.js';
import { PILE, TOTAL_FISH, EXPOSE_DEPTH } from './config.js';
import { SPECIES } from './chirimonData.js';

const TAU = Math.PI * 2;

export class PileModel {
  /**
   * @param {number} seed ワールドシード
   * @param {object} [opts]
   * @param {number} [opts.total]
   * @param {Uint32Array|ArrayBuffer} [opts.removed] 復元するビットセット
   */
  constructor(seed, opts = {}) {
    this.seed = seed >>> 0;
    this.total = opts.total ?? TOTAL_FISH;
    const { cx, cz, radius, height, cell } = { ...PILE, ...(opts.shape || {}) };
    this.cx = cx; this.cz = cz; this.radius = radius; this.height = height; this.cell = cell;
    this.G = Math.ceil((radius * 2) / cell);
    this.x0 = cx - (this.G * cell) / 2;
    this.z0 = cz - (this.G * cell) / 2;
    const nCols = this.G * this.G;
    this.nCols = nCols;

    // --- 柱ごとの初期高さ（シードで少しずつ形が変わる）
    const rng = mulberry32(this.seed ^ 0xa5a5a5a5);
    const bumps = [];
    for (let i = 0; i < 5; i++) {
      bumps.push({ a: rng() * TAU, f: 1 + Math.floor(rng() * 4), amp: 0.03 + rng() * 0.05 });
    }
    const h0 = new Float32Array(nCols);
    let sum = 0;
    for (let iz = 0; iz < this.G; iz++) {
      for (let ix = 0; ix < this.G; ix++) {
        const x = this.x0 + (ix + 0.5) * cell - cx;
        const z = this.z0 + (iz + 0.5) * cell - cz;
        const ang = Math.atan2(z, x);
        let wobble = 1;
        for (const b of bumps) wobble += b.amp * Math.sin(b.f * ang + b.a);
        const r = Math.hypot(x, z) / (radius * Math.min(1.05, wobble));
        let h = 0;
        if (r < 1) h = height * Math.pow(0.5 + 0.5 * Math.cos(Math.PI * r), 0.85);
        if (h < 0.004) h = 0;
        h0[iz * this.G + ix] = h;
        sum += h;
      }
    }
    this.h0 = h0;

    // --- 柱ごとの個体数（体積比例）と ID 範囲。合計がちょうど total になる。
    const start = new Uint32Array(nCols + 1);
    let acc = 0;
    for (let c = 0; c < nCols; c++) {
      start[c] = Math.floor((this.total * acc) / sum);
      acc += h0[c];
    }
    start[nCols] = this.total;
    this.start = start;

    // --- 状態
    this.words = Math.ceil(this.total / 32);
    if (opts.removed) {
      const src = opts.removed instanceof Uint32Array ? opts.removed : new Uint32Array(opts.removed);
      if (src.length !== this.words) throw new Error('bitset size mismatch');
      this.removed = new Uint32Array(src); // コピー
    } else {
      this.removed = new Uint32Array(this.words);
    }
    this.top = new Uint32Array(nCols);
    this.topH = new Float32Array(nCols);
    this.removedCount = 0;
    for (let c = 0; c < nCols; c++) this._recomputeTop(c);
    for (let w = 0; w < this.words; w++) this.removedCount += popcount(this.removed[w]);

    // --- ちりモンの配置（開始時から決まっている）
    this._placeChirimon();

    this.version = 0; // 変更のたびに増える（描画側のキャッシュ判定用）
    this.dirtyCols = new Set();
  }

  // ===== 個体ID ⇔ 柱 =====
  count(c) { return this.start[c + 1] - this.start[c]; }

  columnOf(id) {
    let lo = 0, hi = this.nCols - 1;
    const s = this.start;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= id) lo = mid; else hi = mid - 1;
    }
    // 個体数0の柱は start が同じなので、id を含む最後の柱を返す
    return lo;
  }

  colIndex(ix, iz) { return iz * this.G + ix; }
  colCenterX(c) { return this.x0 + ((c % this.G) + 0.5) * this.cell; }
  colCenterZ(c) { return this.z0 + (Math.floor(c / this.G) + 0.5) * this.cell; }

  // ===== 個体ごとの決定論的プロパティ =====
  /** 柱 c の k 番目（id = start[c]+k）の高さ */
  yAt(c, k) {
    const n = this.count(c);
    const id = this.start[c] + k;
    const j = hash01(this.seed, id, 1) - 0.5;
    return this.h0[c] * (1 - (k + 0.5 + j * 0.9) / n);
  }

  /** 個体の位置・姿勢・形状を out に書き込む（再生成） */
  fishTransform(id, out = {}) {
    const c = out.c ?? this.columnOf(id);
    const k = id - this.start[c];
    const cell = this.cell;
    out.x = this.x0 + ((c % this.G) + hash01(this.seed, id, 2)) * cell;
    out.z = this.z0 + (Math.floor(c / this.G) + hash01(this.seed, id, 3)) * cell;
    out.y = this.yAt(c, k);
    out.yaw = hash01(this.seed, id, 4) * TAU;
    out.tilt = (hash01(this.seed, id, 5) - 0.5) * 0.5;
    out.roll = (hash01(this.seed, id, 6) - 0.5) * 0.6;
    out.scale = 0.85 + hash01(this.seed, id, 7) * 0.3;
    out.tint = hash01(this.seed, id, 8);
    out.c = undefined;
    return out;
  }

  /**
   * 描画・照準用の位置。表面メッシュは柱の中心を補間しているので、
   * 「自分の柱の表面からの深さ」を補間面に足した高さで表示する（描画上の沈降補正。実体IDは動かさない）。
   */
  visualTransform(id, out = {}) {
    const c = out.c ?? this.columnOf(id);
    this.fishTransform(id, out);
    out.y = this.heightAt(out.x, out.z) - (this.topH[c] - out.y);
    return out;
  }

  // ===== 除去状態 =====
  isRemoved(id) { return (this.removed[id >>> 5] >>> (id & 31)) & 1; }

  /** 個体を山から取り除く（出荷・保持などの行き先はゲーム側が管理） */
  remove(id) {
    if (id < 0 || id >= this.total || this.isRemoved(id)) return false;
    this.removed[id >>> 5] |= 1 << (id & 31);
    this.removedCount++;
    const c = this.columnOf(id);
    if (id - this.start[c] === this.top[c]) this._recomputeTop(c);
    this.version++;
    this.dirtyCols.add(c);
    return true;
  }

  _recomputeTop(c) {
    const s = this.start[c], n = this.count(c);
    let k = this.top[c];
    while (k < n) {
      const id = s + k;
      const w = this.removed[id >>> 5];
      if (w === 0xffffffff && (id & 31) === 0 && k + 32 <= n) { k += 32; continue; }
      if (!((w >>> (id & 31)) & 1)) break;
      k++;
    }
    this.top[c] = k;
    this.topH[c] = k < n ? this.yAt(c, k) : 0;
  }

  /** 柱 c の現在の表面高さ */
  surfaceH(c) { return this.topH[c]; }

  /** (x,z) の表面高さ（柱の中心を頂点とした双線形補間） */
  heightAt(x, z) {
    const fx = (x - this.x0) / this.cell - 0.5;
    const fz = (z - this.z0) / this.cell - 0.5;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h00 = this._hIdx(ix, iz), h10 = this._hIdx(ix + 1, iz);
    const h01 = this._hIdx(ix, iz + 1), h11 = this._hIdx(ix + 1, iz + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  _hIdx(ix, iz) {
    if (ix < 0 || iz < 0 || ix >= this.G || iz >= this.G) return 0;
    return this.topH[iz * this.G + ix];
  }

  /** 位置 (x,z) を含む柱。範囲外なら -1 */
  colAt(x, z) {
    const ix = Math.floor((x - this.x0) / this.cell);
    const iz = Math.floor((z - this.z0) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.G || iz >= this.G) return -1;
    return iz * this.G + ix;
  }

  /** (x,z) から半径 r 以内に中心がある柱の一覧 */
  colsInRadius(x, z, r) {
    const out = [];
    const ix0 = Math.max(0, Math.floor((x - r - this.x0) / this.cell));
    const ix1 = Math.min(this.G - 1, Math.floor((x + r - this.x0) / this.cell));
    const iz0 = Math.max(0, Math.floor((z - r - this.z0) / this.cell));
    const iz1 = Math.min(this.G - 1, Math.floor((z + r - this.z0) / this.cell));
    const rr = (r + this.cell * 0.5) ** 2;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const c = iz * this.G + ix;
        const dx = this.colCenterX(c) - x, dz = this.colCenterZ(c) - z;
        if (dx * dx + dz * dz <= rr && this.count(c) > 0) out.push(c);
      }
    }
    return out;
  }

  /**
   * 柱 c で露出している個体を（上から順に）列挙する。
   * 露出 = 未除去 かつ 表面から EXPOSE_DEPTH 以内。
   */
  forEachExposed(c, fn, maxN = 80, depth = EXPOSE_DEPTH) {
    const n = this.count(c), s = this.start[c];
    const top = this.topH[c];
    let found = 0;
    for (let k = this.top[c]; k < n && found < maxN; k++) {
      const id = s + k;
      if (this.isRemoved(id)) continue;
      const y = this.yAt(c, k);
      if (y < top - depth) break;
      found++;
      if (fn(id, y, k) === false) break;
    }
  }

  isExposed(id) {
    if (this.isRemoved(id)) return false;
    const c = this.columnOf(id);
    return this.yAt(c, id - this.start[c]) >= this.topH[c] - EXPOSE_DEPTH;
  }

  /**
   * 半径 r 内の柱から、最も高い位置にある個体から順に最大 maxCount 個を取り除いて返す。
   * （手袋・スコップでまとめて回収するときの「表面を削る」処理）
   */
  scrape(x, z, r, maxCount) {
    const cols = this.colsInRadius(x, z, r);
    const taken = [];
    if (!cols.length) return taken;
    while (taken.length < maxCount) {
      let best = -1, bestH = -1;
      for (const c of cols) {
        if (this.top[c] < this.count(c) && this.topH[c] > bestH) { bestH = this.topH[c]; best = c; }
      }
      if (best < 0) break;
      const id = this.start[best] + this.top[best];
      this.remove(id);
      taken.push(id);
    }
    return taken;
  }

  // ===== ちりモン =====
  _placeChirimon() {
    const rng = mulberry32(this.seed ^ 0x5eed1234);
    this.chiri = new Map();      // id -> species index
    this.chiriByCol = new Map(); // c -> [id]
    this.chiriList = [];
    const used = new Set();
    let guaranteedShallow = 3;   // 始めから見つけやすい位置に数匹
    SPECIES.forEach((sp, si) => {
      const n = Math.max(1, Math.round(sp.base + (rng() * 2 - 1) * sp.spread));
      for (let i = 0; i < n; i++) {
        for (let tries = 0; tries < 50; tries++) {
          // 体積に比例して柱を選ぶ（全IDから一様に1つ選び、その柱を使う）
          const g = Math.floor(rng() * this.total);
          const c = this.columnOf(g);
          const cnt = this.count(c);
          if (cnt < 4) continue;
          let k;
          const shallow = guaranteedShallow > 0 && si < 2 && this._reachableCol(c);
          if (shallow) { k = Math.floor(rng() * 6); guaranteedShallow--; }
          else k = Math.floor(cnt * Math.pow(rng(), 2.6)); // 浅めに偏るが、深くにも埋まる
          const id = this.start[c] + Math.min(k, cnt - 1);
          if (used.has(id)) continue;
          used.add(id);
          this.chiri.set(id, si);
          this.chiriList.push({ id, species: si });
          if (!this.chiriByCol.has(c)) this.chiriByCol.set(c, []);
          this.chiriByCol.get(c).push(id);
          break;
        }
      }
    });
    this.chiriList.sort((a, b) => a.id - b.id);
  }

  _reachableCol(c) {
    const dx = this.colCenterX(c) - this.cx, dz = this.colCenterZ(c) - this.cz;
    const r = Math.hypot(dx, dz) / this.radius;
    return r > 0.62 && r < 0.9 && dx > 0; // 計量機側の斜面
  }

  isChirimon(id) { return this.chiri.has(id); }
  speciesOf(id) { return this.chiri.get(id); }

  /** 保存用 */
  serialize() {
    return { seed: this.seed, total: this.total, removed: this.removed.buffer.slice(0) };
  }

  static deserialize(data) {
    return new PileModel(data.seed, { total: data.total, removed: data.removed });
  }

  /** 状態の指紋（再現性テスト用） */
  fingerprint() {
    let h = 0x811c9dc5;
    for (let c = 0; c < this.nCols; c++) {
      h = Math.imul(h ^ this.top[c], 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
}

export function popcount(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}
