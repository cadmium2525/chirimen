// P6 の合格条件「初見で出荷し、ちりモンを回収できる」を、初めての人の動きをまねた自動プレイで確かめる。
// 計量機側の裾から手の届く所をつまみ（ときどき場所を変える）、計量機まで歩いて往復し、買えるようになった手袋から順に買う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PileModel } from '../src/pile.js';
import { Game } from '../src/game.js';
import { mulberry32 } from '../src/rng.js';
import { UPGRADES, LAYOUT } from '../src/config.js';

const ORDER = ['glove1', 'glove2', 'autopack', 'glove3', 'boots', 'glove4'];

function play(seed, limitSec = 3600) {
  const pile = new PileModel(seed);
  const g = new Game(pile);
  const rng = mulberry32(seed);
  const standX = pile.cx + pile.radius + 0.3;
  let standZ = (rng() - 0.5) * 2;
  let t = 0, firstPack = null, trips = 0;
  while (t < limitSec) {
    // 人は同じ所ばかり掘らず、ときどき斜面の別の場所へ移る
    if (++trips % 15 === 0) standZ = (rng() - 0.5) * 3.2;
    const ax = standX - 1.0 - rng() * 0.6, az = standZ + (rng() - 0.5) * 1.0;
    const n = g.pickFromPile({ x: ax, y: pile.heightAt(ax, az), z: az }, 0.06);
    t += 0.6;
    if (!n) { standZ = (rng() - 0.5) * 3; continue; }
    // 手の中にちりモン → 保護ケースへ運べば回収完了
    if (g.heldChirimon().length) {
      t += Math.hypot(LAYOUT.case.x - standX, LAYOUT.case.z - standZ) / 3.2;
      g.releaseToCase();
      return { found: t, firstPack, game: g };
    }
    t += 2 * Math.hypot(LAYOUT.scale.x - standX, LAYOUT.scale.z - standZ) / (3.2 * g.speedMul()) + 0.6;
    g.releaseToScale();
    if (g.pack(true) && firstPack == null) firstPack = t;
    for (const id of ORDER) {
      const u = UPGRADES.find((x) => x.id === id);
      if (!g.has(id) && g.canBuy(u)) { g.buy(id); t += 8; }
    }
    // 手の届く所に露出したら、照準を合わせてつまむ
    for (const { id } of pile.chiriList) {
      if (pile.isRemoved(id) || !pile.isExposed(id)) continue;
      const tf = pile.visualTransform(id);
      if (Math.hypot(tf.x - standX, tf.z - standZ) < 2.3 && tf.x > pile.cx) {
        g.releaseToScale();
        g.pickFromPile({ x: tf.x, y: tf.y, z: tf.z }, 0.05);
        t += 1.5;
        if (g.heldChirimon().length) {
          t += Math.hypot(LAYOUT.case.x - standX, LAYOUT.case.z - standZ) / 3.2;
          g.releaseToCase();
          return { found: t, firstPack, game: g };
        }
        break;
      }
    }
  }
  return { found: null, firstPack, game: g };
}

test('初見のプレイ：数分で出荷でき、1時間以内に必ずちりモンを回収できる（すぐには見つからない）', () => {
  const times = [];
  for (let k = 1; k <= 16; k++) {
    const r = play(k * 104729);
    assert.ok(r.firstPack != null && r.firstPack < 180, `seed ${k}: 最初の出荷 ${r.firstPack}s`);
    assert.ok(r.found != null, `seed ${k}: 60分以内にちりモンを回収できなかった`);
    assert.equal(r.game.stats.protected, 1);
    assert.ok(r.game.invariant().ok);
    times.push(r.found);
  }
  times.sort((a, b) => a - b);
  console.log(`初めてのちりモン回収：最短 ${(times[0] / 60).toFixed(1)}分 / 中央値 ${(times[times.length >> 1] / 60).toFixed(1)}分 / 最長 ${(times[times.length - 1] / 60).toFixed(1)}分`);
  const median = times[times.length >> 1];
  assert.ok(times[0] > 120, `早すぎる発見 ${times[0]}s`);
  assert.ok(median > 300 && median < 1500, `中央値 ${median}s`);
});

test('短期クリア：山を処理し尽くすと成績（処理時間・出荷・発見・見逃し）がまとまる', () => {
  const pile = new PileModel(99, { total: 200000 });
  const g = new Game(pile);
  g.upgrades.add('glove4');
  g.pileTime = 600;
  assert.equal(g.isCleared(), false);
  // ちりモンは1匹だけ保護、残りはそのまま出荷（見逃し）
  const keep = pile.chiriList[0].id;
  assert.ok(keep != null);
  for (let c = 0; c < pile.nCols; c++) {
    while (pile.top[c] < pile.count(c)) {
      const id = pile.start[c] + pile.top[c];
      pile.remove(id);
      g.hand.push(id);
      if (pile.isChirimon(id)) g.chiriState.set(id, 'held');
      if (id === keep) g.releaseToCase();
      if (g.hand.length >= 50) g.releaseToScale();
    }
  }
  g.releaseToScale();
  // ちりモンが計量機に入っていると、自動包装は止まり、手での包装は1回目は警告だけ
  g.pack(true);
  if (g.scaleHasChiri()) assert.equal(g.pack(), 0);
  g.pack();
  // 山が空になったら、最後の端数（20匹未満）もパックにできる
  assert.ok(g.scale.length === 0 || g.canPackRemainder());
  if (g.scale.length) g.pack();
  assert.equal(g.scale.length, 0);
  assert.ok(g.isCleared());
  const r = g.pileResult();
  assert.equal(r.time, 600);
  assert.equal(r.protected, 1);
  assert.equal(r.misshipped + r.protected <= r.total, true);
  assert.ok(r.packs > 0 && r.sales <= r.packs * 20 && r.sales > (r.packs - 1) * 20);
  assert.ok(g.invariant().ok);
});
