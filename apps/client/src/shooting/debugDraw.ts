// Debug drawing for "show hitboxes": capsule wireframes built from the sim's
// HitCapsule numbers (so they show what the projectile test uses, not what the mesh
// claims), and markers at exact hit points. Everything draws on top of the world.

import * as THREE from 'three';
import type { Vec3 } from '@splat/shared';

const TAU = Math.PI * 2;
/** Draw order above the world, splats and balls (the viewmodel uses 1000+). */
export const DEBUG_RENDER_ORDER = 900;

/**
 * Outline of a vertical capsule standing on y = 0 (feet), as line segments: rings
 * where the caps meet the side and halfway up each cap, plus four vertical profiles.
 * Same clamping as the sim: a capsule shorter than 2·radius is a sphere.
 */
export function capsuleWireGeometry(radius: number, height: number, segments = 24): THREE.BufferGeometry {
  const core = Math.max(0, Math.min(radius, height / 2));
  const y0 = core;
  const y1 = height - core;
  const pts: number[] = [];
  const ring = (y: number, r: number) => {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * TAU;
      const b = ((i + 1) / segments) * TAU;
      pts.push(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(b) * r, y, Math.sin(b) * r);
    }
  };
  ring(y0, core);
  if (y1 > y0) ring(y1, core);
  const lat = Math.PI / 4;
  ring(y1 + Math.sin(lat) * core, Math.cos(lat) * core);
  ring(y0 - Math.sin(lat) * core, Math.cos(lat) * core);

  const half = segments / 2;
  for (let m = 0; m < 4; m++) {
    const yaw = (m / 4) * Math.PI;
    const cx = Math.cos(yaw);
    const cz = Math.sin(yaw);
    // full outline in this vertical plane: top arc, bottom arc, two straight sides
    for (let i = 0; i < half; i++) {
      const a = (i / half) * Math.PI;
      const b = ((i + 1) / half) * Math.PI;
      pts.push(Math.cos(a) * core * cx, y1 + Math.sin(a) * core, Math.cos(a) * core * cz);
      pts.push(Math.cos(b) * core * cx, y1 + Math.sin(b) * core, Math.cos(b) * core * cz);
      pts.push(Math.cos(a) * core * cx, y0 - Math.sin(a) * core, Math.cos(a) * core * cz);
      pts.push(Math.cos(b) * core * cx, y0 - Math.sin(b) * core, Math.cos(b) * core * cz);
    }
    if (y1 > y0) {
      for (const s of [1, -1]) pts.push(s * core * cx, y0, s * core * cz, s * core * cx, y1, s * core * cz);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.computeBoundingSphere();
  return g;
}

export function debugLineMaterial(color: number, opacity = 0.9): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
}

const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();

/** Ring buffer of small diamonds marking where balls hit (targets and world in different colors). */
export class HitMarkers {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry = new THREE.OctahedronGeometry(1);
  private readonly material = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true });
  private readonly capacity: number;
  private cursor = 0;
  private used = 0;

  constructor(capacity = 48) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = DEBUG_RENDER_ORDER + 2;
    this.mesh.visible = false;
  }

  add(p: Vec3, color: THREE.Color, size: number): void {
    tmpPos.set(p.x, p.y, p.z);
    tmpScale.set(size, size, size);
    tmpMat.compose(tmpPos, IDENTITY, tmpScale);
    this.mesh.setMatrixAt(this.cursor, tmpMat);
    this.mesh.setColorAt(this.cursor, color);
    this.cursor = (this.cursor + 1) % this.capacity;
    this.used = Math.min(this.capacity, this.used + 1);
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  clear(): void {
    this.cursor = 0;
    this.used = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
