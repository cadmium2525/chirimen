import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PileModel } from '../src/pile.js';
import { Game } from '../src/game.js';
import { MACHINES, PACK_SIZE, PACK_PRICE, LAYOUT } from '../src/config.js';
import { hash01 } from '../src/rng.js';

const SEED = 4242;

function newGame() {
  const pile = new PileModel(SEED);
  const g = new Game(pile);
  g.money = 1e6;
  return { pile, g, f: g.factory };
}

/** クレーン → ホッパー → コンベア×3 → 包装機(1×2)、発電機つき */
function makeLine({ generator = true } = {}) {
  const { pile, g, f } = newGame();
  const [ci, cj] = f.cellOf(-1.9, 0.1);
  const r = [
    f.place('crane', ci, cj, 0),
    f.place('hopper', ci + 1, cj, 0),
    f.place('conveyor', ci + 2, cj, 0),
    f.place('conveyor', ci + 3, cj, 0),
    f.place('conveyor', ci + 4, cj, 0),
    f.place('packer', ci + 5, cj, 0),
  ];
  if (generator) r.push(f.place('generator', ci + 2, cj + 2, 0));
  for (const x of r) assert.ok(x.ok, x.reason);
  return { pile, g, f, ci, cj };
}

function run(f, sec) { for (let t = 0; t < sec; t += 0.1) f.tick(0.1); }

/** ちりモンを掘り出して手に持たせる */
function digChiri(g, id) {
  const pile = g.pile, c = pile.columnOf(id);
  while (!pile.isExposed(id)) { pile.remove(pile.start[c] + pile.top[c]); g.shipped++; }
  pile.remove(id);
  return id;
}

test('P3：クレーンが山の実在IDを取り除き、ラインを通って包装・出荷される', () => {
  const { pile, g, f } = makeLine();
  const money0 = g.money;
  for (let t = 0; t < 120; t += 0.1) {
    f.tick(0.1);
    if (Math.round(t * 10) % 50 === 0) assert.ok(g.invariant().ok, JSON.stringify(g.invariant()));
  }
  assert.ok(pile.removedCount > 1000, `removed ${pile.removedCount}`);
  assert.ok(g.packs > 10, `packs ${g.packs}`);
  // 売上から燃料費を引いた分だけ増えている
  const fuel = g.stats.fuel;
  assert.ok(fuel > 0);
  assert.ok(Math.abs((g.money - money0) - (g.packs * PACK_PRICE - fuel)) < 1e-6);
  assert.ok(g.invariant().ok);
});

test('P4：電源がない設備は動かない。発電機を止めるとラインが止まる', () => {
  const { pile, f } = makeLine({ generator: false });
  run(f, 20);
  assert.equal(pile.removedCount, 0, '電源なしのクレーンは動かない');
  const crane = [...f.machines.values()].find((m) => m.type === 'crane');
  assert.ok(f.issues(crane).includes('電源なし'));
  const line = makeLine();
  run(line.f, 10);
  const gen = [...line.f.machines.values()].find((m) => m.type === 'generator');
  line.f.toggle(gen);
  run(line.f, 2);
  const removed = line.pile.removedCount;
  run(line.f, 20);
  assert.equal(line.pile.removedCount, removed, '発電機を止めるとクレーンも止まる');
});

test('P4：電力不足では優先度の低い設備から止まり、境目の設備は減速する', () => {
  const { g, f } = newGame();
  // 受電盤（3kW）の近く：ホッパー → コンベア → 選別機 → コンベア → 包装機　需要 4.2kW
  const [i, j] = f.cellOf(LAYOUT.scale.x - 3.2, -6.5);
  for (const [type, k] of [['hopper', 0], ['conveyor', 1], ['sorter', 2], ['conveyor', 3], ['packer', 4]]) {
    const r = f.place(type, i + k, j, 0);
    assert.ok(r.ok, `${type}: ${r.reason}`);
  }
  f.tick(0.1);
  const by = (t) => [...f.machines.values()].filter((m) => m.type === t);
  const [hopper] = by('hopper'), [sorter] = by('sorter'), [packer] = by('packer');
  assert.ok(f.nets.some((n) => n.panel && n.consumers.length === 5), '5台とも受電盤の電力網');
  assert.equal(sorter.power, 1, '優先度「高」で先に設置した選別機は満額');
  assert.ok(packer.power > 0 && packer.power < 1, `包装機は減速 ${packer.power}`);
  assert.equal(hopper.power, 0, '優先度「中」のホッパーは停止');
  assert.ok(f.powerSummary().short);
  // ホッパーを止めて投入物を入れても動かない → 優先度を上げると動く
  f.cyclePrio(hopper); f.cyclePrio(hopper); // 中→低→高
  assert.equal(hopper.prio, 2);
  f.tick(0.1);
  assert.equal(hopper.power, 1);
  // 発電機を追加すると全部動く
  assert.ok(f.place('generator', i + 1, j + 3, 0).ok);
  f.tick(0.1);
  for (const m of f.machines.values()) if (m.type !== 'generator') assert.equal(m.power, 1, m.type);
  assert.ok(g.invariant().ok);
});

test('P4：電柱で電力網を延ばせる', () => {
  const { f } = newGame();
  const [i, j] = f.cellOf(1.0, -1.6); // 受電盤から約7m：範囲外
  assert.ok(f.place('hopper', i, j, 0).ok);
  f.tick(0.1);
  const hopper = f.get(i, j);
  assert.equal(hopper.net, null);
  // 受電盤(1.0,-8.55) から 4.5m ごとに電柱
  assert.ok(f.place('pole', ...f.cellOf(1.0, -4.2), 0).ok);
  f.tick(0.1);
  assert.notEqual(hopper.net, null, '電柱の配電範囲に入った');
  assert.equal(hopper.power, 1);
});

test('P4：占有マス・出荷口・発電機の通路・人の通路の決まり', () => {
  const { g, f } = newGame();
  const S = LAYOUT.scale;
  f.setStaticBoxes([{ minX: S.x - 0.4, maxX: S.x + 0.4, minZ: S.z - 0.4, maxZ: S.z + 0.4 }]);
  const [i, j] = f.cellOf(3, 4);
  assert.ok(f.place('packer', i, j, 0).ok);
  assert.equal(f.get(i, j), f.get(i + 1, j), '包装機は2マス');
  assert.match(f.canPlace('conveyor', i + 2, j).reason, /出荷口|ほかの/);
  assert.equal(f.canPlace('conveyor', i + 3, j).ok, true);
  // 出荷口をふさぐ位置には新しい包装機を置けない
  assert.match(f.canPlace('packer', i, j + 1, null, { dir: 3 }).reason, /出荷口|ほかの/);
  // 発電機のまわり1マス
  assert.ok(f.place('generator', i + 5, j, 0).ok);
  assert.match(f.canPlace('conveyor', i + 7, j).reason, /通路/);
  assert.match(f.canPlace('hopper', i + 4, j + 1).reason, /通路/);
  // 計量機のまわりを全部ふさぐことはできない
  const [si, sj] = f.cellOf(S.x, S.z);
  const around = [];
  for (let a = si - 2; a <= si + 2; a++) for (let b = sj - 2; b <= sj + 2; b++) if (!f._staticAt(a, b) && f._staticAt(a, b, 0.5)) around.push([a, b]);
  let refused = null;
  for (const [a, b] of around) {
    const r = f.place('hopper', a, b, 0);
    if (!r.ok) { refused = r.reason; break; }
  }
  assert.match(refused, /通路/);
  assert.ok(g.invariant().ok);
});

test('P4：ベルトは入口の面からしか入らない（包装機の横からは入らない）', () => {
  const { f } = newGame();
  const [i, j] = f.cellOf(1.0, -6.0);
  f.place('hopper', i, j - 1, 1);            // ↓ 向き
  f.place('conveyor', i, j, 1);              // ↓
  f.place('packer', i, j + 1, 0);            // → 向き。ベルトは横（上）から当たる
  const belt = f.get(i, j), packer = f.get(i, j + 1);
  f.get(i, j - 1).buffer.push(...Array.from({ length: 60 }, (_, k) => k));
  run(f, 3);
  assert.equal(packer.buffer.length, 0, '横からは入らない');
  assert.ok(f.issues(belt).includes('出口の先に受け取る設備がない'));
  // 向きを合わせる（後ろの面から入る）
  f.rotate(i, j + 1); // → から ↓
  assert.equal(packer.dir, 1);
  run(f, 3);
  assert.ok(packer.buffer.length > 0 || packer.packs > 0, '後ろからは入る');
});

test('P4：選別機は検出率に応じてちりモンを回収箱へ分ける（決定論的）', () => {
  const { pile, g, f } = newGame();
  const [i, j] = f.cellOf(LAYOUT.scale.x - 3.2, -6.5);
  f.place('hopper', i, j, 0); f.place('sorter', i + 1, j, 0); f.place('conveyor', i + 2, j, 0); f.place('packer', i + 3, j, 0);
  f.place('generator', i + 1, j + 2, 0);
  const caughtId = pile.chiriList.find(({ id }) => hash01(pile.seed, id, 91) < MACHINES.sorter.detect).id;
  const missedId = pile.chiriList.find(({ id }) => hash01(pile.seed, id, 91) >= MACHINES.sorter.detect).id;
  digChiri(g, caughtId); digChiri(g, missedId);
  const shirasu = pile.scrape(-3.6, 0.5, 0.3, 80);
  g.hand = [caughtId, missedId, ...shirasu];
  g.releaseToMachine(f.get(i, j));
  run(f, 15);
  const sorter = f.get(i + 1, j);
  assert.deepEqual(sorter.bin, [caughtId]);
  assert.equal(g.chiriState.get(missedId), 'misshipped', '見落とされた方は誤出荷');
  // 回収箱からは手で取り出して保護できる
  g.upgrades.add('glove1');
  assert.ok(g.pickFromMachine(sorter) >= 1);
  assert.equal(g.hand[0], caughtId);
  g.releaseToCase();
  assert.equal(g.chiriState.get(caughtId), 'protected');
  assert.ok(g.invariant().ok, JSON.stringify(g.invariant()));
});

test('撤去すると中身は床に落ち、保存則が保たれる。保存→復元も一致する', () => {
  const { pile, g, f, ci, cj } = makeLine();
  run(f, 20);
  assert.ok(f.count() > 0);
  f.remove(ci + 1, cj); // ホッパーを撤去
  f.remove(ci + 6, cj); // 包装機（2マス目を指定しても撤去できる）
  assert.ok(g.invariant().ok);
  const saved = JSON.parse(JSON.stringify(g.toJSON()));
  const g2 = new Game(PileModel.deserialize(pile.serialize()), saved);
  assert.ok(g2.invariant().ok, JSON.stringify(g2.invariant()));
  assert.equal(g2.factory.count(), f.count());
  assert.equal(g2.factory.machines.size, f.machines.size);
  assert.equal(g2.factory.occ.size, f.occ.size);
});

test('ラインに紛れたちりモンは手で取り出せる。そのまま包装されると誤出荷', () => {
  const { pile, g, f } = newGame();
  const [i, j] = f.cellOf(LAYOUT.scale.x - 3.2, -6.5);
  f.place('hopper', i, j, 0);
  f.place('conveyor', i + 1, j, 0);
  f.place('packer', i + 2, j, 0);
  const hopper = f.get(i, j), belt = f.get(i + 1, j);
  const chiri = digChiri(g, pile.chiriList[0].id);
  const shirasu = pile.scrape(-3.6, 0.5, 0.2, 59);
  g.hand = [chiri, ...shirasu];
  g.chiriState.set(chiri, 'held');
  assert.equal(g.releaseToMachine(hopper), 60);
  for (let k = 0; k < 40 && !belt.batches.length; k++) f.tick(0.05);
  f.toggle(belt);
  g.upgrades.add('glove1');
  assert.ok(g.pickFromMachine(belt) >= 1);
  assert.equal(g.hand[0], chiri, 'ちりモンが優先して取り出される');
  assert.ok(g.invariant().ok);
  f.toggle(belt);
  assert.ok(g.releaseToMachine(hopper) > 0);
  run(f, 10);
  assert.equal(g.chiriState.get(chiri), 'misshipped');
  assert.ok(g.invariant().ok);
  assert.ok(PACK_SIZE > 0);
});

test('旧版の1マス包装機は、2マス目が空いていればそのまま、埋まっていれば撤去・返金', () => {
  const { pile, g, f } = newGame();
  const [i, j] = f.cellOf(3, 4);
  const old = { nextId: 3, machines: [
    { id: 1, type: 'packer', i, j, dir: 0, on: true, buffer: [] },
    { id: 2, type: 'conveyor', i: i + 1, j, dir: 0, on: true, batches: [] },
  ] };
  const money = g.money;
  const g2 = new Game(pile, { ...g.toJSON(), money, factory: old });
  assert.equal(g2.factory.machines.size, 1);
  assert.equal([...g2.factory.machines.values()][0].type, 'conveyor', '1マスの設備を残し、大きくなった包装機を撤去');
  assert.equal(g2.money, money + MACHINES.packer.price);
  assert.equal(g2.factory.loadNotes.length, 1);
  void f;
});

test('運搬箱：スコップで何度もすくってためられる', () => {
  const { pile, g } = newGame();
  for (const u of ['glove1', 'glove2', 'scoop', 'box']) g.upgrades.add(u);
  g.tool = 'scoop';
  assert.equal(g.perAction(), 200);
  assert.equal(g.capacity(), 1000);
  for (let k = 0; k < 6; k++) g.pickFromPile({ x: -3.6, y: pile.heightAt(-3.6, k * 0.4 - 1), z: k * 0.4 - 1 }, 0.08);
  assert.equal(g.hand.length, 1000);
  assert.ok(g.invariant().ok);
});
