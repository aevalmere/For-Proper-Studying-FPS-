// Draws live paintballs as one instanced mesh of bright spheres, interpolated
// between ticks, at exactly their sim radius (what you see is what hits).
//
// The sim fires from the eye along the crosshair ray. So the ball visibly leaves
// the marker, each one is drawn offset toward the muzzle at spawn and the offset
// shrinks linearly to zero over MUZZLE_BLEND: a straight line from the muzzle onto
// the true path, joined within ~3 frames. The sim path itself is never changed.
//
// A ball that times out in the air stops and pops (a quick swell and shrink) where
// it died, so a Spritzer's range limit is visible. With "show hitboxes" on, each
// ball also gets a wireframe sphere of its target-hit radius on the true sim path.

import * as THREE from 'three';
import type { Projectile, Vec3, WeaponId } from '@splat/shared';
import { DEBUG_RENDER_ORDER } from './debugDraw.ts';

/** Seconds over which a ball's drawn position slides from the muzzle onto its true path. */
const MUZZLE_BLEND = 0.05;
/** Muzzle offsets are kept per ball id in a ring this size (ids are sequential). */
const OFFSET_SLOTS = 256;
const POP_TIME = 0.14;
const MAX_POPS = 64;

const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();

export class BallRenderer {
  readonly mesh: THREE.InstancedMesh;
  /** debug: target-hit radius of every live ball, on its sim position */
  readonly hitMesh: THREE.InstancedMesh;
  private readonly geometry = new THREE.SphereGeometry(1, 12, 8);
  private readonly hitGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private readonly hitMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    wireframe: true,
    transparent: true,
    opacity: 0.7,
    depthTest: false,
    depthWrite: false,
  });
  private readonly capacity: number;
  private readonly offsets = new Float32Array(OFFSET_SLOTS * 3);
  private readonly offsetIds = new Float64Array(OFFSET_SLOTS).fill(-1);
  // pops: x, y, z, radius, age per slot, plus the weapon for the color
  private readonly pops = new Float32Array(MAX_POPS * 5);
  private readonly popWeapon: WeaponId[] = new Array<WeaponId>(MAX_POPS).fill('splatter');
  private popCursor = 0;

  constructor(capacity = 512) {
    this.capacity = capacity;
    const total = capacity + MAX_POPS;
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, total);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;

    this.hitMesh = new THREE.InstancedMesh(this.hitGeometry, this.hitMaterial, capacity);
    this.hitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hitMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.hitMesh.count = 0;
    this.hitMesh.frustumCulled = false;
    this.hitMesh.renderOrder = DEBUG_RENDER_ORDER + 1;
    this.hitMesh.visible = false;
    for (let i = 0; i < MAX_POPS; i++) this.pops[i * 5 + 4] = POP_TIME;
  }

  /** `offset` = drawn muzzle position minus the ball's spawn position (the eye), world space. */
  onSpawn(p: Projectile, offset: Vec3): void {
    const slot = p.id % OFFSET_SLOTS;
    this.offsetIds[slot] = p.id;
    this.offsets[slot * 3] = offset.x;
    this.offsets[slot * 3 + 1] = offset.y;
    this.offsets[slot * 3 + 2] = offset.z;
  }

  /** A ball timed out in the air: pop it where it is. */
  onExpire(p: Projectile): void {
    const i = this.popCursor;
    this.popCursor = (i + 1) % MAX_POPS;
    const o = i * 5;
    this.pops[o] = p.pos.x;
    this.pops[o + 1] = p.pos.y;
    this.pops[o + 2] = p.pos.z;
    this.pops[o + 3] = p.radius;
    this.pops[o + 4] = 0;
    this.popWeapon[i] = p.weapon;
  }

  /** `dt` is the sim tick length, used to turn `alpha` into time along the last step. */
  update(
    balls: readonly Projectile[],
    alpha: number,
    dt: number,
    frameDt: number,
    colors: Record<WeaponId, THREE.Color>,
    showHitRadius: boolean,
  ): void {
    let n = 0;
    let h = 0;
    this.hitMesh.visible = showHitRadius;
    for (let i = 0; i < balls.length && n < this.capacity; i++) {
      const p = balls[i]!;
      const age = Math.max(0, p.age - dt + alpha * dt);
      tmpPos.set(
        p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha,
        p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha,
        p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha,
      );
      if (showHitRadius) {
        const r = p.radius + p.hitRadiusBonus;
        tmpScale.set(r, r, r);
        tmpMat.compose(tmpPos, IDENTITY, tmpScale);
        this.hitMesh.setMatrixAt(h, tmpMat);
        this.hitMesh.setColorAt(h, colors[p.weapon]);
        h++;
      }
      const slot = p.id % OFFSET_SLOTS;
      if (age < MUZZLE_BLEND && this.offsetIds[slot] === p.id) {
        const w = 1 - age / MUZZLE_BLEND;
        tmpPos.x += this.offsets[slot * 3]! * w;
        tmpPos.y += this.offsets[slot * 3 + 1]! * w;
        tmpPos.z += this.offsets[slot * 3 + 2]! * w;
      }
      tmpScale.set(p.radius, p.radius, p.radius);
      tmpMat.compose(tmpPos, IDENTITY, tmpScale);
      this.mesh.setMatrixAt(n, tmpMat);
      this.mesh.setColorAt(n, colors[p.weapon]);
      n++;
    }

    for (let i = 0; i < MAX_POPS; i++) {
      const o = i * 5;
      const t = this.pops[o + 4]!;
      if (t >= POP_TIME) continue;
      this.pops[o + 4] = t + frameDt;
      const k = t / POP_TIME;
      // swell to 1.5x over the first third, then shrink away
      const s = this.pops[o + 3]! * (k < 0.33 ? 1 + 1.5 * k : 1.5 * (1 - (k - 0.33) / 0.67));
      tmpPos.set(this.pops[o]!, this.pops[o + 1]!, this.pops[o + 2]!);
      tmpScale.set(s, s, s);
      tmpMat.compose(tmpPos, IDENTITY, tmpScale);
      this.mesh.setMatrixAt(n, tmpMat);
      this.mesh.setColorAt(n, colors[this.popWeapon[i]!]);
      n++;
    }

    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor!.needsUpdate = true;
    }
    this.hitMesh.count = h;
    if (h > 0) {
      this.hitMesh.instanceMatrix.needsUpdate = true;
      this.hitMesh.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.hitMesh.removeFromParent();
    this.mesh.dispose();
    this.hitMesh.dispose();
    this.geometry.dispose();
    this.hitGeometry.dispose();
    this.material.dispose();
    this.hitMaterial.dispose();
  }
}
