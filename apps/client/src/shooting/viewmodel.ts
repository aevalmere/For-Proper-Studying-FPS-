// Graybox paintball marker held at the lower right: chunky toy-colored boxes and
// cylinders with a hopper on top in the marker's paint color. One model per marker,
// swapped on weapon switch with a short raise animation, kicked back per shot.
//
// The viewmodel draws after the world with the depth buffer cleared, so it never
// clips into walls. All its materials are in the transparent queue (opacity 1) with
// a high renderOrder so they draw last; the first part clears depth before drawing.

import * as THREE from 'three';
import type { Vec3, WeaponId } from '@splat/shared';
import { WEAPONS } from '@splat/shared';

const RENDER_ORDER = 1000;
/** model origin relative to the camera, in camera space (camera looks down -Z) */
const HOLD = new THREE.Vector3(5.6, -5.4, -10.5);
/** model parts are authored at a comfortable size, then shrunk to sit in the corner */
const MODEL_SCALE = 0.52;
const SWITCH_TIME = 0.22;
const KICK_RETURN = 14;

interface Model {
  group: THREE.Group;
  muzzle: THREE.Object3D;
}

interface Palette {
  body: number;
  barrel: number;
  accent: number;
  hopper: string;
}

const PALETTES: Record<WeaponId, Palette> = {
  splatter: { body: 0x22c3ae, barrel: 0xffd23f, accent: 0x6a3df0, hopper: WEAPONS.splatter.paintColor },
  lobber: { body: 0x7b4dff, barrel: 0x22c3ae, accent: 0xffd23f, hopper: WEAPONS.lobber.paintColor },
  spritzer: { body: 0xffc83d, barrel: 0xff5f8f, accent: 0x2b8cff, hopper: WEAPONS.spritzer.paintColor },
};

export class Viewmodel {
  readonly root = new THREE.Group();
  private readonly models = {} as Record<WeaponId, Model>;
  private readonly disposables: { dispose(): void }[] = [];
  private active: WeaponId = 'splatter';
  private kick = 0;
  private raise = 1;
  private readonly camPos = new THREE.Vector3();
  private readonly camQuat = new THREE.Quaternion();
  /** muzzle position at the last render, world space (where a new ball should appear) */
  readonly muzzleWorld = new THREE.Vector3();
  /** muzzle minus camera position at the last render, world space */
  readonly muzzleOffset: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(renderer: THREE.WebGLRenderer) {
    const clearDepth = () => renderer.clearDepth();
    for (const id of Object.keys(PALETTES) as WeaponId[]) {
      const m = this.build(id);
      m.group.scale.setScalar(MODEL_SCALE);
      m.group.visible = id === this.active;
      this.models[id] = m;
      this.root.add(m.group);
    }
    // the lowest-order part of each model clears depth right before it draws
    for (const m of Object.values(this.models)) {
      const first = m.group.children[0] as THREE.Mesh;
      first.onBeforeRender = clearDepth;
    }
    this.root.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  private mat(color: number | string): THREE.MeshLambertMaterial {
    const c = new THREE.Color(color);
    const m = new THREE.MeshLambertMaterial({
      color: c,
      emissive: c.clone().multiplyScalar(0.42),
      transparent: true,
      opacity: 1,
      depthWrite: true,
    });
    this.disposables.push(m);
    return m;
  }

  private part(group: THREE.Group, geom: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    this.disposables.push(geom);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(x, y, z);
    mesh.renderOrder = RENDER_ORDER + group.children.length;
    group.add(mesh);
    return mesh;
  }

  /** Barrel along -Z. Units are world units at arm's length (about 10 u from the eye). */
  private build(id: WeaponId): Model {
    const pal = PALETTES[id];
    const g = new THREE.Group();
    const body = this.mat(pal.body);
    const barrel = this.mat(pal.barrel);
    const accent = this.mat(pal.accent);
    const hopper = this.mat(pal.hopper);
    const dark = this.mat(0x2a2540);

    const barrelLen = id === 'splatter' ? 9 : id === 'lobber' ? 6 : 7;
    const barrelR = id === 'splatter' ? 0.55 : id === 'lobber' ? 1.05 : 0.75;

    // receiver body (first child: clears depth)
    this.part(g, new THREE.BoxGeometry(2.2, 2.6, 7), body, 0, 0, 0);
    // barrel
    const b = this.part(g, new THREE.CylinderGeometry(barrelR, barrelR, barrelLen, 14), barrel, 0, 0.4, -3.5 - barrelLen / 2);
    b.rotation.x = Math.PI / 2;
    // muzzle ring / Spritzer's flared nozzle
    if (id === 'spritzer') {
      const cone = this.part(g, new THREE.CylinderGeometry(1.6, barrelR, 2.2, 16, 1, true), accent, 0, 0.4, -3.5 - barrelLen - 1);
      cone.rotation.x = -Math.PI / 2;
      (cone.material as THREE.Material).side = THREE.DoubleSide;
      // pump handle under the barrel
      this.part(g, new THREE.BoxGeometry(1.6, 1.2, 3), dark, 0, -0.9, -6.5);
    } else {
      const ring = this.part(g, new THREE.CylinderGeometry(barrelR + 0.35, barrelR + 0.35, 0.8, 14), accent, 0, 0.4, -3.5 - barrelLen + 0.4);
      ring.rotation.x = Math.PI / 2;
    }
    // hopper: a round paint tank on top, in the marker's paint color
    const hopperR = id === 'lobber' ? 2.3 : 1.9;
    this.part(g, new THREE.CylinderGeometry(hopperR * 0.55, hopperR * 0.45, 1.2, 12), dark, 0, 1.8, 0.2);
    const h = this.part(g, new THREE.SphereGeometry(hopperR, 16, 12), hopper, 0, 2.4 + hopperR * 0.8, 0.2);
    h.scale.set(1, 0.85, 1.15);
    // grip and trigger guard
    const grip = this.part(g, new THREE.BoxGeometry(1.5, 3.4, 1.8), accent, 0, -2.6, 1.6);
    grip.rotation.x = -0.25;
    this.part(g, new THREE.BoxGeometry(0.5, 1.4, 2.2), dark, 0, -1.8, -0.2);
    // air tank out the back
    const tank = this.part(g, new THREE.CylinderGeometry(0.95, 0.95, 4.5, 14), barrel, 0, -0.6, 5.2);
    tank.rotation.x = Math.PI / 2;

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.4, -3.5 - barrelLen - (id === 'spritzer' ? 2 : 0));
    g.add(muzzle);
    return { group: g, muzzle };
  }

  setActive(id: WeaponId): void {
    if (id === this.active) return;
    this.models[this.active].group.visible = false;
    this.active = id;
    this.models[id].group.visible = true;
    this.raise = 1;
  }

  onShot(): void {
    this.kick = 1;
  }

  /** Place the model at the camera; call each frame after the camera is positioned. */
  update(camera: THREE.PerspectiveCamera, frameDt: number, kickDistance: number): void {
    camera.getWorldPosition(this.camPos);
    camera.getWorldQuaternion(this.camQuat);
    this.root.position.copy(this.camPos);
    this.root.quaternion.copy(this.camQuat);

    this.kick *= Math.exp(-KICK_RETURN * frameDt);
    this.raise = Math.max(0, this.raise - frameDt / SWITCH_TIME);
    const r = this.raise * this.raise;

    // the back of the model sits ~6 u from the eye; slide it out past a far near plane
    const push = Math.max(0, camera.near * 1.25 - 6);
    const g = this.models[this.active].group;
    g.position.set(HOLD.x, HOLD.y - r * 5, HOLD.z - push + this.kick * kickDistance);
    // aim the barrel slightly in toward the crosshair, tip up on kick and while raising
    g.rotation.set(this.kick * 0.09 + r * 0.6, 0.05, 0);

    this.root.updateMatrixWorld(true);
    this.models[this.active].muzzle.getWorldPosition(this.muzzleWorld);
    this.muzzleOffset.x = this.muzzleWorld.x - this.camPos.x;
    this.muzzleOffset.y = this.muzzleWorld.y - this.camPos.y;
    this.muzzleOffset.z = this.muzzleWorld.z - this.camPos.z;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}
