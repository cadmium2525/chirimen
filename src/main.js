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
import { resolvePreset, DynamicResolution } from './quality.js';
import { loadWorld, saveWorld, loadDex, saveDex, loadSettings, saveSettings } from './save.js';
import { randomSeed } from './rng.js';
import { SPECIES } from './chirimonData.js';
import { sfx, setSound } from './audio.js';

const INTERACT_DIST = 2.7;
const ASSIST = { low: 0.035, mid: 0.06, high: 0.09 };

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

let quality = resolvePreset(settings.quality, isTouch);
const world = buildWorld(scene, quality);
const view = new PileView(scene, quality);
const dynres = new DynamicResolution(renderer, quality);

let pile = null, game = null, player = null;
let playing = false, paused = true, dirty = false;
let target = { kind: null };
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
  const hits = raycaster.intersectObjects(world.targets, false);
  if (hits.length && hits[0].distance < res.dist) res = { kind: hits[0].object.userData.kind, dist: hits[0].distance, point: hits[0].point };
  if (dir.y < -0.01) {
    const t = -o.y / dir.y;
    if (t < res.dist && t < 10) res = { kind: 'floor', dist: t, point: new THREE.Vector3(o.x + dir.x * t, 0, o.z + dir.z * t) };
  }
  return res;
}

const K = () => isTouch
  ? { pick: '［つまむ］', rel: '［はなす］', act: '［調べる］' }
  : { pick: '左クリック', rel: '右クリック', act: 'E' };

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
        const cid = view.chirimonNear(t.point, ASSIST[settings.assist] + 0.02);
        if (cid != null) {
          const sp = SPECIES[pile.speciesOf(cid)];
          const known = game.dex[sp.id]?.protected;
          lines.push(`${k.pick}: つまむ（${known ? sp.name : '何かいる…！'}）`);
          cls = 'chiri';
        } else {
          lines.push(`${k.pick}: ${floorNear ? '落ちた個体を' : 'しらすを'}つまむ`);
          cls = 'can';
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
    if (game.scale.length >= PACK_SIZE) { lines.push(`${k.act}: 包装する`); act = '包装'; }
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
  }
  ui.setPrompt(lines.join('\n'), cls);
  if (isTouch) ui.setActionLabel(act);
}

// ---------- 行動 ----------
function doPick() {
  const t = target;
  if ((t.kind === 'pile' || t.kind === 'floor') && t.dist <= REACH) {
    let n = 0;
    if (game.floorItemsNear(t.point)) n = game.pickFromFloor(t.point);
    if (!n && t.kind === 'pile') n = game.pickFromPile(t.point, ASSIST[settings.assist]);
    if (!n && game.hand.length < game.capacity()) sfx.deny();
    else if (n) pickAnim = 1;
    return;
  }
  if (t.kind === 'scale' && t.dist <= INTERACT_DIST) {
    if (game.pickFromScale()) pickAnim = 1;
    return;
  }
}

function doRelease() {
  if (!game.hand.length) return;
  const t = target;
  let n = 0;
  if (t.kind === 'scale' && t.dist <= INTERACT_DIST) n = game.releaseToScale();
  else if (t.kind === 'case' && t.dist <= INTERACT_DIST) n = game.releaseToCase();
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
}

// ---------- ゲームのイベント ----------
const tutorialSteps = () => {
  const k = K();
  return [
    `<b>しらすの山</b>に近づき、しらすを狙って <b>${k.pick}</b> でつまむ`,
    `<b>計量機</b>（赤い看板）の受け皿を狙って <b>${k.rel}</b> ではなす`,
    `${PACK_SIZE}匹（${(PACK_SIZE * GRAM_PER_FISH).toFixed(1)}g）たまったら、計量機を狙って <b>${k.act}</b> で包装・出荷`,
    `<b>購入端末</b>で <b>${k.act}</b>。手袋を買って、一度に運べる量を増やそう`,
    '山を削ると、埋まっていた<b>ちりモン</b>が姿を現す。つまんで<b>保護ケース</b>へ運ぼう',
  ];
};

function refreshObjective() {
  const steps = tutorialSteps();
  if (game.tutorial < steps.length) ui.setObjective(`<span class="small muted">目標 ${game.tutorial + 1}/${steps.length}</span><br>${steps[game.tutorial]}`);
  else {
    const found = SPECIES.filter((sp) => game.dex[sp.id]?.protected).length;
    const next = UPGRADES.find((u) => !game.has(u.id) && (!u.requires || game.has(u.requires)));
    ui.setObjective(`図鑑 <b>${found}/${SPECIES.length}</b> 種` + (next ? `<br><span class="small muted">次の道具：${next.name}（${next.price.toLocaleString()}円）</span>` : ''));
  }
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
      case 'picked': game.tool === 'scoop' ? sfx.scoop() : sfx.pick(); advanceTutorial(0); break;
      case 'chiriPicked': {
        const names = p.ids.map((id) => {
          const sp = SPECIES[pile.speciesOf(id)];
          return game.dex[sp.id]?.protected ? sp.name : '見たことのない生き物';
        });
        ui.toast(`ちりモンをつまんだ！（${[...new Set(names)].join('、')}）保護ケースへ運ぼう`, 'find');
        sfx.find();
        break;
      }
      case 'chiriInScale': ui.toast('⚠ ちりモンが計量機に入った！ 包装する前に受け皿から取り出そう', 'bad'); sfx.warn(); break;
      case 'protected':
        ui.toast(`「${p.species.name}」を保護した！${p.first ? '（図鑑に新登録）' : ''}`, 'find');
        sfx.find();
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
      case 'bought': ui.toast(`「${p.upgrade.name}」を手に入れた！`, 'good'); sfx.buy(); advanceTutorial(3); refreshObjective(); break;
      case 'toast': ui.toast(p.text); sfx.deny(); break;
      case 'tool': updateHandVisual(); break;
      case 'scale':
        view.updateScale(game, world);
        drawScaleDisplay(world, game.scale.length, PACK_SIZE, GRAM_PER_FISH, game.scaleHasChiri(), game.has('autopack'));
        break;
      case 'changed':
        dirty = true;
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
  wireGame();
  refreshAll();
}

async function persist() {
  if (!game) return;
  dirty = false;
  await Promise.all([saveWorld({ pile, game, player }), saveDex(game.dex)]);
}

setInterval(() => { if (dirty && playing) persist(); }, 15000);
addEventListener('visibilitychange', () => { if (document.hidden && playing) persist(); });
addEventListener('pagehide', () => { if (playing) persist(); });

function beginPlay() {
  sfx.unlock();
  playing = true;
  document.getElementById('start').hidden = true;
  ui.el.hud.hidden = false;
  if (isTouch) ui.el.touch.hidden = false;
  document.body.classList.add('playing');
  resume();
}

function resume() {
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
  ui.openMenu(tab, { game, settings, onSetting, onNewPile, touch: isTouch });
}

function openShop() {
  pause();
  input.exitLock();
  ui.openShop(game, (id) => game.buy(id));
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
  camera.fov = settings.fov;
  camera.updateProjectionMatrix();
  document.documentElement.style.setProperty('--fs', { s: '14px', m: '16px', l: '19px' }[settings.textSize]);
  document.body.classList.toggle('left-handed', settings.layout === 'left');
  setSound(settings.sound === true || settings.sound === 'true');
}

function applyQuality() {
  quality = resolvePreset(settings.quality, isTouch);
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
  if (key === 'quality') applyQuality();
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
    player.update(dt, inp.move, game.speedMul(), pile, world.obstacles);
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
      if (paused) break;
      target = computeTarget();
    }
    updatePrompt();
    game.stats.playTime += dt;
  }
  if (game) {
    const aid = game.has('loupe') || settings.aid === 'on' || (settings.aid === 'auto' && quality.aid);
    view.update(camera.position, game, time, aid);
  }
  // 手の動き
  pickAnim = Math.max(0, pickAnim - dt * 4);
  const sway = settings.bob && player ? Math.sin(player.bob) * 0.006 : 0;
  handRoot.position.set(0.17 + sway, -0.19 - pickAnim * 0.05 + Math.abs(sway) * 0.5, -0.36 - pickAnim * 0.08);
  renderer.render(scene, camera);
  dynres.tick(dt);
  perfT += dt;
  if (perfT > 0.5 && view.stats) {
    perfT = 0;
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
  const [saved, dex] = await Promise.all([loadWorld(), loadDex()]);
  const startHelp = document.getElementById('startHelp');
  startHelp.innerHTML = helpHTML(isTouch);
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
    setupGame(null, game.dex);
    persist();
    beginPlay();
  });
  // デバッグ・自動テスト用
  window.__game = { get game() { return game; }, get pile() { return pile; }, get player() { return player; }, view, camera, input, ui };
}

requestAnimationFrame(frame);
boot();
