// 形状・テクスチャの生成（素材はすべてコードで自作）
import * as THREE from 'three';
import { FISH_LENGTH } from './config.js';
import { SPECIES } from './chirimonData.js';

// ---------- しらす ----------
/** 近景用のしらす（体長 FISH_LENGTH、+X 方向が頭） */
export function makeShirasuGeometry() {
  const L = FISH_LENGTH, W = 0.0048, Hh = 0.0032;
  // [t(頭0→尾1), 太さ]
  const prof = [[0, 0.15], [0.05, 0.75], [0.14, 1.0], [0.4, 0.92], [0.7, 0.55], [0.9, 0.25], [1.0, 0.5]];
  const radial = 4; // 上・横・下・横
  const pos = [], col = [], idx = [];
  const back = new THREE.Color('#ddd6c8'), belly = new THREE.Color('#ffffff'), eye = new THREE.Color('#151515');
  prof.forEach(([t, r], ri) => {
    const x = L * (0.5 - t);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const tailFlat = t > 0.95 ? 0.25 : 1;
      const y = Math.cos(a) * Hh * r * (t > 0.95 ? 1.6 : 1);
      const z = Math.sin(a) * W * r * tailFlat;
      pos.push(x, y, z);
      let c = j === 0 ? back : belly;
      if (j === 2) c = belly;
      if ((j === 1 || j === 3) && ri === 1) c = eye; // 目
      if (j === 1 || j === 3) c = ri === 1 ? eye : new THREE.Color().lerpColors(back, belly, 0.6);
      col.push(c.r, c.g, c.b);
    }
  });
  for (let i = 0; i < prof.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j, b = i * radial + ((j + 1) % radial);
      const c = a + radial, d = b + radial;
      idx.push(a, c, b, b, c, d);
    }
  }
  // 先端と尾端のふた
  const head = pos.length / 3; pos.push(L * 0.5 + 0.0012, 0, 0); col.push(back.r, back.g, back.b);
  for (let j = 0; j < radial; j++) idx.push(head, j, (j + 1) % radial);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 中景用の簡略化しらす（ひし形の板） */
export function makeShirasuSimpleGeometry() {
  const L = FISH_LENGTH, W = 0.005;
  const pos = [L / 2, 0, 0, 0.1 * L, 0.0015, W / 2, -L / 2, 0, 0, 0.1 * L, 0.0015, -W / 2];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const c = [0.9, 0.88, 0.84, 1, 0.99, 0.96, 0.92, 0.9, 0.86, 1, 0.99, 0.96];
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

export function makeShirasuMaterial(simple = false) {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: simple ? THREE.DoubleSide : THREE.FrontSide,
    color: '#ffffff',
  });
}

// ---------- テクスチャ ----------
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** 山の表面（遠景の近似表示）。細かいしらすの模様 */
export function makePileTexture() {
  const S = 512;
  const cv = makeCanvas(S, S);
  const g = cv.getContext('2d');
  g.fillStyle = '#cbc3b2';
  g.fillRect(0, 0, S, S);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2, l = 14 + rnd() * 10;
    const v = 190 + rnd() * 55;
    g.strokeStyle = `rgb(${v},${v - 4},${v - 12})`;
    g.lineWidth = 2.2;
    g.lineCap = 'round';
    g.beginPath();
    for (const ox of [0, S, -S]) for (const oy of [0, S, -S]) {
      g.moveTo(x + ox, y + oy);
      g.lineTo(x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l);
    }
    g.stroke();
    g.fillStyle = '#2a2622';
    g.fillRect(x + Math.cos(a) * 2 - 0.6, y + Math.sin(a) * 2 - 0.6, 1.3, 1.3);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function makeFloorTexture() {
  const S = 512;
  const cv = makeCanvas(S, S);
  const g = cv.getContext('2d');
  g.fillStyle = '#8f9396';
  g.fillRect(0, 0, S, S);
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(60,62,66,0.5)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 文字の看板 */
export function makeLabel(text, { w = 1.2, h = 0.3, bg = '#1f3b57', fg = '#ffffff', font = 64, sub = '' } = {}) {
  const pxW = 512, pxH = Math.round((512 * h) / w);
  const cv = makeCanvas(pxW, pxH);
  const g = cv.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, pxW, pxH);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${font}px sans-serif`;
  g.fillText(text, pxW / 2, sub ? pxH * 0.4 : pxH / 2);
  if (sub) {
    g.font = `${Math.round(font * 0.45)}px sans-serif`;
    g.fillText(sub, pxW / 2, pxH * 0.78);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t }));
  return m;
}

export function makeSparkleTexture() {
  const cv = makeCanvas(64, 64);
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,230,1)');
  grd.addColorStop(0.25, 'rgba(255,240,150,0.7)');
  grd.addColorStop(1, 'rgba(255,220,100,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(32, 2); g.lineTo(32, 62); g.moveTo(2, 32); g.lineTo(62, 32); g.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- ちりモン ----------
const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshLambertMaterial({ color, ...opts }));
  }
  return matCache.get(key);
}
const EYE = () => mat('#101010');

function sphere(r, color, sx = 1, sy = 1, sz = 1, opts) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat(color, opts));
  m.scale.set(sx, sy, sz);
  return m;
}
function cyl(r1, r2, h, color, opts) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, 6), mat(color, opts));
}
function eyes(g, x, y, z, r = 0.07) {
  for (const s of [-1, 1]) {
    const e = sphere(r, '#101010');
    e.position.set(x, y, z * s);
    g.add(e);
  }
}

const builders = {
  ebi(g) {
    const c = '#f0a27f';
    for (let i = 0; i < 7; i++) {
      const a = -0.3 + i * 0.42;
      const s = sphere(0.17 - i * 0.015, c, 1.2, 0.8, 0.9, { transparent: true, opacity: 0.88 });
      s.position.set(Math.cos(a) * 0.32, 0.12, Math.sin(a) * 0.32 - 0.05);
      g.add(s);
    }
    const tail = cyl(0.001, 0.12, 0.18, '#f6b89a');
    tail.rotation.z = Math.PI / 2;
    tail.position.set(-0.32, 0.1, 0.2);
    g.add(tail);
    eyes(g, 0.38, 0.22, 0.08, 0.05);
    for (const s of [-1, 1]) {
      const ant = cyl(0.008, 0.008, 0.7, '#e08a64');
      ant.rotation.z = Math.PI / 2; ant.rotation.y = s * 0.4;
      ant.position.set(0.62, 0.15, -0.1 + s * 0.08);
      g.add(ant);
    }
  },
  kani(g) {
    const c = '#d6573a';
    const shell = sphere(0.3, c, 1.1, 0.45, 1);
    shell.position.set(0, 0.12, 0);
    g.add(shell);
    for (let i = 0; i < 4; i++) {
      for (const s of [-1, 1]) {
        const leg = cyl(0.03, 0.02, 0.42, '#c64a30');
        leg.rotation.x = s * 1.89;
        leg.rotation.y = (i - 1.5) * 0.35;
        leg.position.set((i - 1.5) * 0.14, 0.06, s * 0.32);
        g.add(leg);
      }
    }
    for (const s of [-1, 1]) {
      const claw = sphere(0.1, '#e0603f', 1.3, 0.7, 0.9);
      claw.position.set(0.36, 0.12, s * 0.2);
      g.add(claw);
    }
    eyes(g, 0.26, 0.26, 0.09, 0.045);
  },
  ika(g) {
    const c = '#f2d6e2';
    const mantle = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.6, 10), mat(c, { transparent: true, opacity: 0.85 }));
    mantle.rotation.z = Math.PI / 2;
    mantle.position.set(-0.15, 0.13, 0);
    mantle.scale.set(1, 1, 0.7);
    g.add(mantle);
    const fin = sphere(0.14, '#efc5d8', 0.6, 0.1, 1.4, { transparent: true, opacity: 0.8 });
    fin.position.set(-0.38, 0.13, 0);
    g.add(fin);
    const headM = sphere(0.12, '#f5dfe9', 1, 0.8, 1);
    headM.position.set(0.17, 0.12, 0);
    g.add(headM);
    eyes(g, 0.2, 0.17, 0.09, 0.05);
    for (let i = 0; i < 8; i++) {
      const t = cyl(0.02, 0.008, 0.32, '#f1c9da');
      t.rotation.z = Math.PI / 2;
      t.position.set(0.42, 0.1, (i - 3.5) * 0.03);
      t.rotation.y = (i - 3.5) * 0.08;
      g.add(t);
    }
  },
  tako(g) {
    const c = '#c8432f';
    const head = sphere(0.22, c, 1.15, 0.9, 1);
    head.position.set(-0.12, 0.2, 0);
    g.add(head);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const leg = cyl(0.045, 0.012, 0.42, '#d1513b');
      leg.rotation.z = Math.PI / 2;
      leg.rotation.y = -a;
      leg.position.set(0.08 + Math.cos(a) * 0.2, 0.05, Math.sin(a) * 0.2);
      g.add(leg);
    }
    eyes(g, 0.08, 0.24, 0.1, 0.05);
  },
  fugu(g) {
    const body = sphere(0.26, '#e2cf8b', 1.1, 0.9, 1);
    body.position.y = 0.2;
    g.add(body);
    const back = sphere(0.255, '#8a7a45', 1.08, 0.5, 0.95);
    back.position.y = 0.27;
    g.add(back);
    eyes(g, 0.2, 0.3, 0.12, 0.06);
    const tail = cyl(0.001, 0.12, 0.14, '#cdb76a');
    tail.rotation.z = -Math.PI / 2;
    tail.position.set(-0.33, 0.2, 0);
    g.add(tail);
  },
  tatsu(g) {
    const c = '#c99435';
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      pts.push(new THREE.Vector3(0.3 - t * 0.55, 0.1, Math.sin(t * 3.2) * 0.12));
    }
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 1.6;
      pts.push(new THREE.Vector3(-0.25 - Math.sin(a) * 0.1, 0.1, Math.cos(a) * 0.1 - 0.1 + 0.1));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.055, 6), mat(c));
    g.add(tube);
    const head = sphere(0.1, c, 1, 1, 0.8);
    head.position.set(0.34, 0.12, 0);
    g.add(head);
    const snout = cyl(0.03, 0.04, 0.16, '#b98328');
    snout.rotation.z = Math.PI / 2;
    snout.position.set(0.47, 0.12, 0);
    g.add(snout);
    eyes(g, 0.38, 0.17, 0.06, 0.03);
  },
  nazo(g) {
    const m = new THREE.MeshLambertMaterial({ color: '#56d8ff', emissive: '#1a8cbf', emissiveIntensity: 1.2 });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), m);
    core.position.y = 0.2;
    g.add(core);
    for (let i = 0; i < 10; i++) {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 5), m);
      const a = i * 2.4, b = (i / 10) * Math.PI;
      const dir = new THREE.Vector3(Math.cos(a) * Math.sin(b), Math.cos(b), Math.sin(a) * Math.sin(b));
      sp.position.copy(dir.clone().multiplyScalar(0.25)).add(new THREE.Vector3(0, 0.2, 0));
      sp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.add(sp);
    }
    eyes(g, 0.17, 0.27, 0.07, 0.04);
  },
};

/** ちりモンの見た目。species はインデックス。全長がおよそ species.size になる */
export function makeChirimonMesh(speciesIndex) {
  const sp = SPECIES[speciesIndex];
  const g = new THREE.Group();
  builders[sp.id](g);
  g.scale.setScalar(sp.size * 1.35);
  g.userData.species = speciesIndex;
  return g;
}

// ---------- 手・道具 ----------
const GLOVE_COLORS = {
  none: '#f0c4a2', glove1: '#f1f0ea', glove2: '#e3dccb', glove3: '#f0bf2c', glove4: '#3c6fb6',
};

export function makeHand(kind = 'none') {
  const g = new THREE.Group();
  const c = GLOVE_COLORS[kind] || GLOVE_COLORS.none;
  const m = new THREE.MeshLambertMaterial({ color: c });
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.025, 0.1), m);
  g.add(palm);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.0095, 0.05, 3, 6), m);
    f.rotation.x = Math.PI / 2 - 0.5;
    f.position.set(-0.033 + i * 0.022, 0.012, -0.075);
    g.add(f);
  }
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.04, 3, 6), m);
  thumb.rotation.z = 1.1;
  thumb.rotation.y = 0.4;
  thumb.position.set(-0.06, 0.012, -0.02);
  g.add(thumb);
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.12, 10), new THREE.MeshLambertMaterial({ color: kind === 'none' ? '#3b5b8a' : c }));
  wrist.rotation.x = Math.PI / 2;
  wrist.position.set(0, -0.005, 0.1);
  g.add(wrist);
  return g;
}

export function makeScoop(big = false) {
  const root = new THREE.Group();
  const g = new THREE.Group();
  g.scale.setScalar(0.62);
  g.position.set(-0.02, 0, -0.04);
  root.add(g);
  const s = big ? 1.35 : 1;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.16 * s, 0.01, 0.2 * s), new THREE.MeshLambertMaterial({ color: '#b8c0c8' }));
  g.add(blade);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.04, 0.2 * s), blade.material);
    wall.position.set(side * 0.08 * s, 0.02, 0);
    g.add(wall);
  }
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.16 * s, 0.05, 0.008), blade.material);
  back.position.set(0, 0.025, 0.1 * s);
  g.add(back);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 8), new THREE.MeshLambertMaterial({ color: '#8a5a2b' }));
  handle.rotation.x = Math.PI / 2 - 0.3;
  handle.position.set(0, 0.06, 0.25 * s);
  g.add(handle);
  return root;
}
