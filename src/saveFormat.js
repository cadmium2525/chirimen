// セーブ形式（企画書 6章：バージョン番号を持たせる）。ブラウザ API に依存しない純粋な関数。
//
// - 世界の保存データ: { version, savedAt, pile: {seed,total,chiriAlgo,removed}, game, player }
// - 書き出しファイル: { app, format, version, savedAt, world: {..., pile: {..., removedRLE}}, dex }
//   ビットセットは「同じ値の連続」をまとめた RLE を base64 にして小さくする。

import { SAVE_VERSION } from './config.js';
import { PileModel } from './pile.js';
import { Game } from './game.js';

export const APP_ID = 'shirasu-no-yama';

// ===== base64 =====
export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

export function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ===== ビットセットの RLE =====
// 32bit 単位で「見出し語」＋データ。見出しの最上位ビットが 1 なら次の1語を (見出し & 0x7fffffff) 回くり返す。
// 0 なら続く (見出し) 語をそのまま並べる。
export function encodeBitset(words) {
  const out = [];
  let i = 0;
  const n = words.length;
  while (i < n) {
    let j = i + 1;
    while (j < n && words[j] === words[i] && j - i < 0x7fffffff) j++;
    if (j - i >= 3) {
      out.push((0x80000000 | (j - i)) >>> 0, words[i]);
      i = j;
    } else {
      const start = i;
      // 3語以上の連続が始まるまでは、そのまま並べる
      while (i < n && !(i + 2 < n && words[i] === words[i + 1] && words[i] === words[i + 2])) i++;
      out.push(i - start);
      for (let k = start; k < i; k++) out.push(words[k]);
    }
  }
  return bytesToBase64(new Uint8Array(new Uint32Array(out).buffer));
}

export function decodeBitset(b64, nWords) {
  const bytes = base64ToBytes(b64);
  const src = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  const out = new Uint32Array(nWords);
  let o = 0;
  for (let i = 0; i < src.length;) {
    const h = src[i++];
    if (h & 0x80000000) {
      const cnt = h & 0x7fffffff, v = src[i++];
      if (o + cnt > nWords) throw new Error('bitset overflow');
      out.fill(v, o, o + cnt);
      o += cnt;
    } else {
      if (o + h > nWords) throw new Error('bitset overflow');
      out.set(src.subarray(i, i + h), o);
      i += h; o += h;
    }
  }
  if (o !== nWords) throw new Error('bitset size mismatch');
  return out;
}

// ===== バージョン移行 =====
/** 古い版のセーブを今の版の形にそろえる。新しすぎる版は null（上書きしないため） */
export function migrate(world) {
  if (!world || typeof world !== 'object') return null;
  let w = { ...world };
  const v = w.version ?? 1;
  if (v > SAVE_VERSION) return null;
  if (v < 2) {
    // v1 → v2：ちりモン配置の版・設備がない古い形式を補う
    w.pile = { ...w.pile };
    if (w.pile.chiriAlgo == null) w.pile.chiriAlgo = 1;
    w.game = { ...w.game };
    w.game.factory = w.game.factory || { nextId: 1, machines: [] };
  }
  w.version = SAVE_VERSION;
  return w;
}

export function isTooNew(world) { return !!world && (world.version ?? 1) > SAVE_VERSION; }

/** 実際に復元してみて、個体の保存則が成り立つか確かめる */
export function validate(world) {
  try {
    const pile = PileModel.deserialize(world.pile);
    const game = new Game(pile, world.game, {});
    const inv = game.invariant();
    if (!inv.ok) return { ok: false, reason: `個体数が合わない（除去 ${inv.removed} / 所在 ${inv.accounted}）` };
    return { ok: true, pile, game };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

/** 検証に通らない世界を修復してみる（個体の所在を数え直す）。直せなければ null */
export function repairWorld(world) {
  try {
    const pile = PileModel.deserialize(world.pile);
    const game = new Game(pile, world.game, {});
    const fixed = game.repair();
    if (!game.invariant().ok) return null;
    const w = { ...world, game: game.toJSON() };
    return validate(w).ok ? { world: w, fixed } : null;
  } catch {
    return null;
  }
}

/**
 * 複数スロットの中から、新しい順に「移行して検証に通ったもの」を選ぶ。
 * どれも通らなければ、いちばん新しいものの修復を試みる（repaired に理由）。
 * 戻り値の broken は検証に通らなかった生データ（上書き前に退避するため）
 */
export function pickBest(slots) {
  const list = slots.filter(Boolean).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const problems = [];
  const broken = [];
  const migrated = [];
  for (const raw of list) {
    if (isTooNew(raw)) return { tooNew: true, problems, broken };
    const w = migrate(raw);
    const v = validate(w);
    if (v.ok) return { world: w, problems, broken, fromBackup: raw !== list[0] };
    problems.push(v.reason);
    broken.push(raw);
    if (w) migrated.push(w);
  }
  for (const w of migrated) {
    const r = repairWorld(w);
    if (r) return { world: r.world, problems, broken, repaired: problems[0] || '不明' };
  }
  return { world: null, problems, broken };
}

// ===== 書き出し・読み込み =====
export function toExport(world, dex) {
  const removed = world.pile.removed instanceof ArrayBuffer ? new Uint32Array(world.pile.removed) : new Uint32Array(world.pile.removed.buffer || world.pile.removed);
  const { removed: _drop, ...pileRest } = world.pile;
  void _drop;
  return {
    app: APP_ID,
    format: 1,
    version: world.version,
    savedAt: world.savedAt,
    world: { ...world, pile: { ...pileRest, words: removed.length, removedRLE: encodeBitset(removed) } },
    dex: dex || {},
  };
}

export function fromExport(obj) {
  if (!obj || obj.app !== APP_ID) throw new Error('「しらすの山」のセーブファイルではありません');
  if ((obj.version ?? 1) > SAVE_VERSION) throw new Error('新しい版のゲームで作られたセーブです。ページを再読み込みして最新版にしてください');
  const p = obj.world.pile;
  const words = decodeBitset(p.removedRLE, p.words);
  const { removedRLE: _r, words: _w, ...rest } = p;
  void _r; void _w;
  const world = migrate({ ...obj.world, pile: { ...rest, removed: words.buffer } });
  const v = validate(world);
  if (!v.ok) throw new Error(`セーブデータが壊れています：${v.reason}`);
  return { world, dex: obj.dex || {} };
}
