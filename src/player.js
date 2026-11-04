// 一人称の移動と当たり判定
import { ROOM, PLAYER_RADIUS, PILE_BLOCK_HEIGHT, EYE_HEIGHT } from './config.js';

export class Player {
  constructor(spawn) {
    this.x = spawn.x; this.z = spawn.z;
    this.yaw = spawn.yaw; this.pitch = -0.25;
    this.bob = 0;
    this.speed = 3.2;
  }

  eyeY(bobOn) {
    return EYE_HEIGHT + (bobOn ? Math.sin(this.bob) * 0.025 : 0);
  }

  /**
   * @param {number} dt
   * @param {{x:number,y:number}} move -1..1（y=前）
   * @param {number} speedMul
   * @param {object} pile
   * @param {Array} obstacles
   */
  update(dt, move, speedMul, pile, obstacles) {
    const len = Math.hypot(move.x, move.y);
    if (len < 0.01) return;
    const mx = move.x / Math.max(1, len), my = move.y / Math.max(1, len);
    const sp = this.speed * speedMul * dt;
    // 前方 = (-sin yaw, -cos yaw)
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const dx = (fx * my + rx * mx) * sp, dz = (fz * my + rz * mx) * sp;
    if (this._free(this.x + dx, this.z, pile, obstacles)) this.x += dx;
    if (this._free(this.x, this.z + dz, pile, obstacles)) this.z += dz;
    this.bob += Math.hypot(dx, dz) * 9;
  }

  _free(x, z, pile, obstacles) {
    const r = PLAYER_RADIUS;
    if (x < ROOM.minX + r || x > ROOM.maxX - r || z < ROOM.minZ + r || z > ROOM.maxZ - r) return false;
    for (const o of obstacles) {
      if (x > o.minX - r && x < o.maxX + r && z > o.minZ - r && z < o.maxZ + r) return false;
    }
    // 山：一定以上の高さがある場所には踏み込めない（掘れば奥へ進める）
    if (Math.hypot(x - pile.cx, z - pile.cz) < pile.radius + r + 0.2) {
      for (let i = 0; i < 9; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rr = i === 8 ? 0 : r;
        if (pile.heightAt(x + Math.cos(a) * rr, z + Math.sin(a) * rr) > PILE_BLOCK_HEIGHT) return false;
      }
    }
    return true;
  }
}
