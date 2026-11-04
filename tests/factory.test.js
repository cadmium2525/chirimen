import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PileModel } from '../src/pile.js';
import { Game } from '../src/game.js';
import { MACHINES, PACK_SIZE, PACK_PRICE } from '../src/config.js';

const SEED = 4242;

/** クレーン → ホッパー → コンベア×3 → 包装機 のラインを作る */
function makeLine() {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  g.money = 1e6;
  const f = g.factory;
  // 山の東側の裾（x ≈ -2.25）に近いマス
  const [ci, cj] = f.cellOf(-1.9, 0.1);
  const r = [
    f.place('crane', ci, cj, 0),          // → +X に降ろす
    f.place('hopper', ci + 1, cj, 0),
    f.place('conveyor', ci + 2, cj, 0),
    f.place('conveyor', ci + 3, cj, 0),
    f.place('conveyor', ci + 4, cj, 0),
    f.place('packer', ci + 5, cj, 0),
  ];
  for (const x of r) assert.ok(x.ok, x.reason);
  return { pile, g, f, ci, cj };
}

test('クレーンが山の実在IDを取り除き、ラインを通って包装・出荷される', () => {
  const { pile, g, f } = makeLine();
  const money0 = g.money;
  for (let t = 0; t < 120; t += 0.1) {
    f.tick(0.1);
    if (Math.round(t * 10) % 50 === 0) assert.ok(g.invariant().ok, JSON.stringify(g.invariant()));
  }
  assert.ok(pile.removedCount > 1000, `removed ${pile.removedCount}`);
  assert.ok(g.packs > 10, `packs ${g.packs}`);
  assert.equal(g.money - money0, g.packs * PACK_PRICE);
  const inv = g.invariant();
  assert.ok(inv.ok, JSON.stringify(inv));
  // 取り除かれたIDはすべて実在し、二重に数えられていない
  assert.equal(inv.accounted, pile.removedCount);
});

test('設置ルール：重なり・山の上・お金不足・クレーンの距離', () => {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  const f = g.factory;
  g.money = 100;
  const [i, j] = f.cellOf(3, 3);
  assert.equal(f.canPlace('hopper', i, j).reason, 'お金が足りない');
  g.money = 1e6;
  assert.ok(f.place('conveyor', i, j, 0).ok);
  assert.equal(f.canPlace('conveyor', i, j).ok, false);
  const [pi, pj] = f.cellOf(pile.cx, pile.cz);
  assert.match(f.canPlace('conveyor', pi, pj).reason, /山/);
  const [fi, fj] = f.cellOf(10, 6);
  assert.match(f.canPlace('crane', fi, fj).reason, /遠すぎる/);
  // 自分が立っているマスにはホッパーを置けない
  assert.match(f.canPlace('hopper', i + 2, j, { x: f.cx(i + 2), z: f.cz(j) }).reason, /立って/);
});

test('撤去すると中身は床に落ち、保存則が保たれる。保存→復元も一致する', () => {
  const { pile, g, f, ci, cj } = makeLine();
  for (let t = 0; t < 20; t += 0.1) f.tick(0.1);
  const before = f.count();
  assert.ok(before > 0);
  f.remove(ci + 1, cj); // ホッパーを撤去
  assert.ok(g.invariant().ok);
  const saved = JSON.parse(JSON.stringify(g.toJSON()));
  const g2 = new Game(PileModel.deserialize(pile.serialize()), saved);
  assert.ok(g2.invariant().ok, JSON.stringify(g2.invariant()));
  assert.equal(g2.factory.count(), f.count());
  assert.equal(g2.factory.machines.size, f.machines.size);
});

test('ラインに紛れたちりモンは手で取り出せる。そのまま包装されると誤出荷', () => {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  g.money = 1e6;
  const f = g.factory;
  const [i, j] = f.cellOf(3, 3);
  f.place('hopper', i, j, 0);
  f.place('conveyor', i + 1, j, 0);
  f.place('packer', i + 2, j, 0);
  const hopper = f.get(i, j), belt = f.get(i + 1, j);
  // 山から ちりモン1匹＋しらす を取り出してホッパーへ
  const chiri = pile.chiriList[0].id;
  const c = pile.columnOf(chiri);
  while (!pile.isExposed(chiri)) { pile.remove(pile.start[c] + pile.top[c]); g.shipped++; }
  pile.remove(chiri);
  const shirasu = pile.scrape(-3.6, 0.5, 0.2, 59);
  g.hand = [chiri, ...shirasu];
  g.chiriState.set(chiri, 'held');
  assert.equal(g.releaseToMachine(hopper), 60);
  // ベルトに乗った瞬間に止めて、手で取り出す
  for (let k = 0; k < 20 && !belt.batches.length; k++) f.tick(0.05);
  f.toggle(belt);
  g.upgrades.add('glove1');
  assert.ok(g.pickFromMachine(belt) >= 1);
  assert.equal(g.hand[0], chiri, 'ちりモンが優先して取り出される');
  assert.ok(g.invariant().ok);
  // 戻して流すと誤出荷になる
  f.toggle(belt);
  assert.ok(g.releaseToMachine(hopper) > 0);
  for (let t = 0; t < 10; t += 0.1) f.tick(0.1);
  assert.equal(g.chiriState.get(chiri), 'misshipped');
  assert.ok(g.invariant().ok);
  assert.ok(MACHINES.packer && PACK_SIZE > 0);
});

test('運搬箱：スコップで何度もすくってためられる', () => {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  for (const u of ['glove1', 'glove2', 'scoop', 'box']) g.upgrades.add(u);
  g.tool = 'scoop';
  assert.equal(g.perAction(), 200);
  assert.equal(g.capacity(), 1000);
  for (let k = 0; k < 6; k++) g.pickFromPile({ x: -3.6, y: pile.heightAt(-3.6, k * 0.4 - 1), z: k * 0.4 - 1 }, 0.08);
  assert.equal(g.hand.length, 1000);
  assert.ok(g.invariant().ok);
});
