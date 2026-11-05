// セーブ：IndexedDB に世界状態（ビットセット等）、localStorage に軽量設定（企画書 6章）
//
// - 世界は2つのスロット（world / world2）に交互に書く。読み込み時は新しい順に検証し、
//   壊れていれば一つ前のスロットから復元する。
// - 書き出し／読み込みファイルで、PC とスマホの間でもセーブを移せる。
import { SAVE_VERSION } from './config.js';
import { pickBest, toExport, fromExport } from './saveFormat.js';

const DB = 'shirasu-no-yama';
const STORE = 'kv';
const SLOTS = ['world', 'world2'];

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const r = fn(store);
    t.oncomplete = () => { db.close(); resolve(r && 'result' in r ? r.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error || new Error('aborted')); };
  });
}

export async function loadKey(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch (e) { console.warn('load failed', e); return null; }
}

export async function saveKey(key, value) {
  await tx('readwrite', (s) => s.put(value, key));
  return true;
}

export async function deleteKey(key) {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* noop */ }
}

/** 永続ストレージを要求（Safari などで自動削除されにくくする） */
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* noop */ }
  return false;
}

let lastSlot = 0;

/**
 * 読み込み。戻り値 { world, problems, fromBackup, tooNew }
 * world は移行・検証済み（version は最新）
 */
export async function loadWorld() {
  const raws = await Promise.all(SLOTS.map((k) => loadKey(k)));
  const r = pickBest(raws);
  // 検証に通らなかったセーブは、上書きされる前に別の場所へ退避しておく（後から調べたり戻したりできるように）
  if (r.broken && r.broken.length) {
    try { await saveKey('broken', { at: Date.now(), problems: r.problems, worlds: r.broken }); } catch (e) { console.warn('backup failed', e); }
  }
  if (r.world) {
    // 次は、今読んだものではない方のスロットに書く
    const idx = raws.findIndex((x) => x && x.savedAt === r.world.savedAt);
    lastSlot = idx < 0 ? 0 : idx;
  }
  return r;
}

export function makeWorld({ pile, game, player }) {
  // その瞬間の状態を同期的に複製する。書き込みは非同期なので、参照のままだと
  // 保存の途中に「つまむ／はなす」が混ざり、個体数の合わないセーブになる
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    pile: pile.serialize(),
    game: structuredClone(game.toJSON()),
    player: { x: player.x, z: player.z, yaw: player.yaw, pitch: player.pitch },
  };
}

export async function saveWorld(state) {
  const w = makeWorld(state);
  const slot = (lastSlot + 1) % SLOTS.length;
  await saveKey(SLOTS[slot], w);
  lastSlot = slot;
  return w.savedAt;
}

export async function deleteAll() {
  for (const k of [...SLOTS, 'dex', 'broken']) await deleteKey(k);
}

export const loadDex = () => loadKey('dex');
export const loadBroken = () => loadKey('broken');
export const saveDex = (dex) => saveKey('dex', dex);

// ===== 書き出し・読み込み =====
const hasGzip = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function gzip(text) {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(s).arrayBuffer()], { type: 'application/gzip' });
}

async function gunzip(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

/** セーブファイルを作る（gzip が使えれば .shirasu.gz、なければ .json） */
export async function exportFile(state, dex) {
  const text = JSON.stringify(toExport(makeWorld(state), dex));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  if (hasGzip()) return { blob: await gzip(text), name: `shirasu-${stamp}.shirasu.gz` };
  return { blob: new Blob([text], { type: 'application/json' }), name: `shirasu-${stamp}.json` };
}

/** ファイルから読み込む。{ world, dex } を返す（検証済み） */
export async function importFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let text;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    if (!hasGzip()) throw new Error('このブラウザでは圧縮ファイルを読めません');
    text = await gunzip(buf);
  } else text = new TextDecoder().decode(buf);
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('ファイルの形式が正しくありません'); }
  return fromExport(obj);
}

/** 読み込んだ世界を今のセーブとして書き込む */
export async function writeImported(world, dex) {
  world.savedAt = Date.now();
  await saveKey(SLOTS[0], world);
  await deleteKey(SLOTS[1]);
  await saveKey('dex', dex);
  lastSlot = 0;
}

// ---- 設定（localStorage）
export const DEFAULT_SETTINGS = {
  quality: 'auto', sens: 1, touchSens: 1, fov: 75, bob: true, assist: 'auto',
  textSize: 'm', layout: 'right', aid: 'auto', sound: true,
  // P5：スマホ操作・画質の詳細
  btnSize: 'm', holdRelease: false, haptics: true,
  qRes: 'auto', qDensity: 'preset', qShadows: 'preset', qDistance: 'preset', showFps: false,
  guide: true,
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('shirasu-settings') || '{}');
    return { ...DEFAULT_SETTINGS, ...s };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem('shirasu-settings', JSON.stringify(s)); } catch { /* noop */ }
}
