// 山・床・計量機・ケースの描画（企画書 4.2：近景=実モデル、中景=簡略メッシュ、遠景=表面の近似）
import * as THREE from 'three';
import { EXPOSE_DEPTH, LAYOUT, PACK_SIZE } from './config.js';
import { SPECIES } from './chirimonData.js';
import {
  makeShirasuGeometry, makeShirasuSimpleGeometry, makeShirasuMaterial,
  makePileTexture, makeChirimonMesh, makeSparkleTexture,
} from './meshes.js';

const UP = new THREE.Vector3(0, 1, 0);

export class PileView {
  constructor(scene, quality) {
    this.scene = scene;
    this.q = quality;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.detailGeo = makeShirasuGeometry();
    this.simpleGeo = makeShirasuSimpleGeometry();
    this.detailMat = makeShirasuMaterial(false);
    this.simpleMat = makeShirasuMaterial(true);
    this.pileTex = makePileTexture();
    this.sparkleTex = makeSparkleTexture();
    this.chiriMeshes = new Map(); // id -> Object3D（山の上の露出ちりモン）
    this.sparkles = [];
    this.lastBuildPos = new THREE.Vector3(1e9, 0, 0);
    this.lastVersion = -1;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._c = new THREE.Color();
    this.tf = {};
    this._setupInstanced();

    // 床に落ちた個体
    this.floorMesh = new THREE.InstancedMesh(this.detailGeo, this.detailMat, 4000);
    this.floorMesh.count = 0;
    this.floorMesh.frustumCulled = false;
    scene.add(this.floorMesh);
    this.floorChiri = new Map();

    // 計量機の上
    this.scaleMesh = new THREE.InstancedMesh(this.detailGeo, this.detailMat, 300);
    this.scaleMesh.count = 0;
    this.scaleMesh.frustumCulled = false;
    scene.add(this.scaleMesh);
    this.scaleChiri = new Map();

    // 完成パック
    const packGeo = new THREE.BoxGeometry(0.2, 0.05, 0.14);
    const packCv = document.createElement('canvas');
    packCv.width = 128; packCv.height = 96;
    const g = packCv.getContext('2d');
    g.fillStyle = '#f7f4ec'; g.fillRect(0, 0, 128, 96);
    g.fillStyle = '#2f6fb3'; g.fillRect(0, 0, 128, 26);
    g.fillStyle = '#fff'; g.font = 'bold 20px sans-serif'; g.fillText('しらす', 34, 20);
    g.fillStyle = '#c33'; g.fillRect(90, 60, 30, 30);
    const packTex = new THREE.CanvasTexture(packCv);
    packTex.colorSpace = THREE.SRGBColorSpace;
    this.packMesh = new THREE.InstancedMesh(packGeo, new THREE.MeshLambertMaterial({ map: packTex }), 96);
    this.packMesh.count = 0;
    this.packMesh.frustumCulled = false; // 最初は0個で境界球が原点に固定され、棚が見えなくなるのを防ぐ
    this.packMesh.castShadow = true;
    scene.add(this.packMesh);

    // 保護ケースの展示
    this.caseItems = new THREE.Group();
    scene.add(this.caseItems);
    this.caseShown = '';
  }

  _setupInstanced() {
    const q = this.q;
    if (this.near) { this.group.remove(this.near, this.mid); this.near.dispose(); this.mid.dispose(); }
    this.near = new THREE.InstancedMesh(this.detailGeo, this.detailMat, q.instanceCap);
    this.mid = new THREE.InstancedMesh(this.simpleGeo, this.simpleMat, Math.floor(q.instanceCap * 0.8));
    for (const m of [this.near, this.mid]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    this.near.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(q.instanceCap * 3), 3);
    this.mid.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.floor(q.instanceCap * 0.8) * 3).fill(1), 3);
    // 渦巻き順（近い柱から）のオフセット
    this.spiral = null;
  }

  setQuality(q) {
    this.q = q;
    this._setupInstanced();
    this.lastVersion = -1;
  }

  /** 新しい山に切り替える */
  setPile(pile) {
    this.pile = pile;
    if (this.surface) { this.group.remove(this.surface); this.surface.geometry.dispose(); }
    for (const m of this.chiriMeshes.values()) this.group.remove(m);
    this.chiriMeshes.clear();
    const G = pile.G;
    const pos = new Float32Array(G * G * 3), uv = new Float32Array(G * G * 2);
    for (let iz = 0; iz < G; iz++) for (let ix = 0; ix < G; ix++) {
      const c = iz * G + ix;
      pos[c * 3] = pile.colCenterX(c);
      pos[c * 3 + 2] = pile.colCenterZ(c);
      uv[c * 2] = pos[c * 3] / 0.6;
      uv[c * 2 + 1] = pos[c * 3 + 2] / 0.6;
    }
    const idx = [];
    for (let iz = 0; iz < G - 1; iz++) for (let ix = 0; ix < G - 1; ix++) {
      const a = iz * G + ix, b = a + 1, c = a + G, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    // 掘った深さで色を変える（掘り進めた手応えが見えるように）
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(G * G * 3).fill(1), 3));
    geo.setIndex(idx);
    this.surface = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this.pileTex, color: '#f2eee6', vertexColors: true }));
    this.surface.receiveShadow = true;
    this.surface.castShadow = true;
    this.surface.frustumCulled = false;
    this.group.add(this.surface);
    this._updateSurface(true);
    // 柱ごとの斜面の傾き
    this.colNormalQ = new Array(pile.nCols);
    this.spiral = null;
    this.lastVersion = -1;
  }

  _updateSurface(all = false) {
    const pile = this.pile;
    const pos = this.surface.geometry.attributes.position;
    const arr = pos.array;
    const colAttr = this.surface.geometry.attributes.color;
    const col = colAttr.array;
    const cols = all ? null : pile.dirtyCols;
    const setY = (c) => {
      const h = pile.topH[c];
      arr[c * 3 + 1] = h > 0 ? h - 0.004 : -0.02;
      // 掘った深さ 0〜4cm で、白っぽい表面から湿った琥珀色へ
      const dug = Math.min(1, Math.max(0, (pile.h0[c] - h) / 0.04));
      const v = h > 0 ? Math.sqrt(dug) : 0;
      col[c * 3] = 1 - 0.3 * v; col[c * 3 + 1] = 1 - 0.38 * v; col[c * 3 + 2] = 1 - 0.52 * v;
    };
    if (all) for (let c = 0; c < pile.nCols; c++) setY(c);
    else for (const c of cols) setY(c);
    pile.dirtyCols.clear();
    pos.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.surface.geometry.computeVertexNormals();
    this.surface.geometry.computeBoundingSphere();
  }

  _slopeQuat(c) {
    const pile = this.pile, G = pile.G;
    const ix = c % G, iz = Math.floor(c / G);
    const h = (x, z) => (x < 0 || z < 0 || x >= G || z >= G) ? 0 : pile.topH[z * G + x];
    const dx = (h(ix + 1, iz) - h(ix - 1, iz)) / (2 * pile.cell);
    const dz = (h(ix, iz + 1) - h(ix, iz - 1)) / (2 * pile.cell);
    this._n.set(-dx, 1, -dz).normalize();
    return this._q2.setFromUnitVectors(UP, this._n);
  }

  _buildSpiral(maxR) {
    const cell = this.pile.cell;
    const n = Math.ceil(maxR / cell);
    const list = [];
    for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) {
      const d = Math.hypot(dx, dz) * cell;
      if (d <= maxR) list.push([dx, dz, d]);
    }
    list.sort((a, b) => a[2] - b[2]);
    this.spiral = list;
  }

  /** 毎フレーム呼ぶ。必要なときだけ近景インスタンスを作り直す */
  update(playerPos, game, time, aid) {
    const pile = this.pile;
    const moved = this.lastBuildPos.distanceToSquared(playerPos) > 0.25 * 0.25;
    if (pile.version !== this.lastVersion) {
      this._updateSurface(false);
      this._rebuildNear(playerPos);
      this._updateChirimon(playerPos);
      this.lastVersion = pile.version;
    } else if (moved) {
      this._rebuildNear(playerPos);
      this._updateChirimon(playerPos);
    }
    // キラリ（ルーペ／視認性補助）
    for (const s of this.sparkles) {
      const vis = aid && s.userData.dist < 4.5;
      s.visible = vis;
      if (vis) {
        const t = (Math.sin(time * 3 + s.userData.phase) + 1) / 2;
        s.material.opacity = 0.25 + t * 0.75;
        s.scale.setScalar(0.04 + t * 0.03);
      }
    }
  }

  _rebuildNear(playerPos) {
    const pile = this.pile, q = this.q;
    this.lastBuildPos.copy(playerPos);
    if (!this.spiral || this.spiralR !== q.nearRadius) { this._buildSpiral(q.nearRadius); this.spiralR = q.nearRadius; }
    const G = pile.G;
    const pix = Math.floor((playerPos.x - pile.x0) / pile.cell);
    const piz = Math.floor((playerPos.z - pile.z0) / pile.cell);
    const nearR = q.nearRadius * 0.55;
    const capN = this.near.instanceMatrix.count, capM = this.mid.instanceMatrix.count;
    let nN = 0, nM = 0;
    const tf = this.tf, m = this._m, quat = this._q, e = this._e, p = this._p, s = this._s, col = this._c;
    const nearArr = this.near.instanceMatrix.array, midArr = this.mid.instanceMatrix.array;
    const colArr = this.near.instanceColor.array, midCol = this.mid.instanceColor.array;
    for (const [dx, dz, d] of this.spiral) {
      const ix = pix + dx, iz = piz + dz;
      if (ix < 0 || iz < 0 || ix >= G || iz >= G) continue;
      const c = iz * G + ix;
      if (!pile.hasAny(c)) continue;
      const isNear = d <= nearR;
      if (isNear && nN >= capN) continue;
      if (!isNear && nM >= capM) break;
      const K = isNear ? q.perColumn : Math.max(2, q.perColumn >> 2);
      const slope = this._slopeQuat(c);
      const chiriHere = pile.chiriByCol.get(c);
      let shown = 0;
      const topH = pile.topH[c];
      // 掘った深さで色を濃くする（表面メッシュと同じ色合い）
      const dug = Math.sqrt(Math.min(1, Math.max(0, (pile.h0[c] - topH) / 0.04)));
      const dr = 1 - 0.3 * dug, dg = 1 - 0.38 * dug, db = 1 - 0.52 * dug;
      // 崩れて積もった層 → 元からある個体の順に、表面近くのものを描く
      pile.forEachExposed(c, (id, _y, _k, j) => {
        if (chiriHere && chiriHere.includes(id)) return true;
        tf.c = c; tf.j = j;
        pile.fishTransform(id, tf);
        const vy = pile.heightAt(tf.x, tf.z) - (topH - tf.y);
        e.set(tf.roll * 0.3, tf.yaw, tf.tilt * 0.3);
        quat.setFromEuler(e).premultiply(slope);
        p.set(tf.x, vy + 0.0015, tf.z);
        s.setScalar(tf.scale);
        m.compose(p, quat, s);
        if (isNear) {
          m.toArray(nearArr, nN * 16);
          const v = 0.9 + tf.tint * 0.12;
          col.setRGB(v * dr, v * 0.985 * dg, v * 0.95 * db);
          colArr[nN * 3] = col.r; colArr[nN * 3 + 1] = col.g; colArr[nN * 3 + 2] = col.b;
          nN++;
          if (nN >= capN) return false;
        } else {
          m.toArray(midArr, nM * 16);
          midCol[nM * 3] = dr; midCol[nM * 3 + 1] = dg; midCol[nM * 3 + 2] = db;
          nM++;
          if (nM >= capM) return false;
        }
        shown++;
        return shown < K;
      }, K + 8, EXPOSE_DEPTH * 1.5);
    }
    this.near.count = nN;
    this.mid.count = nM;
    this.near.instanceMatrix.needsUpdate = true;
    this.near.instanceColor.needsUpdate = true;
    this.mid.instanceMatrix.needsUpdate = true;
    this.mid.instanceColor.needsUpdate = true;
    this.stats = { near: nN, mid: nM };
  }

  /** 露出しているちりモンの詳細モデル（描画品質に関係なく同じ条件で露出する） */
  _updateChirimon(playerPos) {
    const pile = this.pile;
    const keep = new Set();
    for (const { id, species } of pile.chiriList) {
      if (pile.isRemoved(id) || !pile.isExposed(id)) continue;
      const tf = pile.visualTransform(id, {});
      const dist = Math.hypot(tf.x - playerPos.x, tf.z - playerPos.z);
      if (dist > 14) continue;
      keep.add(id);
      let m = this.chiriMeshes.get(id);
      if (!m) {
        m = new THREE.Group();
        const body = makeChirimonMesh(species);
        m.add(body);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.sparkleTex, transparent: true, depthWrite: false, depthTest: false }));
        sp.position.y = 0.03;
        sp.userData.phase = id % 7;
        m.add(sp);
        m.userData.sparkle = sp;
        this.chiriMeshes.set(id, m);
        this.group.add(m);
      }
      const c = pile.colOfFish(id);
      const depth = pile.topH[c] - pile.fishTransform(id, {}).y; // 0 .. EXPOSE_DEPTH
      m.position.set(tf.x, tf.y + 0.004 + depth * 0.2, tf.z);
      m.rotation.set(0, tf.yaw, 0);
      m.quaternion.premultiply(this._slopeQuat(c));
      m.userData.sparkle.userData.dist = dist;
    }
    for (const [id, m] of this.chiriMeshes) {
      if (!keep.has(id)) { this.group.remove(m); this.chiriMeshes.delete(id); }
    }
    this.sparkles = [...this.chiriMeshes.values()].map((m) => m.userData.sparkle);
  }

  /** 照準付近の露出ちりモン（ヒント表示用） */
  chirimonNear(p, r) {
    let best = null, bd = r;
    for (const [id, m] of this.chiriMeshes) {
      const d = m.position.distanceTo(p);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  // ===== 床 =====
  updateFloor(game) {
    const pile = this.pile, tf = {};
    const m = this._m, e = this._e, quat = this._q, p = this._p, s = this._s;
    let n = 0;
    const keep = new Set();
    for (const f of game.floor) {
      const y = Math.max(0, pile.heightAt(f.x, f.z)) + 0.003;
      if (pile.isChirimon(f.id)) {
        keep.add(f.id);
        let cm = this.floorChiri.get(f.id);
        if (!cm) { cm = makeChirimonMesh(pile.speciesOf(f.id)); this.floorChiri.set(f.id, cm); this.scene.add(cm); }
        cm.position.set(f.x, y, f.z);
        cm.rotation.y = f.rot;
        continue;
      }
      if (n >= this.floorMesh.instanceMatrix.count) continue;
      pile.fishTransform(f.id, tf);
      e.set(0, f.rot, 0);
      quat.setFromEuler(e);
      p.set(f.x, y, f.z);
      s.setScalar(tf.scale);
      m.compose(p, quat, s);
      this.floorMesh.setMatrixAt(n++, m);
    }
    for (const [id, cm] of this.floorChiri) if (!keep.has(id)) { this.scene.remove(cm); this.floorChiri.delete(id); }
    this.floorMesh.count = n;
    this.floorMesh.instanceMatrix.needsUpdate = true;
  }

  // ===== 計量機の受け皿 =====
  updateScale(game, world) {
    const pile = this.pile;
    const S = LAYOUT.scale;
    const y0 = world.scale.trayY;
    const m = this._m, e = this._e, quat = this._q, p = this._p, s = this._s, tf = {};
    let n = 0;
    const keep = new Set();
    const ids = game.scale;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const h = ((id * 2654435761) >>> 0) / 4294967296;
      const h2 = ((id * 40503 + 12345) >>> 0) % 1000 / 1000;
      const x = S.x + (h - 0.5) * 0.5, z = S.z + (h2 - 0.5) * 0.42;
      const layer = Math.floor(i / 60) * 0.004;
      if (pile.isChirimon(id)) {
        keep.add(id);
        let cm = this.scaleChiri.get(id);
        if (!cm) { cm = makeChirimonMesh(pile.speciesOf(id)); this.scaleChiri.set(id, cm); this.scene.add(cm); }
        cm.position.set(x, y0 + 0.012 + layer, z);
        continue;
      }
      if (n >= this.scaleMesh.instanceMatrix.count) continue;
      pile.fishTransform(id, tf);
      e.set(0, tf.yaw, 0);
      quat.setFromEuler(e);
      p.set(x, y0 + 0.003 + layer, z);
      s.setScalar(tf.scale);
      m.compose(p, quat, s);
      this.scaleMesh.setMatrixAt(n++, m);
    }
    for (const [id, cm] of this.scaleChiri) if (!keep.has(id)) { this.scene.remove(cm); this.scaleChiri.delete(id); }
    this.scaleMesh.count = n;
    this.scaleMesh.instanceMatrix.needsUpdate = true;
  }

  // ===== 完成パック =====
  updatePacks(packs) {
    const Sh = LAYOUT.shelf;
    const n = Math.min(packs, this.packMesh.instanceMatrix.count);
    const m = this._m;
    for (let i = 0; i < n; i++) {
      const level = Math.floor(i / 24) % 4, j = i % 24;
      const row = Math.floor(j / 8), colI = j % 8;
      const stackUp = 0;
      m.makeTranslation(Sh.x - 0.3 + row * 0.25, 0.19 + level * 0.45 + stackUp, Sh.z - 0.7 + colI * 0.19);
      this.packMesh.setMatrixAt(i, m);
    }
    this.packMesh.count = n;
    this.packMesh.instanceMatrix.needsUpdate = true;
  }

  // ===== 保護ケース =====
  updateCase(game, world) {
    const pile = this.pile;
    const ids = [];
    for (const [id, st] of game.chiriState) if (st === 'protected') ids.push(id);
    ids.sort((a, b) => pile.speciesOf(a) - pile.speciesOf(b) || a - b);
    const key = ids.join(',');
    if (key === this.caseShown) return;
    this.caseShown = key;
    this.caseItems.clear();
    const C = LAYOUT.case;
    ids.slice(0, 60).forEach((id, i) => {
      const cm = makeChirimonMesh(pile.speciesOf(id));
      cm.scale.multiplyScalar(1.6);
      const row = Math.floor(i / 12), col = i % 12;
      cm.position.set(C.x - 0.5 + col * 0.09, world.caseRef.floorY + 0.002, C.z - 0.2 + row * 0.1);
      cm.rotation.y = -Math.PI / 2 + ((id % 5) - 2) * 0.2;
      this.caseItems.add(cm);
    });
  }
}

export { SPECIES, PACK_SIZE };
