import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PileModel } from '../src/pile.js';
import { Game } from '../src/game.js';
import { MACHINES, PACK_SIZE, PACK_PRICE, LAYOUT, UPGRADES, CARRY } from '../src/config.js';
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

test('P4：電力不足では優先度の低い設備から減速・停止し、同じ優先度はそろって減速する', () => {
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
  // 既定の優先度：搬送（ホッパー・コンベア）と選別機は「高」、包装機は「中」
  assert.equal(sorter.power, 1);
  assert.equal(hopper.power, 1, '搬送が止まってラインが詰まらない');
  for (const b of by('conveyor')) assert.equal(b.power, 1);
  assert.ok(packer.power > 0 && packer.power < 1, `包装機は減速 ${packer.power}`);
  assert.ok(f.powerSummary().short);
  // 包装機を「低」にすると停止（それより上で使い切る場合）、「高」にすると全部が同じ割合で減速
  f.cyclePrio(packer); // 中→低
  assert.equal(packer.prio, 0);
  f.tick(0.1);
  assert.ok(packer.power < 0.25);
  f.cyclePrio(packer); // 低→高
  assert.equal(packer.prio, 2);
  f.tick(0.1);
  const r = 3 / 4.2;
  for (const m of f.machines.values()) assert.ok(Math.abs(m.power - r) < 1e-6, `${m.type} ${m.power}`);
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
  assert.equal(g.perAction(), 100);
  assert.equal(g.capacity(), 300);
  for (let k = 0; k < 4; k++) g.pickFromPile({ x: -3.6, y: pile.heightAt(-3.6, k * 0.4 - 1), z: k * 0.4 - 1 }, 0.08);
  assert.equal(g.hand.length, 300);
  assert.ok(g.invariant().ok);
  // たくさん持つと足が遅くなる（50匹までは普通）
  assert.ok(g.carryMul() < 0.9 && g.carryMul() > CARRY.min);
  assert.equal(g.carryMul(50), 1);
  assert.ok(Math.abs(g.carryMul(800) - CARRY.min) < 1e-9);
});

test('コンベアは計量機の東西南北どの面からでも納品できる', () => {
  const { g, f } = newGame();
  const S = LAYOUT.scale;
  // 計量機の本体に重なるマスの外側すぐのマスから、本体へ向けて置く
  const sides = [[S.x - 0.75, S.z + 0.15, 0], [S.x + 0.85, S.z + 0.15, 2], [S.x + 0.05, S.z - 0.75, 1], [S.x + 0.05, S.z + 0.85, 3]];
  for (const [x, z, dir] of sides) {
    const [i, j] = f.cellOf(x, z);
    const r = f.place('conveyor', i, j, dir);
    assert.ok(r.ok, `${x},${z}: ${r.reason}`);
    const m = f.get(i, j);
    assert.ok(f.outputTarget(m), `向き ${dir} の面から入らない`);
  }
  // 実際に運ばれて計量機に入る
  assert.ok(f.place('generator', ...f.cellOf(S.x - 2, S.z + 2), 0).ok);
  const [i, j] = f.cellOf(S.x - 0.75, S.z + 0.15);
  const belt = f.get(i, j);
  const ids = g.pile.scrape(-3.6, 0.5, 0.2, 10);
  assert.equal(f.insertFromHand(belt, ids), 10);
  run(f, 10);
  assert.equal(g.scale.length, 10);
  assert.ok(g.invariant().ok);
});

test('自動包装は計量機にちりモンがいる間は止まり、取り出すと再開する', () => {
  const { pile, g } = newGame();
  g.upgrades.add('autopack');
  g.upgrades.add('glove4');
  const chiri = digChiri(g, pile.chiriList[0].id);
  g.hand = [chiri, ...pile.scrape(-3.6, 0.5, 0.3, 29)];
  g.chiriState.set(chiri, 'held');
  g.releaseToScale();
  assert.equal(g.packs, 0, 'ちりモン入りは自動で包装しない');
  assert.equal(g.chiriState.get(chiri), 'scale');
  assert.equal(g.pickFromScale(), 1);
  assert.equal(g.hand[0], chiri);
  assert.equal(g.packs, 1, '取り出すと残りが包装される');
  assert.ok(g.invariant().ok);
});

test('設備の間に1マス空けた通路は、人が実際に通り抜けられる', async () => {
  const { Player } = await import('../src/player.js');
  const { g, f } = newGame();
  const [i, j] = f.cellOf(6, 3);
  assert.ok(f.place('hopper', i, j, 0).ok);
  assert.ok(f.place('hopper', i + 2, j, 0).ok);
  const p = new Player({ x: f.cx(i + 1), z: f.cz(j) + 1.5, yaw: 0 });
  const obs = f.obstacles();
  // 通路の真ん中を、手前から奥へ歩く
  let blocked = false;
  for (let z = f.cz(j) + 1; z > f.cz(j) - 1; z -= 0.05) if (!p._free(f.cx(i + 1), z, g.pile, obs)) blocked = true;
  assert.ok(!blocked, '1マスの隙間を通れない');
});

test('経済：クレーン1台のラインは手作業の上限より稼ぎ、燃料費は売上の1割前後、所持金は整数のまま', () => {
  const { pile, g, f } = makeLine();
  const m0 = g.money, T = 300;
  run(f, T);
  const gross = (g.packs * PACK_PRICE) / T, fuel = g.stats.fuel / T, net = (g.money - m0) / T;
  assert.ok(net >= 65, `ライン純益 ${net.toFixed(1)}円/秒`);
  assert.ok(fuel / gross > 0.05 && fuel / gross < 0.15, `燃料比 ${(fuel / gross).toFixed(3)}`);
  assert.ok(Number.isInteger(g.money), `money ${g.money}`);
  assert.ok(g.invariant().ok);
  // 手作業の上限（台車＋大スコップで1往復 最短約6秒）はライン1本より小さい
  const cart = UPGRADES.find((u) => u.id === 'cart'), big = UPGRADES.find((u) => u.id === 'bigscoop');
  const v = 3.2 * 1.35, d = 6.5;
  const trip = d / v + d / (v * g.carryMul(cart.holdCap)) + Math.ceil(cart.holdCap / big.scoopCap) * 0.22 + 1.0;
  assert.ok(cart.holdCap / trip < net, `手作業上限 ${(cart.holdCap / trip).toFixed(1)}円/秒`);
  void pile;
});

test('経済：クレーンは低い柱も最後までつかむ。「次の道具」はスコップ→大スコップ→運搬箱→台車の順', () => {
  const { pile, f } = newGame();
  const x = pile.cx + pile.radius - 0.2;
  const t = f._craneTarget(x, 0, 0.06);
  assert.ok(t && t.h < 0.02, '高さ2cm未満の柱も対象になる');
  const order = UPGRADES.map((u) => u.id);
  assert.ok(order.indexOf('scoop') < order.indexOf('bigscoop') && order.indexOf('bigscoop') < order.indexOf('box') && order.indexOf('box') < order.indexOf('cart'));
});

test('経済：クレーン・発電機は台数ごとに値段が上がり、クレーンの撤去は全額戻る', () => {
  const { g, f } = makeLine();
  const p2 = f.priceOf('crane');
  assert.equal(p2, Math.round(MACHINES.crane.price * MACHINES.crane.priceGrowth / 100) * 100);
  assert.ok(f.priceOf('generator') > MACHINES.generator.price);
  assert.equal(f.priceOf('conveyor'), MACHINES.conveyor.price);
  const crane = [...f.machines.values()].find((m) => m.type === 'crane');
  const money = g.money;
  f.remove(crane.i, crane.j);
  assert.equal(g.money, money + MACHINES.crane.price);
  assert.equal(f.priceOf('crane'), MACHINES.crane.price);
});

test('所持金0でラインを完成させても、燃料を後払いして動き出す', () => {
  const { g, f } = makeLine();
  g.money = 0;
  run(f, 60);
  assert.ok(g.packs > 50, `packs ${g.packs}`);
  assert.ok(g.money > 0 && Number.isInteger(g.money));
  assert.ok((f.fuelDebt || 0) < 1);
  assert.ok(g.invariant().ok);
});

test('届く範囲が空のクレーンは待機電力になり、建設画面に理由が出る', () => {
  const { pile, f } = makeLine();
  const crane = [...f.machines.values()].find((m) => m.type === 'crane');
  for (const c of pile.colsInRadius(f.cx(crane.i), f.cz(crane.j), f.craneReach())) {
    while (pile.top[c] < pile.count(c)) pile.remove(pile.start[c] + pile.top[c]);
  }
  run(f, 10);
  assert.ok(crane.starved);
  assert.ok(f.issues(crane).some((x) => x.includes('届く範囲にしらすがない')));
  assert.ok(f.demandOf(crane) < 1);
  assert.equal(f.reachCount(crane.i, crane.j), 0);
});

test('工場の改良はクレーンを置くと買え、ラインの能力が上がる', () => {
  const base = makeLine();
  run(base.f, 120);
  const up = makeLine();
  assert.ok(!new Game(new PileModel(SEED)).unlocked(UPGRADES.find((u) => u.id === 'fastcrane')), 'クレーンがないと買えない');
  for (const id of ['longarm', 'fastpacker', 'fastcrane', 'bigclaw']) assert.ok(up.g.buy(id), id);
  assert.ok(up.f.craneReach() > MACHINES.crane.reach && up.f.packInterval() < 0.15);
  run(up.f, 120);
  assert.ok(up.g.packs > base.g.packs * 1.6, `${up.g.packs} vs ${base.g.packs}`);
  assert.ok(up.g.invariant().ok);
});
