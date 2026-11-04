// 作業場（企画書 2.1）：しらす置き場・計量機・完成パック集積場所・保護ケース・端末・拡張用の空き床
import * as THREE from 'three';
import { ROOM, LAYOUT, PILE, POWER_PANEL } from './config.js';
import { makeFloorTexture, makeLabel, makeCanvas } from './meshes.js';

export function buildWorld(scene, quality) {
  const obstacles = [];   // {minX,maxX,minZ,maxZ}
  const targets = [];     // 照準で狙える物体（userData.kind）
  const W = ROOM.maxX - ROOM.minX, D = ROOM.maxZ - ROOM.minZ;

  // --- 光
  const hemi = new THREE.HemisphereLight('#fffaf0', '#6d6a63', 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.position.set(-2, 9, 4);
  sun.target.position.set(-1, 0, 0);
  scene.add(sun, sun.target);
  const sc = sun.shadow.camera;
  sc.left = -13; sc.right = 13; sc.top = 10; sc.bottom = -10; sc.near = 1; sc.far = 20;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;

  // --- 床・壁・天井
  const floorTex = makeFloorTexture();
  floorTex.repeat.set(W / 2, D / 2);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshLambertMaterial({ map: floorTex }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((ROOM.minX + ROOM.maxX) / 2, 0, (ROOM.minZ + ROOM.maxZ) / 2);
  floor.receiveShadow = true;
  floor.userData.kind = 'floor';
  scene.add(floor);

  const wallMat = new THREE.MeshLambertMaterial({ color: '#d9dcd6' });
  const wainscot = new THREE.MeshLambertMaterial({ color: '#5f7d8c' });
  const addWall = (w, x, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, ROOM.height), wallMat);
    m.position.set(x, ROOM.height / 2, z);
    m.rotation.y = ry;
    scene.add(m);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.0), wainscot);
    b.position.set(x, 0.5, z);
    b.rotation.y = ry;
    b.translateZ(0.01);
    scene.add(b);
  };
  addWall(W, 0, ROOM.minZ, 0);
  addWall(W, 0, ROOM.maxZ, Math.PI);
  addWall(D, ROOM.minX, 0, Math.PI / 2);
  addWall(D, ROOM.maxX, 0, -Math.PI / 2);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ color: '#c8cbc6' }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = ROOM.height;
  scene.add(ceil);
  const lampMat = new THREE.MeshBasicMaterial({ color: '#fffef6' });
  for (let x = -9; x <= 9; x += 4.5) {
    for (const z of [-4.5, 0, 4.5]) {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.3), lampMat);
      l.rotation.x = Math.PI / 2;
      l.position.set(x, ROOM.height - 0.01, z);
      scene.add(l);
    }
  }

  // --- しらす置き場（ブルーシート）
  const tarp = new THREE.Mesh(new THREE.CircleGeometry(PILE.radius + 0.5, 48), new THREE.MeshLambertMaterial({ color: '#2f6fb3' }));
  tarp.rotation.x = -Math.PI / 2;
  tarp.position.set(PILE.cx, 0.003, PILE.cz);
  tarp.receiveShadow = true;
  scene.add(tarp);
  const pileSign = makeLabel('しらす置き場', { w: 1.4, h: 0.35, sub: '10,000,000匹' });
  pileSign.position.set(PILE.cx, 3.2, PILE.cz + 0.0);
  pileSign.rotation.y = Math.PI / 2;
  pileSign.position.x = PILE.cx + 0.2;
  scene.add(pileSign);

  // 通路の線
  const lineMat = new THREE.MeshBasicMaterial({ color: '#e7c23a' });
  const addLine = (x, z, w, d) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.004, z);
    scene.add(m);
  };
  addLine(3.5, 2.4, 13, 0.06);
  addLine(3.5, -3.6, 13, 0.06);

  // --- 計量機
  const S = LAYOUT.scale;
  const scaleGroup = new THREE.Group();
  scaleGroup.position.set(S.x, 0, S.z);
  scene.add(scaleGroup);
  const steel = new THREE.MeshLambertMaterial({ color: '#c3c9cf' });
  const dark = new THREE.MeshLambertMaterial({ color: '#4a5258' });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), dark);
  base.position.y = 0.4;
  base.castShadow = base.receiveShadow = true;
  scaleGroup.add(base);
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 0.6), steel);
  tray.position.y = 0.84;
  tray.castShadow = tray.receiveShadow = true;
  scaleGroup.add(tray);
  for (const [w, d, x, z] of [[0.7, 0.01, 0, 0.3], [0.7, 0.01, 0, -0.3], [0.01, 0.6, 0.35, 0], [0.01, 0.6, -0.35, 0]]) {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.01, 0.06, d + 0.01), steel);
    rim.position.set(x, 0.89, z);
    scaleGroup.add(rim);
  }
  // 表示パネル（プレイヤーが来る -X 側を向く）
  const dispCanvas = makeCanvas(512, 256);
  const dispTex = new THREE.CanvasTexture(dispCanvas);
  dispTex.colorSpace = THREE.SRGBColorSpace;
  const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.275), new THREE.MeshBasicMaterial({ map: dispTex }));
  disp.position.set(-0.41, 0.6, 0);
  disp.rotation.y = -Math.PI / 2;
  scaleGroup.add(disp);
  const trayTarget = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.3, 0.75), new THREE.MeshBasicMaterial({ visible: false }));
  trayTarget.position.y = 0.9;
  trayTarget.userData.kind = 'scale';
  scaleGroup.add(trayTarget);
  const baseTarget = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.8, 0.82), new THREE.MeshBasicMaterial({ visible: false }));
  baseTarget.position.y = 0.4;
  baseTarget.userData.kind = 'scale';
  scaleGroup.add(baseTarget);
  targets.push(trayTarget, baseTarget);
  obstacles.push({ minX: S.x - 0.4, maxX: S.x + 0.4, minZ: S.z - 0.4, maxZ: S.z + 0.4 });
  const scaleSign = makeLabel('計量機', { w: 0.9, h: 0.26, bg: '#7a2e2e' });
  scaleSign.position.set(S.x, 2.25, S.z);
  scaleSign.rotation.y = -Math.PI / 2;
  scene.add(scaleSign);

  // --- 完成パック集積場所（棚）
  const Sh = LAYOUT.shelf;
  const shelf = new THREE.Group();
  shelf.position.set(Sh.x, 0, Sh.z);
  scene.add(shelf);
  const rackMat = new THREE.MeshLambertMaterial({ color: '#6b7a86' });
  for (let i = 0; i < 4; i++) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.03, 1.6), rackMat);
    board.position.y = 0.15 + i * 0.45;
    board.castShadow = board.receiveShadow = true;
    shelf.add(board);
  }
  for (const x of [-0.48, 0.48]) for (const z of [-0.78, 0.78]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.6, 0.04), rackMat);
    post.position.set(x, 0.8, z);
    shelf.add(post);
  }
  obstacles.push({ minX: Sh.x - 0.5, maxX: Sh.x + 0.5, minZ: Sh.z - 0.8, maxZ: Sh.z + 0.8 });
  const shelfSign = makeLabel('完成パック', { w: 1.0, h: 0.26, bg: '#2d5a3a' });
  shelfSign.position.set(Sh.x - 0.52, 1.95, Sh.z);
  shelfSign.rotation.y = -Math.PI / 2;
  scene.add(shelfSign);

  // --- 保護ケース
  const C = LAYOUT.case;
  const caseGroup = new THREE.Group();
  caseGroup.position.set(C.x, 0, C.z);
  scene.add(caseGroup);
  const table = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 0.8), new THREE.MeshLambertMaterial({ color: '#8b6a48' }));
  table.position.y = 0.4;
  table.castShadow = table.receiveShadow = true;
  caseGroup.add(table);
  const floorOfCase = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, 0.6), new THREE.MeshLambertMaterial({ color: '#2a3b4f' }));
  floorOfCase.position.y = 0.81;
  caseGroup.add(floorOfCase);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.4, 0.6),
    new THREE.MeshLambertMaterial({ color: '#bfe6ff', transparent: true, opacity: 0.18, depthWrite: false }),
  );
  glass.position.y = 1.02;
  caseGroup.add(glass);
  const caseTarget = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.3, 0.8), new THREE.MeshBasicMaterial({ visible: false }));
  caseTarget.position.y = 0.65;
  caseTarget.userData.kind = 'case';
  caseGroup.add(caseTarget);
  targets.push(caseTarget);
  obstacles.push({ minX: C.x - 0.7, maxX: C.x + 0.7, minZ: C.z - 0.4, maxZ: C.z + 0.4 });
  const caseSign = makeLabel('保護ケース', { w: 1.1, h: 0.3, bg: '#335f8a', sub: 'ちりモンはここへ' });
  caseSign.position.set(C.x, 1.65, C.z - 0.41);
  caseSign.rotation.y = Math.PI;
  scene.add(caseSign);
  const caseSign2 = caseSign.clone();
  caseSign2.rotation.y = 0;
  caseSign2.position.z = C.z + 0.41;
  scene.add(caseSign2);

  // --- 端末（ショップ）
  const T = LAYOUT.terminal;
  const term = new THREE.Group();
  term.position.set(T.x, 0, T.z);
  scene.add(term);
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.2, 0.4), dark);
  pillar.position.y = 0.6;
  pillar.castShadow = true;
  term.add(pillar);
  const screen = makeLabel('購入端末', { w: 0.46, h: 0.34, bg: '#0b3d2e', fg: '#9fffd0', font: 90, sub: '道具・設備' });
  screen.position.set(0, 1.1, -0.205);
  screen.rotation.y = Math.PI;
  screen.rotation.x = 0;
  term.add(screen);
  const termTarget = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.4, 0.5), new THREE.MeshBasicMaterial({ visible: false }));
  termTarget.position.y = 0.7;
  termTarget.userData.kind = 'terminal';
  term.add(termTarget);
  targets.push(termTarget);
  term.rotation.y = Math.PI / 2; // 画面を -X（作業場の中央）側へ
  obstacles.push({ minX: T.x - 0.3, maxX: T.x + 0.3, minZ: T.z - 0.25, maxZ: T.z + 0.25 });

  // --- 受電盤（最初からある小さな電源。P4）
  const P = POWER_PANEL;
  const panel = new THREE.Group();
  panel.position.set(P.x, 0, P.z);
  scene.add(panel);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 0.35), new THREE.MeshLambertMaterial({ color: '#8d969c' }));
  cab.position.y = 0.75;
  cab.castShadow = true;
  panel.add(cab);
  const plate = makeLabel('受電盤', { w: 0.5, h: 0.4, bg: '#e8b827', fg: '#1d1a10', font: 80, sub: `⚡ ${P.output}kW` });
  plate.position.set(0, 1.1, 0.18);
  panel.add(plate);
  const panelTarget = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, 0.45), new THREE.MeshBasicMaterial({ visible: false }));
  panelTarget.position.y = 0.8;
  panelTarget.userData.kind = 'panel';
  panel.add(panelTarget);
  targets.push(panelTarget);
  obstacles.push({ minX: P.x - 0.35, maxX: P.x + 0.35, minZ: P.z - 0.2, maxZ: P.z + 0.2 });

  // --- 拡張可能な空き床（建設グリッド）
  const F = LAYOUT.freeFloor;
  const fw = F.maxX - F.minX, fd = F.maxZ - F.minZ;
  const pts = [];
  for (let x = F.minX; x <= F.maxX + 1e-6; x += 0.5) pts.push(x, 0.006, F.minZ, x, 0.006, F.maxZ);
  for (let z = F.minZ; z <= F.maxZ + 1e-6; z += 0.5) pts.push(F.minX, 0.006, z, F.maxX, 0.006, z);
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: '#cfd8dc', transparent: true, opacity: 0.55 })));
  const freeSign = makeLabel('拡張用の空き床', { w: 1.6, h: 0.36, bg: '#555', sub: '建設画面（B）で設備を置こう' });
  freeSign.position.set((F.minX + F.maxX) / 2 + 2, 1.6, ROOM.minZ + 0.02);
  scene.add(freeSign);
  void fw; void fd;

  // 室内の柱（雰囲気）
  for (const [x, z] of [[-0.5, -8.6], [-0.5, 8.6], [11.6, 0]]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, ROOM.height, 0.5), wallMat);
    p.position.set(x, ROOM.height / 2, z);
    scene.add(p);
  }

  // 影の設定
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);

  return {
    sun, obstacles, targets,
    scale: { group: scaleGroup, trayY: 0.865, dispCanvas, dispTex },
    shelf: { group: shelf },
    caseRef: { group: caseGroup, floorY: 0.825 },
  };
}

/** 計量機の表示を描き直す */
export function drawScaleDisplay(world, count, packSize, gramPer, hasChiri, auto) {
  const cv = world.scale.dispCanvas;
  const g = cv.getContext('2d');
  g.fillStyle = '#0d1a12';
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = hasChiri ? '#ff6b5b' : '#7dffa8';
  g.font = 'bold 110px monospace';
  g.textAlign = 'right';
  g.fillText((count * gramPer).toFixed(1), 400, 125);
  g.font = 'bold 60px sans-serif';
  g.fillText('g', 470, 125);
  g.textAlign = 'left';
  g.font = '36px sans-serif';
  g.fillStyle = '#cfe';
  g.fillText(`${count}匹  / 1パック ${packSize}匹`, 26, 190);
  g.fillStyle = count >= packSize ? '#ffe066' : '#6b8';
  g.fillText(auto ? '自動包装 ON' : (count >= packSize ? '[E] 包装できます' : '計量中…'), 26, 236);
  if (hasChiri) {
    g.fillStyle = '#ff6b5b';
    g.font = 'bold 34px sans-serif';
    g.fillText('⚠ 異物混入', 300, 236);
  }
  world.scale.dispTex.needsUpdate = true;
}
