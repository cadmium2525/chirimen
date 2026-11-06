import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PileModel } from '../src/pile.js';
import { Game } from '../src/game.js';
import { TOTAL_FISH, PACK_SIZE } from '../src/config.js';

const SEED = 12345;

test('1,000万IDが柱にちょうど割り当てられる', () => {
  const p = new PileModel(SEED);
  assert.equal(p.total, TOTAL_FISH);
  assert.equal(p.start[0], 0);
  assert.equal(p.start[p.nCols], TOTAL_FISH);
  for (let c = 0; c < p.nCols; c++) assert.ok(p.start[c] <= p.start[c + 1]);
  // columnOf は start と整合
  for (const id of [0, 1, 4_999_999, 9_999_999, 1234567]) {
    const c = p.columnOf(id);
    assert.ok(p.start[c] <= id && id < p.start[c + 1], `id ${id}`);
  }
  // ビットセットは約1.25MB
  assert.equal(p.removed.byteLength, Math.ceil(TOTAL_FISH / 32) * 4);
});

test('同じシードなら座標とちりモン配置が同一、別シードなら異なる', () => {
  const a = new PileModel(SEED), b = new PileModel(SEED), c = new PileModel(SEED + 1);
  assert.deepEqual(a.chiriList, b.chiriList);
  assert.notDeepEqual(a.chiriList, c.chiriList);
  for (const id of [7, 777777, 9_000_001]) assert.deepEqual(a.fishTransform(id), b.fishTransform(id));
  assert.ok(a.chiriList.length > 50);
});

test('柱の中では上から順に高さが下がる', () => {
  const p = new PileModel(SEED);
  const c = p.columnOf(5_000_000);
  let prev = Infinity;
  for (let k = 0; k < p.count(c); k++) {
    const y = p.yAt(c, k);
    assert.ok(y < prev);
    prev = y;
  }
});

test('同じシード・同じ除去状態で再現（保存→復元）', () => {
  const a = new PileModel(SEED);
  const b = new PileModel(SEED);
  const ops = [[-3.2, 0.4, 0.2, 500], [-3.0, -0.6, 0.1, 50], [-4.5, 1.5, 0.3, 2000]];
  for (const [x, z, r, n] of ops) { a.scrape(x, z, r, n); b.scrape(x, z, r, n); }
  assert.equal(a.fingerprint(), b.fingerprint());
  const restored = PileModel.deserialize(structuredClone(a.serialize()));
  assert.equal(restored.fingerprint(), a.fingerprint());
  assert.equal(restored.removedCount, a.removedCount);
  assert.deepEqual([...restored.topH], [...a.topH]);
});

test('山を削ると埋まっていたちりモンが露出する', () => {
  const p = new PileModel(SEED);
  const buried = p.chiriList.find(({ id }) => !p.isExposed(id) && id - p.start[p.columnOf(id)] < 300);
  assert.ok(buried, '浅めに埋まったちりモンがいる');
  const c = p.columnOf(buried.id);
  // その柱を上から掘る
  while (!p.isExposed(buried.id)) {
    const id = p.start[c] + p.top[c];
    assert.notEqual(id, buried.id);
    p.remove(id);
  }
  assert.ok(p.isExposed(buried.id));
});

test('つまむ→計量機→包装で個体が複製も消失もしない', () => {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  g.upgrades.add('glove3'); // 20匹
  const surf = (x, z) => ({ x, y: pile.heightAt(x, z), z });
  for (let i = 0; i < 30; i++) {
    const n = g.pickFromPile(surf(-2.9 - i * 0.01, 0.2), 0.08);
    assert.ok(n > 0);
    assert.ok(g.invariant().ok, JSON.stringify(g.invariant()));
    if (i % 3 === 0) g.releaseToFloor({ x: 0, z: 0 });
    else g.releaseToScale();
    assert.ok(g.invariant().ok);
    if (i % 3 === 0) { g.pickFromFloor({ x: 0, z: 0 }, 0.5); g.releaseToScale(); }
  }
  const packs = g.pack();
  assert.ok(packs > 0);
  assert.ok(g.scale.length < PACK_SIZE);
  assert.ok(g.invariant().ok);
  // 保存→復元しても保存則が成り立つ
  const g2 = new Game(PileModel.deserialize(pile.serialize()), JSON.parse(JSON.stringify(g.toJSON())));
  assert.ok(g2.invariant().ok);
  assert.equal(g2.money, g.money);
});

/** ちりモンの柱を上から掘って露出させる（掘った個体は出荷扱い） */
function digTo(g, id) {
  const pile = g.pile;
  const c = pile.columnOf(id);
  while (!pile.isExposed(id)) {
    const top = pile.start[c] + pile.top[c];
    pile.remove(top);
    g.shipped++;
  }
}

test('ちりモンを保護ケースへ運ぶと図鑑に登録、計量機から出荷すると誤出荷', () => {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  const [a, b] = pile.chiriList.filter(({ id }) => !pile.isExposed(id));
  digTo(g, a.id); digTo(g, b.id);
  const at = (id) => { const t = pile.visualTransform(id); return { x: t.x, y: t.y, z: t.z }; };
  // 1匹目：保護
  assert.ok(g.pickFromPile(at(a.id), 0.05) >= 1);
  assert.equal(g.hand[0], a.id);
  assert.equal(g.releaseToCase(), 1);
  g.releaseToFloor({ x: 0, z: 0 }); // 一緒につまんだしらすは床へ
  assert.equal(g.chiriState.get(a.id), 'protected');
  assert.equal(g.stats.protected, 1);
  // 2匹目：計量機へ → 救出できる
  g.pickFromPile(at(b.id), 0.05);
  assert.equal(g.hand[0], b.id);
  g.releaseToScale();
  assert.ok(g.pickFromScale() >= 1);
  assert.equal(g.hand[0], b.id, 'ちりモンが優先して取り出される');
  // もう一度入れて、しらすと一緒に包装 → 誤出荷
  g.releaseToScale();
  g.upgrades.add('glove4');
  while (g.scale.length < PACK_SIZE) { g.pickFromPile({ x: -2.9, y: pile.heightAt(-2.9, -0.5), z: -0.5 }, 0.1); g.releaseToScale(); }
  assert.equal(g.pack(), 0, 'ちりモン入りは1回目は警告だけ');
  assert.equal(g.chiriState.get(b.id), 'scale');
  g.pack();
  assert.equal(g.chiriState.get(b.id), 'misshipped');
  assert.equal(g.stats.misshipped, 1);
  assert.ok(g.invariant().ok, JSON.stringify(g.invariant()));
});

test('新しい山では開始時に表面へ露出しているちりモンはごくわずか', () => {
  for (const seed of [1, 2, 3, 42, 12345, 777]) {
    const p = new PileModel(seed);
    const exposed = p.chiriList.filter(({ id }) => p.isExposed(id)).length;
    assert.ok(exposed <= 3, `seed ${seed}: ${exposed}`);
    assert.ok(p.chiriList.length > 120);
  }
});

test('配置アルゴリズムの版がないセーブは v1 として同じ配置を再現する', () => {
  const v1 = new PileModel(SEED, { chiriAlgo: 1 });
  const data = v1.serialize();
  delete data.chiriAlgo; // 旧セーブ
  const restored = PileModel.deserialize(data);
  assert.equal(restored.chiriAlgo, 1);
  assert.deepEqual(restored.chiriList, v1.chiriList);
  const v3 = PileModel.deserialize(new PileModel(SEED).serialize());
  assert.equal(v3.chiriAlgo, 3, '新しい山は v3');
  assert.notDeepEqual(v3.chiriList, v1.chiriList);
  const v2 = PileModel.deserialize(new PileModel(SEED, { chiriAlgo: 2 }).serialize());
  assert.equal(v2.chiriAlgo, 2, 'v2 の山は v2 のまま');
  assert.deepEqual(v2.chiriList, new PileModel(SEED, { chiriAlgo: 2 }).chiriList);
});

test('気配：浅く埋まったちりモンの近くでだけ反応し、照準表示のちりモンは周りのしらすより優先してつまめる', () => {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  g.upgrades.add('glove2');
  const { id } = pile.chiriList.find(({ id }) => !pile.isExposed(id));
  const t = pile.fishTransform(id, {});
  const c = pile.columnOf(id);
  // 表面から 3cm 以内になるまで掘る
  assert.ok(pile.chiriSense(t.x, t.z) == null || pile.topH[c] - t.y <= 0.022, '深いうちは気配がない');
  while (pile.topH[c] - t.y > 0.012) { pile.remove(pile.start[c] + pile.top[c]); g.shipped++; }
  if (!pile.isExposed(id)) {
    const s = pile.chiriSense(t.x + 0.05, t.z);
    assert.ok(s && s.dist < 0.1, '近くで気配がある');
  }
  assert.equal(pile.chiriSense(t.x + 1.5, t.z + 1.5, 0.3, 0.0001), null);
  digTo(g, id);
  // 6cm ずれた所を狙っても、表示されたちりモンをつまむ
  const n = g.pickFromPile({ x: t.x + 0.06, y: pile.heightAt(t.x + 0.06, t.z), z: t.z }, 0.06, id);
  assert.equal(n, 1);
  assert.equal(g.hand[0], id);
  assert.ok(g.invariant().ok);
});

// ===== 崩れ =====
const maxNeighborDiff = (p) => {
  let mx = 0; const G = p.G;
  for (let c = 0; c < p.nCols; c++) {
    if (c % G + 1 < G) mx = Math.max(mx, Math.abs(p.topH[c] - p.topH[c + 1]));
    if (c + G < p.nCols) mx = Math.max(mx, Math.abs(p.topH[c] - p.topH[c + G]));
  }
  return mx;
};

test('崩れ：手つかずの山と浅い掘りでは崩れない。深い穴は周りが崩れて埋まり、個体数は変わらない', () => {
  const p = new PileModel(4242);
  assert.equal(p.settleQ.size, 0);
  assert.ok(maxNeighborDiff(p) < p.repose);
  const c = p.colAt(p.cx + p.radius * 0.72, 0), h = p.topH[c];
  while (p.topH[c] > h - 0.02) p.remove(p.topId(c));
  assert.equal(p.settleAll(), 0, '2cm の掘りでは崩れない');
  while (p.topH[c] > h - 0.2) p.remove(p.topId(c));
  const inPile = p.total - p.removedCount;
  assert.ok(p.settleAll() > 0);
  assert.equal(p.total - p.removedCount, inPile, '崩れても山の個体数は同じ');
  assert.ok(h - p.topH[c] < 0.12, `穴の深さ ${(h - p.topH[c]).toFixed(3)}`);
  assert.ok(maxNeighborDiff(p) <= p.repose + p.layer * 2);
  // 滑った個体はビットが立ったまま、山には残っている
  const [id] = p.slid.keys();
  assert.ok(p._bit(id) && !p.isRemoved(id));
  assert.equal(p.colOfFish(id), p.slid.get(id));
});

test('崩れ：崖は安息角までならされ、崩れた個体もつまめる。保存→復元で同じ状態', () => {
  const p = new PileModel(99);
  const g = new Game(p);
  for (let c = 0; c < p.nCols; c++) {
    if (p.colCenterX(c) < p.cx + 0.2 || Math.abs(p.colCenterZ(c)) > 0.5) continue;
    while (p.hasAny(c)) { p.remove(p.topId(c)); g.shipped++; }
  }
  p.settleAll();
  assert.ok(p.slid.size > 1000);
  assert.ok(maxNeighborDiff(p) <= p.repose + p.layer * 2);
  assert.ok(g.invariant().ok);
  // 崩れて積もった層の一番上をつまむ
  const c = p.slid.get(p.slid.keys().next().value);
  const top = p.topId(c);
  assert.ok(p.slid.has(top) && p.isExposed(top));
  const t = p.visualTransform(top, {});
  const n = g.pickFromPile({ x: t.x, y: t.y, z: t.z }, 0.03);
  assert.ok(n >= 1 && g.invariant().ok);
  // 保存→復元
  const q = PileModel.deserialize(JSON.parse(JSON.stringify({ ...p.serialize(), removed: [...new Uint32Array(p.serialize().removed)] }), (k, v) => (k === 'removed' ? new Uint32Array(v).buffer : v)));
  assert.equal(q.fingerprint(), p.fingerprint());
  assert.equal(q.removedCount, p.removedCount);
  assert.equal(q.slid.size, p.slid.size);
  const id = [...p.slid.keys()][5];
  assert.deepEqual(q.fishTransform(id, {}), p.fishTransform(id, {}));
});

test('崩れ：途中で保存した山は、読み込むと続きから崩れる。ちりモンも一緒に滑る', () => {
  const p = new PileModel(7);
  for (let c = 0; c < p.nCols; c++) {
    if (p.colCenterX(c) < p.cx) continue;
    while (p.hasAny(c)) p.remove(p.topId(c));
  }
  p.settle(5000);
  const q = PileModel.deserialize(p.serialize());
  assert.ok(q.settleQ.size > 0, '不安定な柱が再び調べられる');
  q.settleAll();
  assert.ok(maxNeighborDiff(q) <= q.repose + q.layer * 2);
  for (const [id, c] of q.slid) if (q.isChirimon(id)) assert.ok(q.chiriByCol.get(c).includes(id));
});

test('崩れ：どの山も、最初の形のままなら崩れない（最初から急な斜面があっても）', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const p = new PileModel(seed * 7919);
    p._queueUnstable();
    assert.equal(p.settleQ.size, 0, `seed ${seed * 7919}`);
    // 1匹だけ取った山を読み込み直しても、一斉に崩れない
    p.remove(p.topId(p.colAt(p.cx + p.radius * 0.72, 0)));
    const q = PileModel.deserialize(p.serialize());
    assert.ok(q.settleAll() < 50, `seed ${seed * 7919}`);
  }
});
