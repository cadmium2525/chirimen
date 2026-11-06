import * as THREE from 'three';
import './style.css';
import { REACH, LAYOUT, PACK_SIZE, GRAM_PER_FISH, UPGRADES } from './config.js';
import { PileModel } from './pile.js';
import { Game } from './game.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { UI, helpHTML } from './ui.js';
import { buildWorld, drawScaleDisplay } from './world.js';
import { PileView } from './pileView.js';
import { makeHand, makeScoop, makeChirimonMesh, makeShirasuGeometry, makeShirasuMaterial } from './meshes.js';
import { resolvePreset, DynamicResolution, gpuName } from './quality.js';
import { loadWorld, saveWorld, loadDex, saveDex, loadSettings, saveSettings, requestPersist, exportFile, importFile, writeImported, deleteAll } from './save.js';
import { randomSeed } from './rng.js';
import { SPECIES } from './chirimonData.js';
import { sfx, setSound } from './audio.js';
import { FactoryView } from './factoryView.js';
import { BuildScreen } from './buildUI.js';
import { MACHINES, POWER_PANEL, PRIO_NAMES, GAME_VERSION } from './config.js';

const INTERACT_DIST = 2.7;
const ASSIST_R = { low: 0.035, mid: 0.06, high: 0.09 };

// ---------- 基盤 ----------
const settings = loadSettings();
const ui = new UI();
const canvas = document.getElementById('c');
const input = new Input(canvas, ui);
const isTouch = input.touch;
document.body.classList.toggle('touch', isTouch);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#b9c3c8');
scene.fog = new THREE.Fog('#b9c3c8', 18, 40);
const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.02, 60);
camera.rotation.order = 'YXZ';
scene.add(camera);

const gpu = gpuName(renderer);
let autoStep = 0; // 自動画質で重すぎたときに下げた段数
let quality = resolvePreset(settings.quality, isTouch, settings, gpu);
const assistR = () => ASSIST_R[settings.assist === 'auto' ? (isTouch ? 'high' : 'mid') : settings.assist];
input.settings = settings;
const world = buildWorld(scene, quality);
const view = new PileView(scene, quality);
function applyDistance() {
  scene.fog.far = quality.distance;
  scene.fog.near = quality.distance * 0.5;
  camera.far = quality.distance + 6;
  camera.updateProjectionMatrix();
}
applyDistance();
const dynres = new DynamicResolution(renderer, quality);
const fview = new FactoryView(scene);
let obstacles = world.obstacles, obstaclesVersion = -1;
const build = new BuildScreen(() => resume());

let pile = null, game = null, player = null;
let playing = false, paused = true, dirty = false;
let target = { kind: null };
let hudDirty = false, hudT = 0;
let time = 0;

// ---------- 手元の表示 ----------
const handRoot = new THREE.Group();
handRoot.position.set(0.17, -0.19, -0.36);
camera.add(handRoot);
const handHeld = new THREE.InstancedMesh(makeShirasuGeometry(), makeShirasuMaterial(), 80);
handHeld.count = 0;
handHeld.frustumCulled = false;
let handModel = null, handChiri = new THREE.Group();
let handKey = '';
let pickAnim = 0;
let slideT = 0, slideMineT = 0, objT = 0, floorT = 0;

function gloveKind() {
  for (const id of ['glove4', 'glove3', 'glove2', 'glove1']) if (game.has(id)) return id;
  return 'none';
}

function updateHandVisual() {
  const key = game.tool + gloveKind() + game.has('bigscoop');
  if (key !== handKey) {
    handKey = key;
    handRoot.clear();
    handModel = game.tool === 'scoop' ? makeScoop(game.has('bigscoop')) : makeHand(gloveKind());
    handModel.rotation.set(0.35, -0.25, 0);
    handRoot.add(handModel);
    handModel.add(handHeld, handChiri);
  }
  const ids = game.hand;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  let n = 0;
  handChiri.clear();
  const spread = game.tool === 'scoop' ? 0.07 : 0.035;
  ids.forEach((id, i) => {
    const a = i * 2.39996, r = spread * Math.sqrt((i + 0.5) / Math.max(ids.length, 1));
    const lift = 0.016 + Math.floor(i / 25) * 0.004;
    if (pile.isChirimon(id)) {
      const cm = makeChirimonMesh(pile.speciesOf(id));
      cm.scale.multiplyScalar(1.1);
      cm.position.set(Math.cos(a) * r * 0.6, lift + 0.004, Math.sin(a) * r * 0.6 - 0.01);
      handChiri.add(cm);
      return;
    }
    if (n >= 80) return;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * 1.7);
    p.set(Math.cos(a) * r, lift, Math.sin(a) * r - 0.01);
    m.compose(p, q, s);
    handHeld.setMatrixAt(n++, m);
  });
  handHeld.count = n;
  handHeld.instanceMatrix.needsUpdate = true;
}

// ---------- 照準 ----------
const raycaster = new THREE.Raycaster();
const dir = new THREE.Vector3();

function marchPile(o, d, maxT) {
  const step = 0.02;
  let prev = 0;
  for (let t = step; t <= maxT; t += step) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    if (y < -0.01) return null;
    const h = pile.heightAt(x, z);
    if (h > 0.002 && y <= h) {
      let a = prev, b = t;
      for (let i = 0; i < 8; i++) {
        const mdl = (a + b) / 2;
        const yy = o.y + d.y * mdl;
        if (yy <= pile.heightAt(o.x + d.x * mdl, o.z + d.z * mdl)) b = mdl; else a = mdl;
      }
      return { t: b, p: new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b) };
    }
    prev = t;
  }
  return null;
}

function computeTarget() {
  camera.getWorldDirection(dir);
  const o = camera.position;
  let res = { kind: null, dist: Infinity, point: null };
  const ph = marchPile(o, dir, REACH + 1.2);
  if (ph) res = { kind: 'pile', dist: ph.t, point: ph.p };
  raycaster.set(o, dir);
  raycaster.far = 8;
  const hits = raycaster.intersectObjects(world.targets.concat(fview.targets), false);
  if (hits.length && hits[0].distance < res.dist) {
    const u = hits[0].object.userData;
    res = { kind: u.kind, dist: hits[0].distance, point: hits[0].point };
    if (u.kind === 'machine') res.machine = game.factory.get(u.i, u.j);
    if (u.kind === 'machine' && !res.machine) res.kind = null;
  }
  if (dir.y < -0.01) {
    const t = -o.y / dir.y;
    if (t < res.dist && t < 10) res = { kind: 'floor', dist: t, point: new THREE.Vector3(o.x + dir.x * t, 0, o.z + dir.z * t) };
  }
  return res;
}

const K = () => isTouch
  ? { pick: '［つまむ］', rel: '［はなす］', act: '［調べる］' }
  : { pick: '左クリック', rel: '右クリック', act: 'E' };

// ---------- ガイド（目標の場所を示す矢印） ----------
const beacon = new THREE.Group();
{
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 12), new THREE.MeshBasicMaterial({ color: '#ffcf4a' }));
  cone.rotation.x = Math.PI;
  beacon.add(cone);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.012, 6, 24), new THREE.MeshBasicMaterial({ color: '#ffcf4a' }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.18;
  beacon.add(ring);
  beacon.visible = false;
  scene.add(beacon);
}
const guideEl = document.createElement('div');
guideEl.id = 'guide';
guideEl.innerHTML = '<span class="arrow">➤</span><span class="label"></span>';
document.getElementById('hud').appendChild(guideEl);
const _gv = new THREE.Vector3();

/** いま向かうべき場所（なければ null） */
function guideTarget() {
  if (!settings.guide) return null;
  const pileSpot = { x: pile.cx + pile.radius - 0.5, y: 0.7, z: 0, label: 'しらすの山' };
  const scaleSpot = { x: LAYOUT.scale.x, y: 1.05, z: LAYOUT.scale.z, label: '計量機' };
  if (game.heldChirimon().length) return { x: LAYOUT.case.x, y: 1.35, z: LAYOUT.case.z, label: '保護ケース' };
  // まだ一度もちりモンを保護していない人には、近くで露出した最初の1匹だけ教える
  const firstTime = !SPECIES.some((sp) => game.dex[sp.id]?.protected);
  if (firstTime && game.tutorial >= 4) {
    let best = null, bd = 2.6;
    for (const m of view.chiriMeshes.values()) {
      const d = Math.hypot(m.position.x - player.x, m.position.z - player.z);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) return { x: best.position.x, y: best.position.y + 0.12, z: best.position.z, label: '何かいる…！', small: true };
    // まだ露出していなければ、初めての出会いが埋まっている「計量機側の斜面」を示す
    if (game.tutorial === 4) {
      const x = pile.cx + pile.radius * 0.72;
      return { x, y: pile.heightAt(x, 0) + 0.05, z: 0, label: 'このあたりを掘る' };
    }
  }
  const t = game.tutorial;
  if (t === 0) return pileSpot;
  if (t === 1 || t === 2) return game.hand.length || game.scale.length >= PACK_SIZE ? scaleSpot : pileSpot;
  if (t === 3) {
    if (game.money >= UPGRADES[0].price) return { x: LAYOUT.terminal.x, y: 1.5, z: LAYOUT.terminal.z, label: '購入端末' };
    return game.hand.length || game.scale.length >= PACK_SIZE ? scaleSpot : pileSpot;
  }
  return null;
}

function updateGuide() {
  const g = guideTarget();
  const near = g && Math.hypot(g.x - player.x, g.z - player.z) < (g.small ? 0.3 : 1.3);
  beacon.visible = !!g && !near;
  if (!g || near) { guideEl.hidden = true; return; }
  const bob = Math.sin(time * 3) * 0.05;
  beacon.position.set(g.x, g.y + 0.35 + bob, g.z);
  beacon.scale.setScalar(g.small ? 0.45 : 1);
  beacon.rotation.y = time * 1.5;
  // 画面の外なら、画面の端に矢印
  _gv.set(g.x, g.y, g.z).project(camera);
  const behind = _gv.z > 1;
  let x = _gv.x, y = _gv.y;
  if (behind) { x = -x; y = -y; }
  const onScreen = !behind && Math.abs(x) < 0.85 && Math.abs(y) < 0.8;
  guideEl.hidden = onScreen;
  if (onScreen) return;
  const ang = Math.atan2(y, x);
  const k = Math.min(0.85 / Math.abs(Math.cos(ang) || 1e-6), 0.75 / Math.abs(Math.sin(ang) || 1e-6));
  const ex = Math.cos(ang) * k, ey = Math.sin(ang) * k;
  guideEl.style.left = `${(ex * 0.5 + 0.5) * 100}%`;
  guideEl.style.top = `${(-ey * 0.5 + 0.5) * 100}%`;
  guideEl.querySelector('.arrow').style.transform = `rotate(${-ang}rad)`;
  guideEl.querySelector('.label').textContent = g.label;
}

function updatePrompt() {
  const k = K();
  const t = target;
  const holding = game.hand.length > 0;
  const lines = [];
  let cls = '';
  let act = '調べる';
  if (t.kind === 'pile' || t.kind === 'floor') {
    if (t.dist > REACH) {
      if (t.kind === 'pile') lines.push('遠くて届かない');
    } else {
      const floorNear = game.floorItemsNear(t.point);
      if (t.kind === 'pile') {
        const cid = view.chirimonNear(t.point, assistR() + 0.02);
        if (cid != null) {
          const sp = SPECIES[pile.speciesOf(cid)];
          const known = game.dex[sp.id]?.protected;
          const full = game.hand.length >= game.capacity();
          lines.push(full ? `${known ? sp.name : '何かいる…！'}  手がいっぱい：先に ${k.rel} で はなそう` : `${k.pick}: つまむ（${known ? sp.name : '何かいる…！'}）`);
          cls = 'chiri';
        } else if (game.hand.length >= game.capacity()) {
          lines.push(`手がいっぱい（${k.rel}: はなす）`);
        } else {
          lines.push(`${k.pick}: ${floorNear ? '落ちた個体を' : 'しらすを'}つまむ`);
          cls = 'can';
        }
        // 掘った手応えと「気配」（埋まっているちりモンの近さ）
        if (cid == null) {
          const sense = pile.chiriSense(t.point.x, t.point.z);
          const dug = pile.dugAt(t.point.x, t.point.z);
          let line = dug >= 0.002 ? `ここは ${(dug * 100).toFixed(1)}cm 掘った` : '';
          if (sense) {
            const strong = sense.dist < 0.05 && sense.depth < 0.016;
            const where = strong ? '' : senseDir(sense);
            line += `${line ? '　' : ''}${strong ? '……すぐ下に何かいる！' : sense.dist < 0.15 ? `……何かの気配が強い${where}` : `……かすかに何かの気配${where}`}`;
            if (strong) cls = 'chiri';
          }
          if (line) lines.push(line);
        }
      } else if (floorNear) {
        lines.push(`${k.pick}: 落ちている個体をつまむ`);
        cls = 'can';
      }
      if (holding) lines.push(`${k.rel}: ここに置く`);
    }
  } else if (t.kind === 'scale' && t.dist <= INTERACT_DIST) {
    cls = 'can';
    if (holding) lines.push(`${k.rel}: 計量機に入れる`);
    else if (game.scale.length) lines.push(`${k.pick}: 受け皿から取り出す${game.scaleHasChiri() ? '（ちりモン優先）' : ''}`);
    if (game.scale.length >= PACK_SIZE || game.canPackRemainder()) {
      if (game.scaleHasChiri()) { lines.push(`⚠ ちりモン入り！ ${k.act}: それでも包装する`); cls = 'chiri'; }
      else lines.push(`${k.act}: 包装する${game.scale.length < PACK_SIZE ? '（最後の端数）' : ''}`);
      act = '包装';
    }
    else lines.push(`計量機 ${game.scale.length} / ${PACK_SIZE}匹`);
  } else if (t.kind === 'case' && t.dist <= INTERACT_DIST) {
    cls = 'can';
    if (game.heldChirimon().length) lines.push(`${k.rel}: 保護ケースに入れる`);
    lines.push(`${k.act}: 図鑑を見る`);
    act = '図鑑';
  } else if (t.kind === 'terminal' && t.dist <= INTERACT_DIST) {
    cls = 'can';
    lines.push(`${k.act}: 購入端末を使う`);
    act = 'ショップ';
  } else if (t.kind === 'panel' && t.dist <= INTERACT_DIST) {
    lines.push(`受電盤：${POWER_PANEL.output}kW・半径${POWER_PANEL.coverage}mに配電（無料）`);
    lines.push('電柱で電力網を延ばせる。足りなければ発電機を建設');
  } else if (t.kind === 'machine' && t.dist <= INTERACT_DIST) {
    const m = t.machine, f = game.factory;
    const def = MACHINES[m.type];
    const n = f.contents(m).length;
    cls = f.hasChiri(m) ? 'chiri' : 'can';
    const takes = ['conveyor', 'hopper', 'packer', 'sorter'].includes(m.type);
    const dem = def.power != null ? f.demandOf(m) : 0;
    const pw = def.power != null ? `・${+dem.toFixed(2)}kW${m.on && dem < def.power - 1e-9 ? '（待機）' : ''} 優先度${PRIO_NAMES[m.prio]}` : '';
    lines.push(`${def.name}（${m.on ? '稼働中' : '停止中'}${pw}）${n ? ` 中身 ${n}匹` : ''}`);
    const iss = f.issues(m).filter((x) => x !== '停止中');
    if (iss.length) lines.push(`⚠ ${iss.join('／')}`);
    if (holding && takes) lines.push(`${k.rel}: ${def.name}に入れる`);
    if (n && m.type !== 'crane') lines.push(`${k.pick}: 取り出す${f.hasChiri(m) ? '（何かいる…！）' : ''}`);
    lines.push(`${k.act}: ${m.on ? '止める' : '動かす'}`);
    act = m.on ? '停止' : '稼働';
  }
  ui.setPrompt(lines.join('\n'), cls);
  if (isTouch) ui.setActionLabel(act);
}

// ---------- 行動 ----------
function doPick() {
  const t = target;
  if ((t.kind === 'pile' || t.kind === 'floor') && t.dist <= REACH) {
    let n = 0;
    // 照準表示で「何かいる」と出ているちりモンを最優先でつまむ（表示と判定をそろえる）
    const cid = t.kind === 'pile' ? view.chirimonNear(t.point, assistR() + 0.02) : null;
    if (cid == null && game.floorItemsNear(t.point)) n = game.pickFromFloor(t.point);
    if (!n && t.kind === 'pile') n = game.pickFromPile(t.point, assistR(), cid);
    if (!n && game.hand.length < game.capacity()) sfx.deny();
    else if (n) pickAnim = 1;
    return;
  }
  if (t.kind === 'scale' && t.dist <= INTERACT_DIST) {
    if (game.pickFromScale()) pickAnim = 1;
    return;
  }
  if (t.kind === 'machine' && t.dist <= INTERACT_DIST) {
    if (game.pickFromMachine(t.machine)) pickAnim = 1;
  }
}

function doRelease() {
  if (!game.hand.length) return;
  const t = target;
  let n = 0;
  if (t.kind === 'scale' && t.dist <= INTERACT_DIST) n = game.releaseToScale();
  else if (t.kind === 'case' && t.dist <= INTERACT_DIST) n = game.releaseToCase();
  else if (t.kind === 'machine' && t.dist <= INTERACT_DIST) n = game.releaseToMachine(t.machine);
  else if ((t.kind === 'pile' || t.kind === 'floor') && t.dist <= REACH) n = game.releaseToFloor(t.point);
  else {
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    n = game.releaseToFloor({ x: player.x + fx * 0.45, z: player.z + fz * 0.45 });
  }
  if (n) { sfx.drop(); pickAnim = 0.6; }
}

function doInteract() {
  const t = target;
  if (t.dist > INTERACT_DIST) return;
  if (t.kind === 'scale') game.pack();
  if (t.kind === 'terminal') openShop();
  if (t.kind === 'case') openMenu('dex');
  if (t.kind === 'machine') game.factory.toggle(t.machine);
}

function openBuild() {
  pause();
  input.exitLock();
  fview.showRings(true, game.factory.craneReach());
  build.open({ factory: game.factory, pile, player, game, onChange: () => ui.updateHUD(game) });
}

// ---------- ゲームのイベント ----------
function buzz(p) {
  if (isTouch && settings.haptics && navigator.vibrate) { try { navigator.vibrate(p); } catch { /* noop */ } }
}
const tutorialSteps = () => {
  const k = K();
  return [
    `<b>しらすの山</b>に近づき、しらすを狙って <b>${k.pick}</b> でつまむ`,
    `<b>計量機</b>（赤い看板）の受け皿を狙って <b>${k.rel}</b> ではなす`,
    `${PACK_SIZE}匹（${(PACK_SIZE * GRAM_PER_FISH).toFixed(1)}g）たまったら、計量機を狙って <b>${k.act}</b> で包装・出荷`,
    `<b>購入端末</b>で <b>${k.act}</b>。手袋を買って、一度に運べる量を増やそう`,
    `山の<b>ちりモン</b>を探そう。照準の下の「<b>気配</b>」の方へ手で掘る（つまんで ${k.rel} で足元へ）。同じ所ばかり深く掘らず、穴を広げよう。見つけたら<b>保護ケース</b>へ`,
  ];
};

/** 気配の方向を、いま向いている向きを基準に言葉で表す */
function senseDir(sense) {
  if (sense.dist < 0.05) return '（このあたり）';
  const yaw = player.yaw;
  // カメラの前方 (-sin, -cos)、右 (cos, -sin)
  const fwd = -Math.sin(yaw) * sense.dx - Math.cos(yaw) * sense.dz;
  const right = Math.cos(yaw) * sense.dx - Math.sin(yaw) * sense.dz;
  if (Math.abs(right) >= Math.abs(fwd)) return right > 0 ? '（右の方）' : '（左の方）';
  return fwd > 0 ? '（奥の方）' : '（手前の方）';
}

/** 山が崩れたときの砂煙・音と、初めてのときの一度だけの案内（自分で掘った直後の崩れだけ） */
let digSlides = 0;
function collapseFx(dt) {
  slideT -= dt; slideMineT -= dt;
  const ls = pile.lastSlide;
  if (!ls.n) return;
  const x = ls.x / ls.n, z = ls.z / ls.n, y = ls.y / ls.n;
  const d = game.lastDig;
  const mine = d && game.stats.playTime - d.t < 3 && Math.hypot(x - d.x, z - d.z) < 0.8;
  if (mine) digSlides += ls.n; else if (!d || game.stats.playTime - d.t >= 3) digSlides = 0;
  if (!game.stats.sawCollapse && mine && digSlides >= 12) {
    game.stats.sawCollapse = true;
    ui.toast('穴のまわりが崩れた。穴は広げながら掘ろう', '', 'collapse');
  }
  if ((ls.n < 30 && !(mine && ls.n >= 5)) || (mine ? slideMineT : slideT) > 0) return;
  const dist = Math.hypot(x - player.x, z - player.z);
  // クレーンなどの崩れは、煙と音を控えめに（間隔をあけ、音も小さく）
  if (mine) slideMineT = 0.22; else slideT = 4 + Math.random() * 3;
  const v = Math.min(1, Math.log10(ls.n + 1) / 4);
  view.puff(x, y, z, mine ? v : v * 0.6);
  if (dist < 8) sfx.slide(Math.max(0.25, v) * Math.max(0.3, 1 - dist / 8), mine ? 1 : 0.35);
}

const NECK_HINT = {
  packer: '包装機が頭打ち：包装機を増やしてラインを分けると速くなる',
  hopper: 'ホッパーが頭打ち：クレーンごとにホッパー（とライン）を分けると速くなる',
  sorter: '選別機が頭打ち：選別機を増やしてラインを分けると速くなる',
  crane: 'クレーンが頭打ち：クレーンを足すと速くなる（包装機1台に2台まで）',
  power: '電力が足りない：発電機を足すと速くなる（クレーンを足すと、もっと足りなくなる）',
};

/** 工場の行：次の改良、または頭打ちの案内（クレーンがあるときだけ） */
function factoryLines() {
  const f = game.factory;
  if (![...f.machines.values()].some((m) => m.type === 'crane')) return '';
  if (pile.removedCount >= pile.total) return ''; // 山が片付いたら工場の案内はいらない
  const est = f.estimateRate();
  // 止めた発電機があれば、まず動かす（電力が足りない・届いていないの原因になる）
  if (est.genOff && (est.bottleneck.power || !est.lines)) return `<br><span class="small muted">止まっている発電機がある：発電機を狙って ${isTouch ? '［調べる］' : '<b>E</b>'} で動かそう</span>`;
  if (est.bottleneck.power) return `<br><span class="small muted">いまのライン：毎秒 約${Math.round(est.rate)}匹。${NECK_HINT.power}</span>`;
  const fac = game.nextFactoryUpgrade();
  if (fac && fac.gain >= 1) return `<br><span class="small muted">次の改良：${fac.u.name}（${fac.u.price.toLocaleString()}円）：いまのラインで 約+${Math.round(fac.gain)}円/秒</span>`;
  if (!est.lines && est.starved) return '<br><span class="small muted">クレーンの届く範囲にしらすがない：撤去（払った分が戻る）して、山の残っている場所へ移そう</span>';
  if (!est.lines) return '<br><span class="small muted">クレーンのしらすが出荷まで届いていない（建設画面で ⚠ を確認）</span>';
  const b = est.bottleneck;
  const neck = Object.keys(b).sort((x, y) => b[y] - b[x])[0];
  let line = `<br><span class="small muted">いまのライン：毎秒 約${Math.round(est.rate)}匹。${NECK_HINT[neck]}</span>`;
  if (fac) line += `<br><span class="small muted fac-extra">次の改良：${fac.u.name}（${fac.u.price.toLocaleString()}円）：クレーンの届く範囲が広がる</span>`;
  return line;
}

/** 山を処理し尽くしたのに、まだどこかに残っているとき（最後の端数の案内） */
function restLine() {
  if (pile.removedCount < pile.total || game.isCleared()) return '';
  const where = [];
  if (game.hand.length) where.push(`手に ${game.hand.length}匹`);
  if (game.floor.length) where.push(`床に ${game.floor.length}匹`);
  if (game.factory.count()) where.push(`設備の中に ${game.factory.count()}匹（狙って取り出す）`);
  const chiri = game.heldChirimon().length || game.floor.some((f) => pile.isChirimon(f.id))
    || game.scaleHasChiri() || [...game.factory.machines.values()].some((m) => game.factory.hasChiri(m));
  const tail = chiri ? 'ちりモンは保護ケースへ、しらすは計量機に入れて包装すると完了' : '全部計量機に入れて包装すると完了';
  return `<span class="small"><b>山は片付いた！</b> 残り：${where.join('・') || `計量機に ${game.scale.length}匹`} → ${tail}</span><br>`;
}

function refreshObjective() {
  const steps = tutorialSteps();
  if (game.tutorial < steps.length) {
    // とても小さい画面では、チュートリアル中の工場の行は隠す（目標の文を切らないように）
    ui.setObjective(`<span class="small muted">目標 ${game.tutorial + 1}/${steps.length}</span><br>${steps[game.tutorial]}` + factoryLines().replace(/<br><span class="small muted/g, '<br class="fac-tut"><span class="small muted fac-tut'));
    return;
  }
  const found = SPECIES.filter((sp) => game.dex[sp.id]?.protected).length;
  const tool = game.nextTool();
  const buildHint = !game.factory.machines.size && game.money >= 600
    ? `<br><span class="small">${isTouch ? '［建設］' : '<b>B</b>'}で建設画面。ホッパー→コンベア→計量機／包装機とつなげば自動で出荷できる</span>` : '';
  const toolLine = tool ? `<br><span class="small muted">次の道具：${tool.u.name}（${tool.u.price.toLocaleString()}円）</span>` : '';
  ui.setObjective(restLine() + `図鑑 <b>${found}/${SPECIES.length}</b> 種` + factoryLines() + toolLine + buildHint);
}

function advanceTutorial(step) {
  if (game.tutorial !== step) return;
  game.tutorial++;
  // 先に済ませている目標は飛ばす
  if (game.tutorial === 3 && game.upgrades.size) game.tutorial++;
  if (game.tutorial === 4 && game.stats.protected) game.tutorial++;
  refreshObjective();
}

function wireGame() {
  game.on((type, p) => {
    switch (type) {
      case 'picked': game.tool === 'scoop' ? sfx.scoop() : sfx.pick(); buzz(8); advanceTutorial(0); break;
      case 'chiriPicked': {
        const names = p.ids.map((id) => {
          const sp = SPECIES[pile.speciesOf(id)];
          return game.dex[sp.id]?.protected ? sp.name : '見たことのない生き物';
        });
        ui.toast(`ちりモンをつまんだ！（${[...new Set(names)].join('、')}）保護ケースへ運ぼう`, 'find');
        sfx.find(); buzz([20, 40, 20]);
        break;
      }
      case 'chiriInScale': ui.toast('⚠ ちりモンが計量機に入った！ 包装する前に受け皿から取り出そう', 'bad'); sfx.warn(); break;
      case 'protected':
        ui.toast(`「${p.species.name}」を保護した！${p.first ? '（図鑑に新登録）' : ''}`, 'find');
        sfx.find(); buzz([20, 40, 20]);
        advanceTutorial(4);
        if (game.tutorial < 5 && game.tutorial >= 0) { /* 途中でも保護はOK */ }
        break;
      case 'misshipped': ui.toast(`見逃し…「${p.species.name}」がパックに入って出荷されてしまった`, 'bad'); sfx.warn(); break;
      case 'packed':
        ui.toast(`${p.count}パック出荷  +${p.money}円`, 'good');
        sfx.pack();
        view.updatePacks(game.packs);
        advanceTutorial(2);
        break;
      case 'released': if (p.to === 'scale') advanceTutorial(1); break;
      case 'machinePacked': hudDirty = true; break;
      case 'machineGrab':
        if (p.chiri && game.has('loupe')) { ui.toast('ルーペ：クレーンが何かをつかんだ…！ ラインを確かめよう', 'find'); sfx.find(); buzz([20, 40, 20]); }
        break;
      case 'sorterCaught': ui.toast('選別機がちりモンを回収した！ 回収箱から取り出して保護ケースへ', 'find'); sfx.find(); buzz([20, 40, 20]); break;
      case 'machineToggle': ui.toast(`${MACHINES[p.machine.type].name}を${p.machine.on ? '動かした' : '止めた'}`); break;
      case 'bought': ui.toast(`「${p.upgrade.name}」を手に入れた！`, 'good'); sfx.buy(); advanceTutorial(3); refreshObjective(); break;
      case 'toast': ui.toast(p.text, p.cls || '', p.key); sfx.deny(); break;
      case 'tool': updateHandVisual(); break;
      case 'scale':
        view.updateScale(game, world);
        drawScaleDisplay(world, game.scale.length, PACK_SIZE, GRAM_PER_FISH, game.scaleHasChiri(), game.has('autopack'));
        break;
      case 'changed':
        dirty = true;
        if (game.tutorial >= 5) refreshObjective();
        ui.updateHUD(game);
        view.updateFloor(game);
        view.updateCase(game, world);
        updateHandVisual();
        break;
      default:
    }
  });
}

function refreshAll() {
  ui.updateHUD(game);
  view.updateFloor(game);
  view.updateScale(game, world);
  view.updateCase(game, world);
  view.updatePacks(game.packs);
  drawScaleDisplay(world, game.scale.length, PACK_SIZE, GRAM_PER_FISH, game.scaleHasChiri(), game.has('autopack'));
  handKey = '';
  updateHandVisual();
  refreshObjective();
}

// ---------- 開始・保存 ----------
function setupGame(saved, dex) {
  if (saved) {
    pile = PileModel.deserialize(saved.pile);
    game = new Game(pile, saved.game, dex);
    player = new Player(LAYOUT.spawn);
    Object.assign(player, saved.player);
  } else {
    pile = new PileModel(randomSeed());
    game = new Game(pile, null, dex);
    player = new Player(LAYOUT.spawn);
  }
  view.setPile(pile);
  game.factory.setStaticBoxes(world.obstacles);
  fview.version = -1;
  wireGame();
  refreshAll();
  pendingNotes.push(...(game.factory.loadNotes || []));
  // P4 アップデート：これまで電力なしで動いていた設備のために、発電機1台分を一度だけ支給
  if (saved && game.factory.machines.size && !game.stats.p4gift) {
    game.stats.p4gift = true;
    game.money += MACHINES.generator.price;
    pendingNotes.push(`アップデート：設備を動かすのに電力が必要になりました。発電機1台分（${MACHINES.generator.price.toLocaleString()}円）を支給します`);
  }
}
let pendingNotes = [];
let persistent = false;

let saveBlocked = false;     // 新しい版のセーブがあるときは上書きしない
let lastSaved = 0, saveFailT = 0, saving = null;
async function persist({ manual = false } = {}) {
  if (!game || saveBlocked) {
    if (manual && saveBlocked) ui.toast('新しい版のセーブがあるため、この版では保存しません（再読み込みしてください）', 'bad');
    return false;
  }
  if (saving) return saving;
  dirty = false;
  saving = (async () => {
    try {
      lastSaved = await saveWorld({ pile, game, player });
      await saveDex(game.dex);
      if (manual) ui.toast('セーブしました', 'good');
      return true;
    } catch (e) {
      dirty = true;
      console.warn(e);
      if (manual || Date.now() - saveFailT > 60000) {
        saveFailT = Date.now();
        ui.toast('セーブに失敗しました（ストレージの空き・プライベートモードを確認してください）', 'bad');
      }
      return false;
    } finally { saving = null; }
  })();
  return saving;
}

setInterval(() => { if (dirty && playing) persist(); }, 15000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || !playing) return;
  // アプリの切り替え・画面ロック：一時停止して保存
  if (!paused) openMenu();
  persist();
});
addEventListener('pagehide', () => { if (playing) persist(); });

// スマホで多い「描画の中断」からの復帰
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  persist();
  pause();
  const d = document.createElement('div');
  d.className = 'screen';
  d.innerHTML = '<div class="panel title-panel"><h2>描画が中断されました</h2><p class="muted">端末のメモリ不足などで画面の描画が止まりました。進行状況は保存しました。</p><div class="row"><button class="primary">再読み込み</button></div></div>';
  d.querySelector('button').addEventListener('click', () => location.reload());
  document.getElementById('app').appendChild(d);
});

function beginPlay() {
  sfx.unlock();
  requestPersist().then((ok) => { persistent = ok; });
  playing = true;
  document.getElementById('start').hidden = true;
  ui.el.hud.hidden = false;
  if (isTouch) ui.el.touch.hidden = false;
  document.body.classList.add('playing');
  resume();
  for (const n of pendingNotes) ui.toast(n, 'good');
  pendingNotes = [];
}

function resume() {
  fview.showRings(false);
  ui.closeMenu();
  ui.closeShop();
  paused = false;
  input.enabled = true;
  input.requestLock();
}

function pause() {
  paused = true;
  input.enabled = false;
  input.holdPick = false;
}

function openMenu(tab) {
  pause();
  input.exitLock();
  ui.openMenu(tab, {
    game, settings, onSetting, onNewPile, touch: isTouch,
    saveInfo: () => ({ lastSaved, persistent, blocked: saveBlocked }),
    onSaveNow: () => persist({ manual: true }),
    onExport: doExport,
    onImport: doImport,
    onWipe: doWipe,
    fullscreen: canFullscreen() ? toggleFullscreen : null,
    qualityInfo: () => ({ label: quality.label, gpu, autoStep }),
  });
}

function openShop() {
  pause();
  input.exitLock();
  ui.openShop(game, (id) => game.buy(id));
}

// ---------- 短期クリア：1山を処理し尽くした（企画書 1.3） ----------
function showClear() {
  game.clearShown = true;
  pause();
  input.exitLock();
  const r = game.pileResult();
  const fmtT = (t) => `${Math.floor(t / 3600)}時間${Math.floor((t % 3600) / 60)}分`;
  const d = document.createElement('div');
  d.className = 'screen';
  d.innerHTML = `<div class="panel title-panel"><h1 style="font-size:1.8em">山をすべて処理した！</h1>
    <p class="muted">シード ${pile.seed} の 10,000,000匹</p>
    <table class="stats">
      <tr><td>処理時間</td><td>${fmtT(r.time)}</td></tr>
      <tr><td>出荷</td><td>${r.packs.toLocaleString()} パック（${r.sales.toLocaleString()}円）</td></tr>
      <tr><td>ちりモン発見（保護）</td><td>${r.protected} / ${r.total}</td></tr>
      <tr><td>見逃し（誤出荷）</td><td>${r.misshipped}</td></tr>
    </table>
    <div class="row"><button class="primary" data-a="new">新しい山へ</button><button data-a="close">このまま眺める</button></div></div>`;
  d.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    d.remove();
    if (a === 'new') onNewPile(); else resume();
  });
  document.getElementById('app').appendChild(d);
  sfx.find();
}

// ---------- エラー時（進行状況を守る） ----------
let errorShown = false;
function onFatal(e) {
  console.error(e);
  if (errorShown || !playing) return;
  errorShown = true;
  persist();
  ui.toast('エラーが発生しました。進行状況は保存しました。おかしな動きがあれば再読み込みしてください', 'bad');
}
addEventListener('error', (e) => onFatal(e.error || e.message));
addEventListener('unhandledrejection', (e) => onFatal(e.reason));

// ---------- セーブの書き出し・読み込み（PC ⇄ スマホ） ----------
async function doExport() {
  try {
    const { blob, name } = await exportFile({ pile, game, player }, game.dex);
    const file = typeof File !== 'undefined' ? new File([blob], name, { type: blob.type }) : null;
    // スマホは共有シート（ファイルに保存・AirDrop など）を優先
    if (isTouch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'しらすの山 セーブ' }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    ui.toast(`書き出しました（${Math.ceil(blob.size / 1024)}KB）`, 'good');
  } catch (e) { ui.toast(`書き出せませんでした：${e.message}`, 'bad'); }
}

function doImport() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.gz,.json,application/gzip,application/json,application/octet-stream';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const { world: w, dex } = await importFile(f);
      if (!confirm(`このセーブを読み込みますか？\n所持金 ${Math.floor(w.game.money).toLocaleString()}円 / 保存日時 ${new Date(w.savedAt).toLocaleString()}\n（いまの進行状況は上書きされます）`)) return;
      await writeImported(w, dex);
      location.reload();
    } catch (e) { ui.toast(e.message, 'bad'); }
  });
  inp.click();
}

async function doWipe() {
  if (!confirm('この端末のセーブと図鑑をすべて消去しますか？（元に戻せません）')) return;
  saveBlocked = true;
  await deleteAll();
  location.reload();
}

function canFullscreen() { return !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen); }
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      const el = document.documentElement;
      await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen());
      try { await screen.orientation.lock('landscape'); } catch { /* 対応していない端末 */ }
    }
  } catch (e) { ui.toast('全画面にできませんでした'); }
}

function onNewPile() {
  pile = new PileModel(randomSeed());
  game.startNewPile(pile);
  view.setPile(pile);
  Object.assign(player, { x: LAYOUT.spawn.x, z: LAYOUT.spawn.z, yaw: LAYOUT.spawn.yaw, pitch: -0.25 });
  refreshAll();
  persist();
  ui.toast(`新しい山（シード ${pile.seed}）が運び込まれた`, 'good');
  resume();
}

input.onLockChange = (locked) => {
  if (!locked && playing && !paused) openMenu();
};

ui.bindMenu({ resume, closeShop: resume });
ui.btnMenu.addEventListener('click', () => openMenu());
addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && playing && !paused && isTouch) openMenu();
});

// ---------- 設定 ----------
function applySettings() {
  document.body.dataset.btn = settings.btnSize;
  ui.el.perf.hidden = !settings.showFps;
  camera.fov = settings.fov;
  camera.updateProjectionMatrix();
  document.documentElement.style.setProperty('--fs', { s: '14px', m: '16px', l: '19px' }[settings.textSize]);
  document.body.classList.toggle('left-handed', settings.layout === 'left');
  setSound(settings.sound === true || settings.sound === 'true');
}

function applyQuality() {
  quality = resolvePreset(settings.quality, isTouch, settings, gpu, settings.quality === 'auto' ? autoStep : 0);
  applyDistance();
  view.setQuality(quality);
  dynres.set(quality);
  world.sun.castShadow = quality.shadows;
  if (world.sun.shadow.map && world.sun.shadow.mapSize.x !== quality.shadowSize) {
    world.sun.shadow.map.dispose();
    world.sun.shadow.map = null;
  }
  world.sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
}

function onSetting(key, value) {
  if (value === 'true') value = true;
  if (value === 'false') value = false;
  settings[key] = value;
  saveSettings(settings);
  applySettings();
  if (key === 'quality' || key.startsWith('q')) { if (key === 'quality') autoStep = 0; applyQuality(); }
}

// ---------- 図鑑のサムネイル ----------
function makeThumbs() {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(200, 150, false);
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight('#ffffff', '#445', 2.2));
  const dl = new THREE.DirectionalLight('#fff', 1.5);
  dl.position.set(1, 2, 1);
  sc.add(dl);
  const cam = new THREE.PerspectiveCamera(35, 4 / 3, 0.01, 10);
  const out = SPECIES.map((sp, i) => {
    const m = makeChirimonMesh(i);
    m.scale.setScalar(1);
    sc.add(m);
    cam.position.set(0.2, 1.05, 1.2);
    cam.lookAt(0, 0.1, 0);
    r.render(sc, cam);
    const url = r.domElement.toDataURL();
    sc.remove(m);
    return url;
  });
  r.dispose();
  r.forceContextLoss?.();
  return out;
}

// ---------- ループ ----------
let last = performance.now();
let perfT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  if (game && playing && !paused) {
    const inp = input.poll(dt);
    const sens = (isTouch ? settings.touchSens : settings.sens) * 0.0022;
    player.yaw -= inp.look.x * sens;
    player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - inp.look.y * sens));
    if (obstaclesVersion !== game.factory.version) {
      obstaclesVersion = game.factory.version;
      obstacles = world.obstacles.concat(game.factory.obstacles());
    }
    player.update(dt, inp.move, game.speedMul(), pile, obstacles);
    camera.position.set(player.x, player.eyeY(settings.bob), player.z);
    camera.rotation.set(player.pitch, player.yaw, 0);
    target = computeTarget();
    for (const a of inp.actions) {
      if (a === 'pick') doPick();
      else if (a === 'release') doRelease();
      else if (a === 'interact') doInteract();
      else if (a === 'tool1') game.setTool('hand');
      else if (a === 'tool2') game.setTool('scoop');
      else if (a === 'toolToggle') game.setTool(game.tool === 'hand' ? 'scoop' : 'hand');
      else if (a === 'dex') openMenu('dex');
      else if (a === 'build') openBuild();
      if (paused) break;
      target = computeTarget();
    }
    updatePrompt();
    updateGuide();
    game.pileTime = (game.pileTime || 0) + dt;
    game.stats.playTime += dt;
    game.factory.tick(dt);
    collapseFx(dt);
    floorT -= dt;
    if (floorT <= 0) { floorT = 0.5; view.updateFloor(game); } // 床が多いときの、間引いた高さの更新
    objT += dt;
    if (objT > 1.5) { objT = 0; refreshObjective(); }
    if (hudDirty) {
      hudT += dt;
      if (hudT > 0.25) { hudT = 0; hudDirty = false; ui.updateHUD(game); view.updatePacks(game.packs); }
    }
  }
  if (game) {
    const aid = game.has('loupe') || settings.aid === 'on' || (settings.aid === 'auto' && quality.aid);
    view.update(camera.position, game, time, aid);
    fview.update(game.factory, pile, paused ? 0 : dt, time);
  }
  // 手の動き
  pickAnim = Math.max(0, pickAnim - dt * 4);
  const sway = settings.bob && player ? Math.sin(player.bob) * 0.006 : 0;
  handRoot.position.set(0.17 + sway, -0.19 - pickAnim * 0.05 + Math.abs(sway) * 0.5, -0.36 - pickAnim * 0.08);
  renderer.render(scene, camera);
  if (dynres.tick(dt) && playing && !paused && settings.quality === 'auto' && quality.key !== 'low') {
    autoStep++;
    applyQuality();
    ui.toast(`動作が重いため、画質を「${quality.label}」に下げました（設定で変更できます）`);
  }
  perfT += dt;
  if (perfT > 0.5 && view.stats) {
    perfT = 0;
    if (game) ui.setPower(game.factory.machines.size ? game.factory.powerSummary() : null);
    if (game && playing && !paused && game.isCleared() && !game.clearShown) showClear();
    ui.el.perf.textContent = `${quality.label} | ${dynres.fps ? Math.round(dynres.fps) : '--'}fps | 近景${view.stats.near} 中景${view.stats.mid} | 解像度×${dynres.scale.toFixed(2)}`;
  }
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ---------- 起動 ----------
async function boot() {
  applySettings();
  const [loaded, dex] = await Promise.all([loadWorld(), loadDex()]);
  const saved = loaded.world;
  if (loaded.tooNew) {
    saveBlocked = true;
    document.getElementById('startInfo').textContent = '新しい版のゲームで保存されたデータがあります。ページを再読み込みして最新版にしてください（この版では上書きしません）。';
  }
  if (saved && loaded.fromBackup) pendingNotes.push('最新のセーブが読めなかったため、ひとつ前のセーブから復元しました');
  if (saved && loaded.repaired) pendingNotes.push(`セーブの個体数が合わなかったため、自動で修復しました（${loaded.repaired}）。修復前のデータも保管しています`);
  if (!saved && loaded.problems?.length && !loaded.tooNew) {
    document.getElementById('startInfo').textContent = `セーブを読み込めませんでした（${loaded.problems[0]}）。元のデータは別に保管してあります。設定の「書き出し」で保存したファイルがあれば読み込めます。`;
  }
  const startHelp = document.getElementById('startHelp');
  startHelp.innerHTML = helpHTML(isTouch);
  document.getElementById('version').textContent = `v${GAME_VERSION}`;
  const btnC = document.getElementById('btnContinue');
  const btnN = document.getElementById('btnNew');
  if (saved) {
    btnC.hidden = false;
    btnN.textContent = 'はじめから';
    const found = SPECIES.filter((sp) => dex?.[sp.id]?.protected).length;
    document.getElementById('startInfo').textContent = `前回の続き：所持金 ${Math.floor(saved.game.money).toLocaleString()}円 / 図鑑 ${found}/${SPECIES.length}種`;
  }
  // 背景として山を表示しておく
  setupGame(saved, dex || {});
  camera.position.set(player.x, player.eyeY(false), player.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  try { ui.thumbs = makeThumbs(); } catch (e) { console.warn(e); }

  btnC.addEventListener('click', () => beginPlay());
  btnN.addEventListener('click', () => {
    if (saved && !confirm('はじめからやり直しますか？（図鑑の記録は残ります）')) return;
    pendingNotes = [];
    setupGame(null, game.dex);
    persist();
    beginPlay();
  });
  // デバッグ・自動テスト用
  window.__game = { get game() { return game; }, get pile() { return pile; }, get player() { return player; }, view, camera, input, ui };
}

requestAnimationFrame(frame);
boot();
