// セーブ：IndexedDB に世界状態（ビットセット等）、localStorage に軽量設定（企画書 6章）
import { SAVE_VERSION } from './config.js';

const DB = 'shirasu-no-yama';
const STORE = 'kv';

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
  });
}

export async function loadKey(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch (e) { console.warn('load failed', e); return null; }
}

export async function saveKey(key, value) {
  try { await tx('readwrite', (s) => s.put(value, key)); return true; } catch (e) { console.warn('save failed', e); return false; }
}

export async function deleteKey(key) {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* noop */ }
}

export async function loadWorld() {
  const w = await loadKey('world');
  if (!w || w.version !== SAVE_VERSION) return null;
  return w;
}

export function saveWorld({ pile, game, player }) {
  return saveKey('world', {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    pile: pile.serialize(),
    game: game.toJSON(),
    player: { x: player.x, z: player.z, yaw: player.yaw, pitch: player.pitch },
  });
}

export const loadDex = () => loadKey('dex');
export const saveDex = (dex) => saveKey('dex', dex);

// ---- 設定（localStorage）
export const DEFAULT_SETTINGS = {
  quality: 'auto', sens: 1, touchSens: 1, fov: 75, bob: true, assist: 'mid',
  textSize: 'm', layout: 'right', aid: 'auto', sound: true,
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
