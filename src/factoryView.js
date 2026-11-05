// 工場設備の3D表示（コンベア・ホッパー・包装機・クレーン・選別機・発電機・電柱）と、運ばれている個体・電線
import * as THREE from 'three';
import { MACHINES, PACK_SIZE, POWER_PANEL } from './config.js';
import { DIRS } from './factory.js';
import { makeShirasuGeometry, makeShirasuMaterial, makeChirimonMesh, makeCanvas } from './meshes.js';

const steel = new THREE.MeshLambertMaterial({ color: '#b7bfc6' });
const dark = new THREE.MeshLambertMaterial({ color: '#3f474d' });
const yellow = new THREE.MeshLambertMaterial({ color: '#e8b827' });
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const LAMP = {
  on: new THREE.MeshBasicMaterial({ color: '#5dff8a' }),
  slow: new THREE.MeshBasicMaterial({ color: '#ffd23f' }),
  off: new THREE.MeshBasicMaterial({ color: '#ff5a4a' }),
  none: new THREE.MeshBasicMaterial({ color: '#555b60' }),
};
const heapMat = new THREE.MeshLambertMaterial({ color: '#e9e4d8' });

function hash01(id, salt) { return (((id ^ salt) * 2654435761) >>> 0) / 4294967296; }

function makeBeltTexture() {
  const cv = makeCanvas(64, 64);
  const g = cv.getContext('2d');
  g.fillStyle = '#2b2f33'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#454b51'; g.lineWidth = 6;
  for (const y of [16, 48]) { g.beginPath(); g.moveTo(10, y - 12); g.lineTo(26, y); g.lineTo(10, y + 12); g.stroke(); }
  g.fillStyle = '#383d42';
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 2, 64);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeDisplay(w, h) {
  const cv = makeCanvas(256, Math.round((256 * h) / w));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  return { cv, tex, mesh, last: '' };
}

function drawDisplay(d, lines, color) {
  const key = lines.join('|') + color;
  if (d.last === key) return;
  d.last = key;
  const g = d.cv.getContext('2d');
  g.fillStyle = '#0d1a12'; g.fillRect(0, 0, d.cv.width, d.cv.height);
  g.fillStyle = color;
  g.font = 'bold 32px sans-serif';
  g.fillText(lines[0], 12, 40);
  g.fillStyle = '#cfe';
  g.font = '26px sans-serif';
  lines.slice(1).forEach((l, k) => g.fillText(l, 12, 78 + k * 32));
  d.tex.needsUpdate = true;
}

export class FactoryView {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.items = new Map(); // machine.id -> {root, hit, parts, sig}
    this.targets = [];
    this.version = -1;
    const tex = makeBeltTexture();
    tex.repeat.set(2, 1);
    this.beltRun = new THREE.MeshLambertMaterial({ map: tex });
    const tex2 = tex.clone();
    tex2.needsUpdate = true;
    this.beltStop = new THREE.MeshLambertMaterial({ map: tex2 });
    this.fish = new THREE.InstancedMesh(makeShirasuGeometry(), makeShirasuMaterial(), 8000);
    this.fish.count = 0;
    this.fish.frustumCulled = false;
    scene.add(this.fish);
    this.chiri = new Map();
    this.wires = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#1b1b1b' }));
    this.wires.frustumCulled = false;
    scene.add(this.wires);
    this.wireV = -1;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // ===== 設備のモデル（ローカル +X が向き） =====
  _build(m, f) {
    const root = new THREE.Group();
    const c = f.center(m);
    root.position.set(c.x, 0, c.z);
    root.rotation.y = m.type === 'generator' ? 0 : -m.dir * Math.PI / 2;
    const parts = {};
    let hit, lampY = 0.73;
    if (m.type === 'conveyor') {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.42), dark);
      frame.position.y = 0.1;
      const belt = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.36), this.beltRun);
      belt.rotation.x = -Math.PI / 2;
      belt.position.y = 0.205;
      for (const z of [-0.2, 0.2]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.03), yellow);
        rail.position.set(0, 0.23, z);
        root.add(rail);
      }
      root.add(frame, belt);
      parts.belt = belt;
      hit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.5), hitMat);
      hit.position.y = 0.16;
      lampY = 0.27;
    } else if (m.type === 'hopper') {
      for (const [x, z] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.04), dark);
        leg.position.set(x, 0.3, z);
        root.add(leg);
      }
      const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.07, 0.42, 14, 1, true), new THREE.MeshLambertMaterial({ color: '#d9822b', side: THREE.DoubleSide }));
      funnel.position.y = 0.8;
      root.add(funnel);
      const chute = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.16), steel);
      chute.position.set(0.18, 0.42, 0);
      chute.rotation.z = -0.5;
      root.add(chute);
      const heap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.14, 14), heapMat);
      heap.visible = false;
      root.add(heap);
      parts.heap = heap;
      hit = new THREE.Mesh(new THREE.BoxGeometry(0.52, 1.05, 0.52), hitMat);
      hit.position.y = 0.52;
      lampY = 1.03;
    } else if (m.type === 'packer') {
      // 1×2マス：後ろ（-X 側）が投入口、前（+X 側）が出荷口
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.7, 0.46), new THREE.MeshLambertMaterial({ color: '#2f6fb3' }));
      body.position.y = 0.35;
      root.add(body);
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.34), dark);
      slot.position.set(-0.3, 0.72, 0);
      root.add(slot);
      const chute = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.3), steel);
      chute.position.set(0.58, 0.3, 0);
      chute.rotation.z = -0.4;
      root.add(chute);
      const d = makeDisplay(0.42, 0.21);
      for (const side of [-1, 1]) {
        const dm = d.mesh.clone();
        dm.position.set(0.05, 0.45, side * 0.235);
        dm.rotation.y = side > 0 ? 0 : Math.PI;
        root.add(dm);
      }
      parts.disp = d;
      hit = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 0.5), hitMat);
      hit.position.y = 0.4;
    } else if (m.type === 'sorter') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.45, 0.42), new THREE.MeshLambertMaterial({ color: '#3a8c5c' }));
      body.position.y = 0.225;
      root.add(body);
      const arch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.46), dark);
      arch.position.set(0, 0.6, 0);
      root.add(arch);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.04, 0.4), new THREE.MeshBasicMaterial({ color: '#7dffd0' }));
      eye.position.set(0, 0.44, 0);
      root.add(eye);
      parts.eye = eye;
      const bin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.18), new THREE.MeshLambertMaterial({ color: '#d6573a' }));
      bin.position.set(0, 0.08, -0.31);
      root.add(bin);
      parts.binPos = new THREE.Vector3(0, 0.17, -0.31);
      const d = makeDisplay(0.36, 0.18);
      d.mesh.position.set(0, 0.25, 0.215);
      root.add(d.mesh);
      parts.disp = d;
      hit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.7), hitMat);
      hit.position.set(0, 0.4, -0.1);
      lampY = 0.8;
    } else if (m.type === 'generator') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.75, 0.75), new THREE.MeshLambertMaterial({ color: '#4d6b4f' }));
      body.position.y = 0.375;
      root.add(body);
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.9), dark);
      base.position.y = 0.04;
      root.add(base);
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8), dark);
      pipe.position.set(0.3, 1.0, -0.2);
      root.add(pipe);
      for (let k = 0; k < 5; k++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.45, 0.6), dark);
        fin.position.set(-0.46, 0.4, 0);
        fin.position.z = -0.24 + k * 0.12;
        fin.scale.z = 0.15;
        root.add(fin);
      }
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), dark);
      mast.position.set(-0.3, 1.55, 0.3);
      root.add(mast);
      const d = makeDisplay(0.5, 0.25);
      for (const [x, z, ry] of [[0, 0.38, 0], [0, -0.38, Math.PI], [0.455, 0, Math.PI / 2]]) {
        const dm = d.mesh.clone();
        dm.position.set(x, 0.5, z);
        dm.rotation.y = ry;
        root.add(dm);
      }
      parts.disp = d;
      hit = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.2, 0.95), hitMat);
      hit.position.y = 0.6;
      lampY = 0.8;
    } else if (m.type === 'pole') {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 2.4, 8), new THREE.MeshLambertMaterial({ color: '#7a6a55' }));
      post.position.y = 1.2;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.05), dark);
      arm.position.y = 2.3;
      root.add(post, arm);
      for (const x of [-0.2, 0.2]) {
        const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.07, 6), new THREE.MeshLambertMaterial({ color: '#e9e4d8' }));
        ins.position.set(x, 2.36, 0);
        root.add(ins);
      }
      hit = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4, 0.3), hitMat);
      hit.position.y = 1.2;
      lampY = 2.2;
    } else if (m.type === 'crane') {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.14, 0.44), dark);
      base.position.y = 0.07;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.6, 10), yellow);
      mast.position.y = 1.35;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.2), yellow);
      cap.position.y = 2.68;
      root.add(base, mast, cap);
      const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 0.08, 0.1), yellow);
      boom.geometry.translate(0.5, 0, 0);
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 4), dark);
      cable.geometry.translate(0, -0.5, 0);
      const claw = new THREE.Group();
      for (let k = 0; k < 3; k++) {
        const finger = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.06), steel);
        finger.position.set(Math.cos(k * 2.09) * 0.07, -0.06, Math.sin(k * 2.09) * 0.07);
        finger.rotation.set(Math.sin(k * 2.09) * 0.4, 0, -Math.cos(k * 2.09) * 0.4);
        claw.add(finger);
      }
      const load = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), heapMat);
      load.position.y = -0.1;
      load.scale.y = 0.6;
      claw.add(load);
      this.group.add(boom, cable, claw);
      parts.boom = boom; parts.cable = cable; parts.claw = claw; parts.load = load;
      const ring = new THREE.Mesh(new THREE.RingGeometry(MACHINES.crane.reach - 0.02, MACHINES.crane.reach, 64), new THREE.MeshBasicMaterial({ color: '#e8b827', transparent: true, opacity: 0.35 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(c.x, 0.01, c.z);
      ring.visible = false;
      this.group.add(ring);
      parts.ring = ring;
      hit = new THREE.Mesh(new THREE.BoxGeometry(0.45, 2.7, 0.45), hitMat);
      hit.position.y = 1.35;
      lampY = 0.2;
    }
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), LAMP.on);
    lamp.position.set(m.type === 'packer' ? -0.42 : -0.2, lampY, 0.2);
    root.add(lamp);
    parts.lamp = lamp;
    hit.userData = { kind: 'machine', mid: m.id, i: m.i, j: m.j };
    root.add(hit);
    root.traverse((o) => { if (o.isMesh && o !== hit) { o.castShadow = m.type !== 'conveyor'; o.receiveShadow = true; } });
    this.group.add(root);
    return { root, hit, parts, sig: `${m.type}${m.dir}${m.i},${m.j}` };
  }

  _dispose(it) {
    this.group.remove(it.root);
    for (const k of ['boom', 'cable', 'claw', 'ring']) if (it.parts[k]) this.group.remove(it.parts[k]);
    // 設備ごとに作った形状・材質・文字テクスチャを GPU から解放する（共有の材質は残す）
    const shared = new Set([steel, dark, yellow, hitMat, heapMat, ...Object.values(LAMP), this.beltRun, this.beltStop]);
    const seen = new Set();
    const free = (o) => o.traverse((x) => {
      if (seen.has(x)) return;
      seen.add(x);
      if (x.geometry) x.geometry.dispose();
      const mats = Array.isArray(x.material) ? x.material : x.material ? [x.material] : [];
      for (const mt of mats) {
        if (shared.has(mt)) continue;
        if (mt.map) mt.map.dispose();
        mt.dispose();
      }
    });
    free(it.root);
    for (const k of ['boom', 'cable', 'claw', 'ring']) if (it.parts[k]) free(it.parts[k]);
    if (it.hit && !seen.has(it.hit)) free(it.hit);
  }

  sync(f) {
    if (f.version === this.version) return;
    this.version = f.version;
    const alive = new Set();
    for (const m of f.machines.values()) {
      alive.add(m.id);
      let it = this.items.get(m.id);
      if (it && it.sig !== `${m.type}${m.dir}${m.i},${m.j}`) { this._dispose(it); it = null; }
      if (!it) { it = this._build(m, f); this.items.set(m.id, it); }
      if (it.parts.belt) it.parts.belt.material = m.on ? this.beltRun : this.beltStop;
    }
    for (const [id, it] of this.items) if (!alive.has(id)) { this._dispose(it); this.items.delete(id); }
    this.targets = [...this.items.values()].map((it) => it.hit);
  }

  showRings(on) { for (const it of this.items.values()) if (it.parts.ring) it.parts.ring.visible = on; }

  _updateWires(f) {
    if (this.wireV === f.netVersion || !f.links) return;
    this.wireV = f.netVersion;
    const pts = [];
    const top = (n) => (n.panel ? 1.5 : (n.m.type === 'pole' ? 2.38 : 1.95));
    for (const [a, b] of f.links) {
      const ax = a.panel ? POWER_PANEL.x : a.x, az = a.panel ? POWER_PANEL.z : a.z;
      const bx = b.panel ? POWER_PANEL.x : b.x, bz = b.panel ? POWER_PANEL.z : b.z;
      // 少したるませる
      const ya = top(a), yb = top(b);
      let px = ax, py = ya, pz = az;
      for (let k = 1; k <= 8; k++) {
        const t = k / 8;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const y = ya + (yb - ya) * t - Math.sin(t * Math.PI) * 0.18;
        pts.push(px, py, pz, x, y, z);
        px = x; py = y; pz = z;
      }
    }
    this.wires.geometry.dispose();
    this.wires.geometry = new THREE.BufferGeometry();
    this.wires.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }

  // ===== 毎フレーム =====
  update(f, pile, dt, time = 0) {
    this.sync(f);
    this._updateWires(f);
    if (dt > 0) this.beltRun.map.offset.x -= dt * 1.5;
    const m4 = this._m, q = this._q, p = this._p, s = this._s;
    let n = 0;
    const cap = this.fish.instanceMatrix.count;
    const seen = new Set();
    const showChiri = (id, x, y, z) => {
      seen.add(id);
      let cm = this.chiri.get(id);
      if (!cm) { cm = makeChirimonMesh(pile.speciesOf(id)); this.chiri.set(id, cm); this.scene.add(cm); }
      cm.position.set(x, y, z);
    };
    for (const m of f.machines.values()) {
      const it = this.items.get(m.id);
      if (!it) continue;
      const cx = f.cx(m.i), cz = f.cz(m.j);
      // ランプ：緑=稼働、黄=電力不足で減速、赤=停止・電力なし、灰=電源不要
      const consumer = MACHINES[m.type].power != null;
      it.parts.lamp.material = !consumer ? (m.type === 'generator' && !m.on ? LAMP.off : (m.type === 'generator' ? LAMP.on : LAMP.none))
        : (!m.on || m.power <= 0 ? LAMP.off : (m.power < 0.999 ? LAMP.slow : LAMP.on));
      if (it.parts.belt) it.parts.belt.material = m.on && m.power > 0 ? this.beltRun : this.beltStop;
      if (m.type === 'conveyor') {
        const [dx, dz] = DIRS[m.dir];
        for (const b of m.batches) {
          const bx = cx + dx * (b.pos - 0.5) * 0.5, bz = cz + dz * (b.pos - 0.5) * 0.5;
          const shown = Math.min(b.ids.length, 12);
          for (let k = 0; k < shown && n < cap; k++) {
            const id = b.ids[k];
            if (b.chiri.includes(id)) continue;
            const a = hash01(id, 1) * Math.PI * 2, r = Math.sqrt(hash01(id, 2)) * 0.09;
            p.set(bx + Math.cos(a) * r, 0.212 + hash01(id, 3) * 0.006, bz + Math.sin(a) * r);
            q.setFromAxisAngle(this._up, hash01(id, 4) * Math.PI * 2);
            m4.compose(p, q, s);
            this.fish.setMatrixAt(n++, m4);
          }
          b.chiri.forEach((id, k) => showChiri(id, bx + (k % 3) * 0.04 - 0.04, 0.215, bz + 0.03));
        }
      } else if (m.type === 'hopper') {
        const fill = Math.min(1, m.buffer.length / MACHINES.hopper.capacity);
        const heap = it.parts.heap;
        heap.visible = m.buffer.length > 0;
        heap.position.y = 0.62 + fill * 0.3;
        heap.scale.setScalar(0.4 + fill * 0.6);
        let shownC = 0;
        for (const id of m.buffer) {
          if (!pile.isChirimon(id)) continue;
          if (shownC++ >= 3) break;
          showChiri(id, cx + (shownC - 2) * 0.05, 0.62 + fill * 0.3 + 0.07 * (0.4 + fill * 0.6), cz);
        }
      } else if (m.type === 'packer') {
        drawDisplay(it.parts.disp, [m.on ? (m.power > 0 ? '包装機 稼働中' : '包装機 電力なし') : '包装機 停止', `待ち ${m.buffer.length}匹 (${PACK_SIZE}匹/パック)`, `出荷 ${m.packs} パック`], m.on && m.power > 0 ? '#7dffa8' : '#ff7a6b');
      } else if (m.type === 'sorter') {
        drawDisplay(it.parts.disp, [`選別機 ${m.on && m.power > 0 ? '稼働' : '停止'}`, `回収箱 ${m.bin.length}/${MACHINES.sorter.bin}`], m.bin.length ? '#ff9ad5' : '#7dffa8');
        it.parts.eye.material.color.set(m.on && m.power > 0 ? (Math.sin(time * 8) > 0 ? '#7dffd0' : '#2a8a6a') : '#333');
        const wp = it.parts.binPos.clone().applyMatrix4(it.root.matrixWorld);
        m.bin.forEach((id, k) => showChiri(id, wp.x + ((k % 4) - 1.5) * 0.04, wp.y, wp.z + (Math.floor(k / 4) - 1) * 0.04));
      } else if (m.type === 'generator') {
        const net = f.nets.find((x) => x.id === m.net);
        const load = m.load || 0;
        drawDisplay(it.parts.disp, [m.on ? '発電機 運転中' : '発電機 停止', `負荷 ${load.toFixed(1)} / ${MACHINES.generator.output} kW`, `燃料費 ${(load * MACHINES.generator.fuelCost).toFixed(2)}円/秒`, net ? `電力網 需要 ${(net.demand || 0).toFixed(1)}kW` : ''], m.on ? '#7dffa8' : '#ff7a6b');
      } else if (m.type === 'crane') {
        const arm = f.craneArm(m);
        const bx = cx, bz = cz, top = 2.62;
        const len = Math.max(0.15, Math.hypot(arm.x - bx, arm.z - bz));
        const ang = Math.atan2(-(arm.z - bz), arm.x - bx);
        it.parts.boom.position.set(bx, top, bz);
        it.parts.boom.rotation.y = ang;
        it.parts.boom.scale.x = len + 0.1;
        it.parts.cable.position.set(arm.x, top - 0.04, arm.z);
        it.parts.cable.scale.y = Math.max(0.05, top - 0.04 - arm.y);
        it.parts.claw.position.set(arm.x, arm.y, arm.z);
        it.parts.load.visible = arm.holding > 0;
        const chiriHeld = m.holding.filter((id) => pile.isChirimon(id));
        chiriHeld.forEach((id, k) => showChiri(id, arm.x + k * 0.04, arm.y - 0.12, arm.z));
      }
    }
    this.fish.count = n;
    this.fish.instanceMatrix.needsUpdate = true;
    for (const [id, cm] of this.chiri) if (!seen.has(id)) { this.scene.remove(cm); this.chiri.delete(id); }
  }
}
