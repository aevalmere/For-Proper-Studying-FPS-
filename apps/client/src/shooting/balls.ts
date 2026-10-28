// Draws live paintballs as one instanced mesh of small bright spheres, interpolated
// between ticks. The sim fires from the eye; for the first few frames each ball is
// drawn offset toward the marker's muzzle so it visibly leaves the barrel.

import * as THREE from 'three';
import type { Projectile, Vec3, WeaponId } from '@splat/shared';

/** Seconds over which a ball's drawn position slides from the muzzle onto its true path. */
const MUZZLE_BLEND = 0.09;

const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();

export class BallRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly capacity: number;
  /** muzzle-minus-eye offset captured at spawn; dies with the ball */
  private readonly spawnOffset = new WeakMap<Projectile, Vec3>();

  constructor(capacity = 512) {
    this.capacity = capacity;
    this.geometry = new THREE.SphereGeometry(1, 12, 8);
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  onSpawn(p: Projectile, muzzleOffset: Vec3): void {
    this.spawnOffset.set(p, { x: muzzleOffset.x, y: muzzleOffset.y, z: muzzleOffset.z });
  }

  /** `dt` is the sim tick length, used to turn `alpha` into time along the last step. */
  update(balls: readonly Projectile[], alpha: number, dt: number, colors: Record<WeaponId, THREE.Color>, visualScale: number): void {
    let n = 0;
    for (const p of balls) {
      if (n >= this.capacity) break;
      const age = Math.max(0, p.age - dt + alpha * dt);
      tmpPos.set(
        p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha,
        p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha,
        p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha,
      );
      const off = this.spawnOffset.get(p);
      if (off && age < MUZZLE_BLEND) {
        const k = 1 - age / MUZZLE_BLEND;
        const w = k * k * (3 - 2 * k);
        tmpPos.x += off.x * w;
        tmpPos.y += off.y * w;
        tmpPos.z += off.z * w;
      }
      // shrink out over the end of the lifetime instead of popping
      const fade = Math.min(0.08, p.lifetime * 0.3);
      const life = fade > 0 ? Math.min(1, Math.max(0, (p.lifetime - age) / fade)) : 1;
      const r = Math.max(0.01, p.radius * visualScale * life);
      tmpScale.set(r, r, r);
      tmpMat.compose(tmpPos, IDENTITY, tmpScale);
      this.mesh.setMatrixAt(n, tmpMat);
      this.mesh.setColorAt(n, colors[p.weapon]);
      n++;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
