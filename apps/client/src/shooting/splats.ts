// Paint splat decals: flat blobs laid on a surface, oriented to its normal, with a
// random spin and stretch. Stored in a ring buffer over a few instanced meshes (one
// per blob shape), so the oldest splat is recycled once the cap is reached.

import * as THREE from 'three';
import { createRng, nextFloat, nextRange, type Rng, type Vec3 } from '@splat/shared';

const VARIANTS = 3;
const TAU = Math.PI * 2;

/** Ring of `n` points around (cx, cy), radius wobbled by a few sine lobes. */
function pushBlob(out: number[], rng: Rng, cx: number, cy: number, r: number, n: number, wobble: number): void {
  const lobes = [3, 5, 8].map((k) => ({ k, amp: wobble * nextRange(rng, 0.4, 1) / Math.sqrt(k / 3), phase: nextFloat(rng) * TAU }));
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    let rr = 1;
    for (const l of lobes) rr += l.amp * Math.sin(l.k * a + l.phase);
    pts.push([cx + Math.cos(a) * r * rr, cy + Math.sin(a) * r * rr]);
  }
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % n]!;
    // counter-clockwise seen from +Z, so the face points along the surface normal
    out.push(cx, cy, 0, p[0], p[1], 0, q[0], q[1], 0);
  }
}

/** A unit-radius splat in the XY plane facing +Z: a lumpy blob plus a few droplets. */
function makeSplatGeometry(seed: number): THREE.BufferGeometry {
  const rng = createRng(seed);
  const pos: number[] = [];
  pushBlob(pos, rng, 0, 0, 1, 32, 0.14);
  const drops = 3 + Math.floor(nextFloat(rng) * 3);
  for (let i = 0; i < drops; i++) {
    const a = nextFloat(rng) * TAU;
    const d = nextRange(rng, 1.15, 1.55);
    pushBlob(pos, rng, Math.cos(a) * d, Math.sin(a) * d, nextRange(rng, 0.08, 0.2), 10, 0.08);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  return g;
}

const Z = new THREE.Vector3(0, 0, 1);
const tmpPos = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const spinQuat = new THREE.Quaternion();
const tmpMat = new THREE.Matrix4();
const tmpColor = new THREE.Color();

export class SplatDecals {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly material: THREE.MeshBasicMaterial;
  private readonly maxCount: number;
  private readonly offset: number;
  private ringSize: number;
  /** next ring slot to write */
  private cursor = 0;
  /** slots in use (≤ ringSize) */
  private used = 0;

  /**
   * @param maxCount instances allocated up front (the cap can't exceed it)
   * @param cap ring size: how many splats are kept
   * @param offset lift off the surface along the normal, against z-fighting
   */
  constructor(maxCount: number, cap: number, offset: number) {
    this.maxCount = maxCount;
    this.offset = offset;
    this.ringSize = Math.max(1, Math.min(maxCount, Math.floor(cap)));
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const per = Math.ceil(maxCount / VARIANTS);
    for (let v = 0; v < VARIANTS; v++) {
      const geom = makeSplatGeometry(0x5a1a7 + v * 7919);
      const mesh = new THREE.InstancedMesh(geom, this.material, per);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(per * 3), 3);
      mesh.count = 0;
      // instance bounds change constantly; skip culling rather than recompute spheres
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this.geometries.push(geom);
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  get cap(): number {
    return this.ringSize;
  }

  get count(): number {
    return this.used;
  }

  /** Change the ring size. Clears existing splats (it's a dev knob). */
  setCap(cap: number): void {
    const next = Math.max(1, Math.min(this.maxCount, Math.floor(cap)));
    if (next === this.ringSize) return;
    this.ringSize = next;
    this.clear();
  }

  clear(): void {
    this.cursor = 0;
    this.used = 0;
    for (const m of this.meshes) m.count = 0;
  }

  /**
   * Lay a splat at `point` facing `normal` (in this group's space). `seed` picks the
   * spin, stretch, and shade so the same ball always makes the same splat.
   */
  add(point: Vec3, normal: Vec3, radius: number, color: THREE.Color, seed: number): void {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.ringSize;
    this.used = Math.min(this.used + 1, this.ringSize);

    const rng = createRng(Math.imul(seed, 0x9e3779b1) ^ 0x51a7);
    tmpNormal.set(normal.x, normal.y, normal.z).normalize();
    tmpQuat.setFromUnitVectors(Z, tmpNormal);
    spinQuat.setFromAxisAngle(Z, nextFloat(rng) * TAU);
    tmpQuat.multiply(spinQuat);
    const stretch = nextRange(rng, 0.85, 1.2);
    const size = radius * nextRange(rng, 0.85, 1.1);
    tmpScale.set(size * stretch, size / stretch, 1);
    // later slots sit a hair higher so overlapping splats don't flicker
    const lift = this.offset * (1 + (slot % 8) * 0.06);
    tmpPos.set(point.x, point.y, point.z).addScaledVector(tmpNormal, lift);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);

    const mesh = this.meshes[slot % VARIANTS]!;
    const index = Math.floor(slot / VARIANTS);
    mesh.setMatrixAt(index, tmpMat);
    tmpColor.copy(color).offsetHSL(0, 0, nextRange(rng, -0.06, 0.04));
    mesh.setColorAt(index, tmpColor);
    // upload only this slot; three.js clears the ranges after each upload
    mesh.instanceMatrix.addUpdateRange(index * 16, 16);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.addUpdateRange(index * 3, 3);
    mesh.instanceColor!.needsUpdate = true;
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v]!.count = Math.max(0, Math.ceil((this.used - v) / VARIANTS));
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.meshes) m.dispose();
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
  }
}
