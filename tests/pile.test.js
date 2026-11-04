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

test('ちりモンを保護ケースへ運ぶと図鑑に登録、計量機から出荷すると誤出荷', () => {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  const exposed = pile.chiriList.filter(({ id }) => pile.isExposed(id));
  assert.ok(exposed.length >= 2, '最初から露出しているちりモンがいる');
  const at = (id) => { const t = pile.fishTransform(id); return { x: t.x, y: t.y, z: t.z }; };
  // 1匹目：保護
  assert.equal(g.pickFromPile(at(exposed[0].id), 0.05), 1);
  assert.equal(g.hand[0], exposed[0].id);
  assert.equal(g.releaseToCase(), 1);
  assert.equal(g.chiriState.get(exposed[0].id), 'protected');
  assert.equal(g.stats.protected, 1);
  // 2匹目：計量機へ → 救出できる
  g.pickFromPile(at(exposed[1].id), 0.05);
  g.releaseToScale();
  assert.equal(g.pickFromScale(), 1);
  assert.equal(g.hand[0], exposed[1].id);
  // もう一度入れて、しらすと一緒に包装 → 誤出荷
  g.releaseToScale();
  g.upgrades.add('glove4');
  while (g.scale.length < PACK_SIZE) { g.pickFromPile({ x: -2.9, y: pile.heightAt(-2.9, -0.5), z: -0.5 }, 0.1); g.releaseToScale(); }
  g.pack();
  assert.equal(g.chiriState.get(exposed[1].id), 'misshipped');
  assert.equal(g.stats.misshipped, 1);
  assert.ok(g.invariant().ok);
});
