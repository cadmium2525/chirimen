import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PileModel } from '../src/pile.js';
import { Game } from '../src/game.js';
import { SAVE_VERSION } from '../src/config.js';
import { encodeBitset, decodeBitset, migrate, pickBest, toExport, fromExport, isTooNew } from '../src/saveFormat.js';

function makeWorld(seed = 77, savedAt = 1000) {
  const pile = new PileModel(seed);
  const g = new Game(pile);
  g.upgrades.add('glove3');
  for (let k = 0; k < 20; k++) { g.pickFromPile({ x: -3.5, y: pile.heightAt(-3.5, k * 0.1), z: k * 0.1 }, 0.08); g.releaseToScale(); }
  g.money = 1234;
  return { version: SAVE_VERSION, savedAt, pile: pile.serialize(), game: JSON.parse(JSON.stringify(g.toJSON())), player: { x: 1, z: 2, yaw: 0, pitch: 0 } };
}

test('ビットセットの RLE は元に戻る（空・満杯・ばらばら）', () => {
  const n = 312500;
  const cases = [new Uint32Array(n), new Uint32Array(n).fill(0xffffffff), new Uint32Array(n)];
  for (let i = 0; i < n; i += 997) cases[2][i] = (i * 2654435761) >>> 0;
  cases[2].fill(0xffffffff, 5000, 9000);
  for (const w of cases) {
    const b64 = encodeBitset(w);
    assert.deepEqual(decodeBitset(b64, n), w);
  }
  // ほとんど空の山なら非常に小さい
  assert.ok(encodeBitset(cases[0]).length < 100);
});

test('v1 のセーブは v2 に移行され、新しすぎる版は読み込まない', () => {
  const w = makeWorld();
  const v1 = { ...w, version: 1, pile: { ...w.pile } };
  delete v1.pile.chiriAlgo;
  delete v1.game.factory;
  const m = migrate(v1);
  assert.equal(m.version, SAVE_VERSION);
  assert.equal(m.pile.chiriAlgo, 1);
  assert.deepEqual(m.game.factory.machines, []);
  assert.equal(migrate({ ...w, version: SAVE_VERSION + 1 }), null);
  assert.ok(isTooNew({ version: SAVE_VERSION + 1 }));
});

test('壊れた新しいスロットより、検証に通る古いスロットを選ぶ', () => {
  const good = makeWorld(77, 1000);
  const broken = makeWorld(77, 2000);
  broken.game.scale = broken.game.scale.slice(0, 3); // 個体が消えた（保存則が崩れる）
  const r = pickBest([good, broken]);
  assert.equal(r.world.savedAt, 1000);
  assert.ok(r.fromBackup);
  assert.equal(r.problems.length, 1);
  const r2 = pickBest([good, makeWorld(77, 3000)]);
  assert.equal(r2.world.savedAt, 3000);
  assert.ok(!r2.fromBackup);
  assert.ok(pickBest([makeWorld(1, 5), { ...good, version: 99, savedAt: 9999 }]).tooNew);
});

test('書き出し → 読み込みで同じ世界が復元される（JSON 経由）', () => {
  const w = makeWorld();
  const dex = { ebi: { protected: 2, misshipped: 1 } };
  const json = JSON.stringify(toExport(w, dex));
  assert.ok(json.length < 60000, `size ${json.length}`);
  const back = fromExport(JSON.parse(json));
  assert.deepEqual(back.dex, dex);
  const a = PileModel.deserialize(w.pile), b = PileModel.deserialize(back.world.pile);
  assert.equal(b.fingerprint(), a.fingerprint());
  assert.equal(b.removedCount, a.removedCount);
  assert.equal(back.world.game.money, 1234);
  assert.throws(() => fromExport({ app: 'other' }), /セーブファイルではありません/);
});
