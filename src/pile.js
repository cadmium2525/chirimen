// しらすの山の実体モデル（企画書 4章）
//
// - 10,000,000匹それぞれが固有ID（0 .. total-1）を持つ。
// - 山は cell×cell の「柱（チャンク）」に分割。柱 c は ID 範囲 [start[c], start[c+1]) を持ち、
//   柱の中では k=0 が一番上、k が大きいほど深い。
// - 各個体の座標・回転・形状バリエーションは (seed, id) から毎回再計算する（Meshは作らない）。
// - 除去状態は 1個体1ビットのビットセット（1,000万ビット ≒ 1.25MB）。
// - 各柱の「現在の一番上」は top[c]（除去済みでない最初の k）で、ビットセットから再現できる。
// - 崩れ：隣の柱より repose 以上高くなった柱は、上から個体が隣へ滑り落ちる。滑った個体は
//   元の場所のビットを立てたまま、行き先の柱の上に積まれた「崩れた層」extra[c] に入る（slid: id → 柱）。
//   山に残っている = ビットが立っていない、または崩れた層にいる。
//
// three.js に依存しない純粋なモジュール（テスト可能）。

import { hash01, mulberry32 } from './rng.js';
import { PILE, TOTAL_FISH, EXPOSE_DEPTH } from './config.js';
import { SPECIES } from './chirimonData.js';

const TAU = Math.PI * 2;
const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

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
    const { cx, cz, radius, height, cell, repose } = { ...PILE, ...(opts.shape || {}) };
    this.cx = cx; this.cz = cz; this.radius = radius; this.height = height; this.cell = cell;
    this.repose = opts.repose ?? repose;
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
    this.layer = sum / this.total; // 1匹ぶんの厚さ（どの柱でも同じ）

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
    this.baseH = new Float32Array(nCols); // 元からある個体の表面
    this.topH = new Float32Array(nCols);  // 崩れた層を含む表面
    this.extra = new Map();               // c -> [id]（下から上へ）
    this.slid = new Map();                // id -> c
    this.settleQ = new Set();             // 崩れを調べる柱
    this.removedCount = 0;
    for (let w = 0; w < this.words; w++) this.removedCount += popcount(this.removed[w]);
    if (opts.slid) {
      for (const [c, ids] of opts.slid) {
        if (!(c >= 0 && c < nCols)) continue;
        const arr = [];
        for (const id of ids) {
          // 元の場所のビットが立っていない・重複している個体は壊れたデータなので無視する
          if (!Number.isInteger(id) || id < 0 || id >= this.total || !this._bit(id) || this.slid.has(id)) continue;
          arr.push(id); this.slid.set(id, c);
        }
        if (arr.length) this.extra.set(c, arr);
      }
      this.removedCount -= this.slid.size;
    }
    for (let c = 0; c < nCols; c++) this._recomputeTop(c);

    // --- ちりモンの配置（開始時から決まっている）
    this.chiriAlgo = opts.chiriAlgo ?? 3;
    this._placeChirimon();
    for (const [id, c] of this.slid) if (this.chiri.has(id)) this._moveChiriCol(id, this.columnOf(id), c);

    this.version = 0; // 変更のたびに増える（描画側のキャッシュ判定用）
    this.dirtyCols = new Set();
    // 途中まで崩れていたセーブは、続きから崩れる
    if (this.removedCount > 0 || this.slid.size) this._queueUnstable();
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

  /** 個体がいま属している柱（崩れて移った個体は移った先） */
  colOfFish(id) { const c = this.slid.get(id); return c ?? this.columnOf(id); }

  extraLen(c) { const a = this.extra.get(c); return a ? a.length : 0; }

  /** 柱 c に残っている匹数（元からある分は上端より下を数える近似） */
  remaining(c) { return this.count(c) - this.top[c] + this.extraLen(c); }

  hasAny(c) { return this.top[c] < this.count(c) || this.extra.has(c); }

  /** 柱 c の一番上の個体（なければ -1） */
  topId(c) {
    const a = this.extra.get(c);
    if (a) return a[a.length - 1];
    return this.top[c] < this.count(c) ? this.start[c] + this.top[c] : -1;
  }

  /** 崩れた層の j 番目（下から）の高さ */
  slidY(c, j, id) { return this.baseH[c] + (j + 0.5 + (hash01(this.seed, id, 1) - 0.5) * 0.9) * this.layer; }

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
    const sc = this.slid.get(id);
    const c = sc ?? out.c ?? this.columnOf(id);
    const cell = this.cell;
    out.x = this.x0 + ((c % this.G) + hash01(this.seed, id, 2)) * cell;
    out.z = this.z0 + (Math.floor(c / this.G) + hash01(this.seed, id, 3)) * cell;
    if (sc != null) out.y = this.slidY(c, out.j ?? this.extra.get(c).lastIndexOf(id), id);
    else out.y = this.yAt(c, id - this.start[c]);
    out.j = undefined;
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
    const c = this.slid.get(id) ?? out.c ?? this.columnOf(id);
    this.fishTransform(id, out);
    out.y = this.heightAt(out.x, out.z) - (this.topH[c] - out.y);
    return out;
  }

  // ===== 除去状態 =====
  _bit(id) { return (this.removed[id >>> 5] >>> (id & 31)) & 1; }

  /** 山に残っていない（取り除かれた）か */
  isRemoved(id) { return this._bit(id) === 1 && !this.slid.has(id) ? 1 : 0; }

  /** 個体を山から取り除く（出荷・保持などの行き先はゲーム側が管理） */
  remove(id) {
    if (id < 0 || id >= this.total || this.isRemoved(id)) return false;
    const c = this._detach(id);
    this.removedCount++;
    this.settleQ.add(c);
    return true;
  }

  /** 山の中の今の場所から外す（ビット・崩れた層を更新）。属していた柱を返す */
  _detach(id) {
    const sc = this.slid.get(id);
    let c;
    if (sc != null) {
      c = sc;
      const a = this.extra.get(c);
      const j = a[a.length - 1] === id ? a.length - 1 : a.lastIndexOf(id);
      a.splice(j, 1);
      if (!a.length) this.extra.delete(c);
      this.slid.delete(id);
      this._recomputeTop(c);
    } else {
      this.removed[id >>> 5] |= 1 << (id & 31);
      c = this.columnOf(id);
      if (id - this.start[c] === this.top[c]) this._recomputeTop(c);
    }
    this.version++;
    this.dirtyCols.add(c);
    return c;
  }

  /** 柱 from の一番上の個体を、隣の柱 to の上へ滑らせる */
  _slide(from, to) {
    const id = this.topId(from);
    if (id < 0) return false;
    const orig = this.slid.get(id) ?? from;
    this._detach(id);
    let a = this.extra.get(to);
    if (!a) { a = []; this.extra.set(to, a); }
    a.push(id);
    this.slid.set(id, to);
    if (this.chiri.has(id)) this._moveChiriCol(id, orig, to);
    this._recomputeTop(to);
    this.dirtyCols.add(to);
    return true;
  }

  _moveChiriCol(id, from, to) {
    const l = this.chiriByCol.get(from);
    if (l) { const i = l.indexOf(id); if (i >= 0) l.splice(i, 1); if (!l.length) this.chiriByCol.delete(from); }
    if (!this.chiriByCol.has(to)) this.chiriByCol.set(to, []);
    this.chiriByCol.get(to).push(id);
  }

  /**
   * 崩れ：隣の柱より repose 以上高い柱から、差が repose に収まるまで個体を滑らせる。
   * 1回に動かすのは budget 匹まで（残りは次のフレームに続く）。動かした匹数を返す
   */
  settle(budget = 8000) {
    let moved = 0;
    const G = this.G, T = this.repose, L = this.layer;
    while (this.settleQ.size && moved < budget) {
      const c = this.settleQ.values().next().value;
      this.settleQ.delete(c);
      const ix = c % G, iz = (c - ix) / G;
      for (const [dx, dz] of NEIGH) {
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= G || nz >= G) continue;
        const n = nz * G + nx;
        let hi = c, lo = n, d = this.topH[c] - this.topH[n];
        if (d < 0) { hi = n; lo = c; d = -d; }
        if (d <= T + L) continue;
        const k = Math.min(budget - moved, Math.ceil((d - T) / (2 * L)));
        let m = 0;
        while (m < k && this._slide(hi, lo)) m++;
        moved += m;
        if (m) { this.settleQ.add(hi); this.settleQ.add(lo); }
        if (moved >= budget) { this.settleQ.add(c); break; }
      }
    }
    if (moved) this.version++;
    return moved;
  }

  _queueUnstable() {
    const G = this.G, lim = this.repose + this.layer;
    for (let c = 0; c < this.nCols; c++) {
      const ix = c % G;
      if ((ix + 1 < G && Math.abs(this.topH[c] - this.topH[c + 1]) > lim) || (c + G < this.nCols && Math.abs(this.topH[c] - this.topH[c + G]) > lim)) this.settleQ.add(c);
    }
  }

  /** 崩れが落ち着くまで進める（テスト・読み込み用） */
  settleAll(limit = 5e7) { let n = 0; while (this.settleQ.size && n < limit) n += this.settle(1e6); return n; }

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
    this.baseH[c] = k < n ? this.yAt(c, k) : 0;
    this.topH[c] = this.baseH[c] + this.extraLen(c) * this.layer;
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
        if (dx * dx + dz * dz <= rr && (this.count(c) > 0 || this.extra.has(c))) out.push(c);
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
    // 崩れて積もった層（上から）。fn の4番目の引数はその層での位置
    const a = this.extra.get(c);
    if (a) {
      for (let j = a.length - 1; j >= 0 && found < maxN; j--) {
        const y = this.slidY(c, j, a[j]);
        if (y < top - depth) return;
        found++;
        if (fn(a[j], y, -1, j) === false) return;
      }
    }
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
    const c = this.colOfFish(id);
    return this.fishTransform(id, {}).y >= this.topH[c] - EXPOSE_DEPTH;
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
        if (this.hasAny(c) && this.topH[c] > bestH) { bestH = this.topH[c]; best = c; }
      }
      if (best < 0) break;
      const id = this.topId(best);
      this.remove(id);
      taken.push(id);
    }
    return taken;
  }

  // ===== ちりモン =====
  // 配置アルゴリズムの版。v1（初期版）は表面付近に多く露出していた。
  // 既存セーブの山は v1 のまま再現し（「最初からこの山にいた」を守る）、新しい山は v2 で生成する。
  _placeChirimon() {
    this.chiri = new Map();      // id -> species index
    this.chiriByCol = new Map(); // c -> [id]
    this.chiriList = [];
    if (this.chiriAlgo === 1) this._placeV1();
    else if (this.chiriAlgo === 2) this._placeV2();
    else this._placeV3();
    this.chiriList.sort((a, b) => a.id - b.id);
  }

  _addChiri(c, k, si, used) {
    const cnt = this.count(c);
    const id = this.start[c] + Math.max(0, Math.min(k, cnt - 1));
    if (used.has(id)) return false;
    used.add(id);
    this.chiri.set(id, si);
    this.chiriList.push({ id, species: si });
    if (!this.chiriByCol.has(c)) this.chiriByCol.set(c, []);
    this.chiriByCol.get(c).push(id);
    return true;
  }

  /** v1：浅めに偏った配置（開始時に 20匹前後が露出） */
  _placeV1() {
    const rng = mulberry32(this.seed ^ 0x5eed1234);
    const used = new Set();
    let guaranteedShallow = 3;
    SPECIES.forEach((sp, si) => {
      const n = Math.max(1, Math.round(sp.base + (rng() * 2 - 1) * sp.spread));
      for (let i = 0; i < n; i++) {
        for (let tries = 0; tries < 50; tries++) {
          const c = this.columnOf(Math.floor(rng() * this.total));
          const cnt = this.count(c);
          if (cnt < 4) continue;
          let k;
          if (guaranteedShallow > 0 && si < 2 && this._reachableCol(c)) { k = Math.floor(rng() * 6); guaranteedShallow--; }
          else k = Math.floor(cnt * Math.pow(rng(), 2.6));
          if (this._addChiri(c, k, si, used)) break;
        }
      }
    });
  }

  /**
   * v2：表面にはほとんど出さない。
   * - 開始時に露出しているのは「まぐれ」の 1〜2匹だけ（よくある種類、山のどこか）
   * - 約45% は表面から 1.4〜3.5cm（表面を 0.2〜2.3cm 削ると出てくる層）
   * - 残りは 3.5cm より深く、底に向かって少しずつ減る
   */
  _placeV2() {
    const rng = mulberry32(this.seed ^ 0x7c41a2d9);
    const used = new Set();
    let lucky = 1 + Math.floor(rng() * 2);
    SPECIES.forEach((sp, si) => {
      const n = Math.max(1, Math.round((sp.base + (rng() * 2 - 1) * sp.spread) * 2.2));
      for (let i = 0; i < n; i++) {
        for (let tries = 0; tries < 80; tries++) {
          const c = this.columnOf(Math.floor(rng() * this.total));
          const cnt = this.count(c), h = this.h0[c];
          if (cnt < 4 || h < 0.05) continue;
          let depth;
          if (lucky > 0 && si < 2) { depth = rng() * 0.004; lucky--; }
          else if (rng() < 0.45) depth = 0.014 + rng() * 0.021;
          else depth = 0.035 + (h - 0.035) * Math.pow(rng(), 1.6);
          if (depth >= h) continue;
          const k = Math.floor(cnt * (depth / h));
          if (this._addChiri(c, k, si, used)) break;
        }
      }
    });
  }

  /**
   * v3：v2 を土台に、初めての人でも確実に出会えるよう調整。
   * - 「まぐれ」で露出している1〜2匹は、作業場から見て山の裏側に置く（最初の数歩では見つからない）
   * - 計量機側の斜面（初めて掘る場所）の 1.5〜3cm の深さに、よくある種類を数匹
   */
  _placeV3() {
    const rng = mulberry32(this.seed ^ 0x3a91c5e7);
    const used = new Set();
    let lucky = 1 + Math.floor(rng() * 2);
    const polar = (c) => {
      const dx = this.colCenterX(c) - this.cx, dz = this.colCenterZ(c) - this.cz;
      return { r: Math.hypot(dx, dz) / this.radius, a: Math.atan2(dz, dx) };
    };
    SPECIES.forEach((sp, si) => {
      const n = Math.max(1, Math.round((sp.base + (rng() * 2 - 1) * sp.spread) * 2.2));
      for (let i = 0; i < n; i++) {
        for (let tries = 0; tries < 80; tries++) {
          const c = this.columnOf(Math.floor(rng() * this.total));
          const cnt = this.count(c), h = this.h0[c];
          if (cnt < 4 || h < 0.05) continue;
          let depth;
          if (lucky > 0 && si < 2) {
            if (Math.abs(polar(c).a) < Math.PI * 0.6) continue; // 裏側だけ
            depth = rng() * 0.004; lucky--;
          } else if (rng() < 0.45) depth = 0.016 + rng() * 0.019;
          else depth = 0.035 + (h - 0.035) * Math.pow(rng(), 1.6);
          if (depth >= h) continue;
          if (this._addChiri(c, Math.floor(cnt * (depth / h)), si, used)) break;
        }
      }
    });
    // 計量機側の斜面（+X 側・角度±30°・半径の55〜92%）に「初めての出会い」用
    const firstSpecies = [0, 0, 1, 1, 2, 0, 1, 0, 3];
    for (const si of firstSpecies) {
      for (let tries = 0; tries < 200; tries++) {
        const c = this.columnOf(Math.floor(rng() * this.total));
        const { r, a } = polar(c);
        if (r < 0.55 || r > 0.92 || Math.abs(a) > Math.PI / 6) continue;
        const cnt = this.count(c), h = this.h0[c];
        if (cnt < 4 || h < 0.06) continue;
        const depth = 0.015 + rng() * 0.015;
        if (this._addChiri(c, Math.floor(cnt * (depth / h)), si, used)) break;
      }
    }
  }

  _sumH0() { let s = 0; for (let c = 0; c < this.nCols; c++) s += this.h0[c]; return s; }

  _reachableCol(c) {
    const dx = this.colCenterX(c) - this.cx, dz = this.colCenterZ(c) - this.cz;
    const r = Math.hypot(dx, dz) / this.radius;
    return r > 0.62 && r < 0.9 && dx > 0; // 計量機側の斜面
  }

  /**
   * 「気配」：(x,z) の近くで、まだ埋まっているちりモンのうち、いまの表面から maxDepth 以内のもの。
   * 最も近いものの {dist, depth} を返す（なければ null）。掘る場所の手がかりに使う
   */
  chiriSense(x, z, maxR = 0.3, maxDepth = 0.022) {
    if (!this._chiriPos) {
      this._chiriPos = this.chiriList.map(({ id }) => { const t = this.fishTransform(id, {}); return { id, c: this.columnOf(id), x: t.x, y: t.y, z: t.z }; });
    }
    let best = null;
    for (let p of this._chiriPos) {
      if (this.slid.has(p.id)) { const t = this.fishTransform(p.id, {}); p = { id: p.id, c: this.slid.get(p.id), x: t.x, y: t.y, z: t.z }; }
      const dist = Math.hypot(p.x - x, p.z - z);
      if (dist > maxR || this.isRemoved(p.id)) continue;
      const depth = this.topH[p.c] - p.y;
      if (depth <= EXPOSE_DEPTH || depth > maxDepth) continue;
      if (!best || dist < best.dist) best = { dist, depth, dx: p.x - x, dz: p.z - z };
    }
    return best;
  }

  /** 列のはじめからどれだけ掘ったか（m） */
  dugAt(x, z) {
    // 柱の境目を狙っても分かるように、まわり（±5cm）の柱のうち一番深く掘った値
    let best = 0;
    for (const ox of [-0.05, 0, 0.05]) for (const oz of [-0.05, 0, 0.05]) {
      const c = this.colAt(x + ox, z + oz);
      if (c >= 0) best = Math.max(best, this.h0[c] - this.topH[c]);
    }
    return best;
  }

  isChirimon(id) { return this.chiri.has(id); }
  speciesOf(id) { return this.chiri.get(id); }

  /** 保存用 */
  serialize() {
    const slid = [...this.extra].map(([c, ids]) => [c, ids.slice()]);
    return { seed: this.seed, total: this.total, chiriAlgo: this.chiriAlgo, removed: this.removed.buffer.slice(0), slid };
  }

  static deserialize(data) {
    // chiriAlgo が無いセーブは v1 で生成された山
    return new PileModel(data.seed, { total: data.total, removed: data.removed, chiriAlgo: data.chiriAlgo ?? 1, slid: data.slid });
  }

  /** 状態の指紋（再現性テスト用） */
  fingerprint() {
    let h = 0x811c9dc5;
    for (let c = 0; c < this.nCols; c++) {
      h = Math.imul(h ^ this.top[c], 0x01000193) >>> 0;
      const a = this.extra.get(c);
      if (a) h = Math.imul(h ^ (a.length * 2654435761 + a[a.length - 1]), 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
}

export function popcount(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}
