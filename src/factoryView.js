// 搬送設備の3D表示（コンベア・ホッパー・包装機・クレーン）と、運ばれている個体
import * as THREE from 'three';
import { MACHINES, PACK_SIZE } from './config.js';
import { DIRS } from './factory.js';
import { makeShirasuGeometry, makeShirasuMaterial, makeChirimonMesh, makeCanvas } from './meshes.js';

const steel = new THREE.MeshLambertMaterial({ color: '#b7bfc6' });
const dark = new THREE.MeshLambertMaterial({ color: '#3f474d' });
const yellow = new THREE.MeshLambertMaterial({ color: '#e8b827' });
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const lampOn = new THREE.MeshBasicMaterial({ color: '#5dff8a' });
const lampOff = new THREE.MeshBasicMaterial({ color: '#ff5a4a' });
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
    this.chiri = new Map(); // id -> mesh
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // ===== 設備のモデル =====
  _build(m, f) {
    const root = new THREE.Group();
    root.position.set(f.cx(m.i), 0, f.cz(m.j));
    root.rotation.y = -m.dir * Math.PI / 2;
    const parts = {};
    let hit;
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
    } else if (m.type === 'packer') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.7, 0.46), new THREE.MeshLambertMaterial({ color: '#2f6fb3' }));
      body.position.y = 0.35;
      root.add(body);
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.3), dark);
      slot.position.y = 0.72;
      root.add(slot);
      const cv = makeCanvas(256, 128);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.18), new THREE.MeshBasicMaterial({ map: tex }));
      // 表示はどの向きでも見えるよう4面に
      for (let k = 0; k < 4; k++) {
        const d = disp.clone();
        d.position.set(Math.cos(k * Math.PI / 2) * 0.235, 0.45, Math.sin(k * Math.PI / 2) * 0.235);
        d.rotation.y = Math.PI / 2 - k * Math.PI / 2;
        root.add(d);
      }
      parts.disp = { cv, tex, last: '' };
      hit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5), hitMat);
      hit.position.y = 0.4;
    } else if (m.type === 'crane') {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.14, 0.44), dark);
      base.position.y = 0.07;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.6, 10), yellow);
      mast.position.y = 1.35;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.2), yellow);
      cap.position.y = 2.68;
      root.add(base, mast, cap);
      // 腕・ワイヤ・つかみは root の回転とは独立に、ワールド座標で動かす
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
      ring.position.set(f.cx(m.i), 0.01, f.cz(m.j));
      ring.visible = false;
      this.group.add(ring);
      parts.ring = ring;
      hit = new THREE.Mesh(new THREE.BoxGeometry(0.45, 2.7, 0.45), hitMat);
      hit.position.y = 1.35;
    }
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), m.on ? lampOn : lampOff);
    lamp.position.set(-0.2, m.type === 'conveyor' ? 0.27 : (m.type === 'crane' ? 0.2 : (m.type === 'hopper' ? 1.03 : 0.73)), 0.2);
    root.add(lamp);
    parts.lamp = lamp;
    hit.userData = { kind: 'machine', mid: m.id, i: m.i, j: m.j };
    root.add(hit);
    root.traverse((o) => { if (o.isMesh && o !== hit) { o.castShadow = m.type !== 'conveyor'; o.receiveShadow = true; } });
    this.group.add(root);
    return { root, hit, parts, sig: `${m.type}${m.dir}` };
  }

  _dispose(it) {
    this.group.remove(it.root);
    for (const k of ['boom', 'cable', 'claw', 'ring']) if (it.parts[k]) this.group.remove(it.parts[k]);
  }

  sync(f) {
    if (f.version === this.version) return;
    this.version = f.version;
    const alive = new Set();
    for (const m of f.machines.values()) {
      alive.add(m.id);
      let it = this.items.get(m.id);
      if (it && it.sig !== `${m.type}${m.dir}`) { this._dispose(it); it = null; }
      if (!it) { it = this._build(m, f); this.items.set(m.id, it); }
      it.parts.lamp.material = m.on ? lampOn : lampOff;
      if (it.parts.belt) it.parts.belt.material = m.on ? this.beltRun : this.beltStop;
    }
    for (const [id, it] of this.items) if (!alive.has(id)) { this._dispose(it); this.items.delete(id); }
    this.targets = [...this.items.values()].map((it) => it.hit);
  }

  showRings(on) { for (const it of this.items.values()) if (it.parts.ring) it.parts.ring.visible = on; }

  // ===== 毎フレーム =====
  update(f, pile, dt) {
    this.sync(f);
    this.beltRun.map.offset.x -= dt * 1.5 * 0.5 * 2; // ベルトの模様を流す
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
        const d = it.parts.disp;
        const txt = `${m.buffer.length}|${m.packs}|${m.on}`;
        if (d.last !== txt) {
          d.last = txt;
          const g = d.cv.getContext('2d');
          g.fillStyle = '#0d1a12'; g.fillRect(0, 0, 256, 128);
          g.fillStyle = m.on ? '#7dffa8' : '#ff7a6b';
          g.font = 'bold 34px sans-serif';
          g.fillText(m.on ? '包装機 稼働中' : '包装機 停止', 12, 42);
          g.fillStyle = '#cfe';
          g.font = '28px sans-serif';
          g.fillText(`待ち ${m.buffer.length}匹 (${PACK_SIZE}匹/パック)`, 12, 82);
          g.fillText(`出荷 ${m.packs} パック`, 12, 116);
          d.tex.needsUpdate = true;
        }
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
