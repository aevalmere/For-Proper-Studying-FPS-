// Offline target range: graybox dummies at map.dummySpawns, the same size as the
// player hull, each with a paint meter. Hits fill the meter; a full meter splats the
// dummy (it turns paint-colored and freezes), and it resets after a few seconds.
//
// Dummies turn to face the local player. Every dummy except each third one strafes
// side to side across the player's line of sight; the strafe axis is re-aimed only
// as the dummy passes its center, so it never jumps. Strafe range is clamped so a
// dummy can't slide into a wall or a neighbour.
//
// Dummy state is stepped on the fixed tick so the hitboxes the projectile sim sees
// match where the balls were traced; meshes interpolate between ticks.

import * as THREE from 'three';
import {
  type CollisionWorld,
  type HitBox,
  type MapDef,
  type MovementConfig,
  type Paintable,
  type ProjectileHit,
  type Vec3,
  PAINT_FULL,
  applyPaint,
  createPlayerState,
  getHull,
  traceRay,
  vec3,
} from '@splat/shared';
import type { ShootingSettings } from './settings.ts';
import { SplatDecals } from './splats.ts';

/** Hitbox ids for dummies start here; the local player is id 1. */
export const DUMMY_ID_BASE = 1000;
const SPLATS_PER_DUMMY = 24;
const BODY_COLOR = new THREE.Color(0xd9d3c3);
const METER_WIDTH = 32;
const METER_HEIGHT = 3;
/** how far a wall/room probe reaches, u */
const ROOM_REACH = 512;
/** body turn rate toward the player, 1/s */
const TURN_RATE = 6;

interface Dummy {
  id: number;
  base: Vec3;
  /** horizontal unit vector the dummy strafes along */
  axis: Vec3;
  /** largest strafe half-width the walls and neighbours allow on the current axis */
  room: number;
  offset: number;
  prevOffset: number;
  dir: number;
  strafes: boolean;
  meter: Paintable;
  paintColor: THREE.Color;
  resetTimer: number;
  flash: number;
  hitbox: HitBox;
  root: THREE.Group;
  body: THREE.Group;
  bodyMat: THREE.MeshLambertMaterial;
  splats: SplatDecals;
  meterFill: THREE.Mesh;
  meterFillMat: THREE.MeshBasicMaterial;
  meterGroup: THREE.Group;
  label: THREE.Sprite;
  /** capsule radius and height, for snapping splats onto the body */
  radius: number;
  height: number;
}

function makeLabelTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = '#1b1530';
  g.strokeText('SPLATTED!', 128, 34);
  g.fillStyle = '#ffffff';
  g.fillText('SPLATTED!', 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Shortest signed angle from a to b. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const tmpLocal = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const invQuat = new THREE.Quaternion();
const lerpColor = new THREE.Color();
const camPos = new THREE.Vector3();
const probeStart = vec3();
const probeEnd = vec3();

export class TargetRange {
  readonly hitboxes: HitBox[] = [];
  readonly group = new THREE.Group();
  private readonly dummies: Dummy[] = [];
  private readonly settings: ShootingSettings;
  private readonly world: CollisionWorld;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(map: MapDef, world: CollisionWorld, movement: MovementConfig, settings: ShootingSettings, viewer: Vec3) {
    this.settings = settings;
    this.world = world;
    const labelTex = makeLabelTexture();
    const labelMat = new THREE.SpriteMaterial({ map: labelTex, depthWrite: false });
    const meterBgMat = new THREE.MeshBasicMaterial({ color: 0x1b1530 });
    const baseMat = new THREE.MeshLambertMaterial({ color: 0x5b5f6b, emissive: 0x1d1f24 });
    const visorMat = new THREE.MeshLambertMaterial({ color: 0x2b2f3a, emissive: 0x15171c });
    const meterBgGeom = new THREE.PlaneGeometry(METER_WIDTH + 2, METER_HEIGHT + 2);
    const meterFillGeom = new THREE.PlaneGeometry(METER_WIDTH, METER_HEIGHT).translate(METER_WIDTH / 2, 0, 0);
    this.disposables.push(labelTex, labelMat, meterBgMat, baseMat, visorMat, meterBgGeom, meterFillGeom);

    map.dummySpawns.forEach((pos, i) => {
      const hull = getHull(createPlayerState(pos), movement);
      const height = hull.maxs.y - hull.mins.y;
      const radius = Math.min(hull.maxs.x - hull.mins.x, hull.maxs.z - hull.mins.z) / 2;

      const root = new THREE.Group();
      root.position.set(pos.x, pos.y, pos.z);
      const body = new THREE.Group();
      body.rotation.y = Math.atan2(viewer.x - pos.x, viewer.z - pos.z);
      root.add(body);

      const bodyMat = new THREE.MeshLambertMaterial({ color: BODY_COLOR.clone(), emissive: new THREE.Color(0x3a3833) });
      const capsuleGeom = new THREE.CapsuleGeometry(radius, Math.max(0, height - radius * 2), 6, 18);
      const capsule = new THREE.Mesh(capsuleGeom, bodyMat);
      capsule.position.y = height / 2;
      capsule.castShadow = true; // only matters when the 'high' quality preset enables shadows
      body.add(capsule);

      const baseGeom = new THREE.CylinderGeometry(radius + 4, radius + 6, 2, 20);
      const stand = new THREE.Mesh(baseGeom, baseMat);
      stand.position.y = 1;
      body.add(stand);

      // visor on the front (+Z in body space) so you can tell which way it faces
      const visorGeom = new THREE.BoxGeometry(radius * 1.1, 5, 4);
      const visor = new THREE.Mesh(visorGeom, visorMat);
      visor.position.set(0, height - radius * 0.9, radius - 1.2);
      body.add(visor);

      const splats = new SplatDecals(SPLATS_PER_DUMMY, SPLATS_PER_DUMMY, 0.15);
      body.add(splats.group);

      const meterGroup = new THREE.Group();
      meterGroup.position.y = height + 10;
      const meterBg = new THREE.Mesh(meterBgGeom, meterBgMat);
      const meterFillMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const meterFill = new THREE.Mesh(meterFillGeom, meterFillMat);
      meterFill.position.set(-METER_WIDTH / 2, 0, 0.05);
      meterFill.scale.x = 0.0001;
      meterGroup.add(meterBg, meterFill);
      root.add(meterGroup);

      const label = new THREE.Sprite(labelMat);
      label.scale.set(40, 10, 1);
      label.position.y = height + 20;
      label.visible = false;
      root.add(label);

      this.group.add(root);
      this.disposables.push(capsuleGeom, baseGeom, visorGeom, bodyMat, meterFillMat, splats);

      const d: Dummy = {
        id: DUMMY_ID_BASE + i,
        base: vec3(pos.x, pos.y, pos.z),
        axis: vec3(1, 0, 0),
        room: 0,
        offset: 0,
        prevOffset: 0,
        dir: i % 2 === 0 ? 1 : -1,
        strafes: i % 3 !== 0,
        meter: { paint: 0, splatted: false },
        paintColor: new THREE.Color(0xffffff),
        resetTimer: 0,
        flash: 0,
        hitbox: { id: DUMMY_ID_BASE + i, pos: vec3(pos.x, pos.y, pos.z), mins: hull.mins, maxs: hull.maxs },
        root,
        body,
        bodyMat,
        splats,
        meterFill,
        meterFillMat,
        meterGroup,
        label,
        radius,
        height,
      };
      this.dummies.push(d);
      this.hitboxes.push(d.hitbox);
    });
    for (const d of this.dummies) this.aim(d, viewer);
  }

  /** Point the strafe axis across the line from the dummy to `viewer`, and re-measure room. */
  private aim(d: Dummy, viewer: Vec3): void {
    const tx = viewer.x - d.base.x;
    const tz = viewer.z - d.base.z;
    const len = Math.hypot(tx, tz);
    if (len > 1) {
      let ax = -tz / len;
      let az = tx / len;
      // keep the same sense as before so the motion stays continuous
      if (ax * d.axis.x + az * d.axis.z < 0) {
        ax = -ax;
        az = -az;
      }
      d.axis.x = ax;
      d.axis.z = az;
    }
    d.room = this.measureRoom(d);
  }

  /** How far the dummy can slide each way along its axis before touching a wall or a neighbour. */
  private measureRoom(d: Dummy): number {
    const p = d.base;
    const a = d.axis;
    const width = d.radius * 2;
    let room = ROOM_REACH;
    for (const sign of [1, -1]) {
      for (const h of [d.height * 0.25, d.height * 0.75]) {
        probeStart.x = p.x;
        probeStart.y = p.y + h;
        probeStart.z = p.z;
        probeEnd.x = p.x + a.x * ROOM_REACH * sign;
        probeEnd.y = p.y + h;
        probeEnd.z = p.z + a.z * ROOM_REACH * sign;
        const tr = traceRay(this.world, probeStart, probeEnd);
        room = Math.min(room, tr.fraction * ROOM_REACH - d.radius - 4);
      }
    }
    for (const o of this.dummies) {
      if (o === d) continue;
      const dx = o.base.x - p.x;
      const dz = o.base.z - p.z;
      const along = dx * a.x + dz * a.z;
      const across = Math.abs(dx * a.z - dz * a.x);
      if (across >= width + 4) continue;
      // split the gap with a neighbour that also strafes
      const gap = Math.abs(along) - width - 4;
      room = Math.min(room, o.strafes ? gap / 2 : gap);
    }
    return Math.max(0, room);
  }

  /** Step strafing and splat timers; call before projectiles so hitboxes are current. */
  fixedUpdate(dt: number, viewer: Vec3): void {
    const s = this.settings;
    for (const d of this.dummies) {
      d.prevOffset = d.offset;
      if (d.meter.splatted) {
        d.resetTimer -= dt;
        if (d.resetTimer <= 0) this.resetDummy(d);
      } else if (s.dummiesMove && d.strafes) {
        const range = Math.min(s.dummyStrafeRange, d.room);
        d.offset += d.dir * s.dummyStrafeSpeed * dt;
        if (d.offset > range) {
          d.offset = Math.max(-range, 2 * range - d.offset);
          d.dir = -1;
        } else if (d.offset < -range) {
          d.offset = Math.min(range, -2 * range - d.offset);
          d.dir = 1;
        }
        // passing the center: safe moment to re-aim at the player
        if (d.prevOffset === 0 || d.offset === 0 || Math.sign(d.offset) !== Math.sign(d.prevOffset)) this.aim(d, viewer);
      } else {
        // standing (or frozen) dummies return to their spot so they're easy to compare against
        d.offset = 0;
        d.prevOffset = 0;
      }
      d.hitbox.pos.x = d.base.x + d.axis.x * d.offset;
      d.hitbox.pos.y = d.base.y;
      d.hitbox.pos.z = d.base.z + d.axis.z * d.offset;
    }
  }

  /** Apply a projectile's target hit. Returns 'splatted' when this hit filled the meter. */
  onHit(hit: ProjectileHit, color: THREE.Color): 'hit' | 'splatted' | null {
    const d = this.dummies.find((x) => x.id === hit.target);
    if (!d) return null;
    d.flash = 0.08;
    if (!d.meter.splatted) d.paintColor.copy(color);
    const filled = applyPaint(d.meter, hit.projectile.paint);
    if (filled) d.resetTimer = this.settings.dummyResetSeconds;

    // put a small splat on the body: hit point into body space, snapped to the capsule
    tmpLocal.set(hit.point.x - d.hitbox.pos.x, hit.point.y - d.hitbox.pos.y, hit.point.z - d.hitbox.pos.z);
    invQuat.copy(d.body.quaternion).invert();
    tmpLocal.applyQuaternion(invQuat);
    const r = d.radius;
    const cy = Math.min(Math.max(tmpLocal.y, r), d.height - r);
    tmpN.set(tmpLocal.x, tmpLocal.y - cy, tmpLocal.z);
    if (tmpN.lengthSq() < 1e-6) tmpN.set(hit.normal.x, hit.normal.y, hit.normal.z).applyQuaternion(invQuat);
    tmpN.normalize();
    const point = { x: tmpN.x * r, y: cy + tmpN.y * r, z: tmpN.z * r };
    const size = Math.min(hit.projectile.splatRadius * 0.6, r * 0.7);
    d.splats.add(point, tmpN, size, color, hit.projectile.id);
    return filled ? 'splatted' : 'hit';
  }

  private resetDummy(d: Dummy): void {
    d.meter.paint = 0;
    d.meter.splatted = false;
    d.resetTimer = 0;
    d.splats.clear();
  }

  reset(): void {
    for (const d of this.dummies) {
      this.resetDummy(d);
      d.offset = 0;
      d.prevOffset = 0;
    }
  }

  render(alpha: number, frameDt: number, camera: THREE.Camera): void {
    camera.getWorldPosition(camPos);
    const turn = 1 - Math.exp(-TURN_RATE * frameDt);
    const pulse = 1 + 0.08 * Math.sin(performance.now() * 0.012);
    for (const d of this.dummies) {
      const off = d.prevOffset + (d.offset - d.prevOffset) * alpha;
      d.root.position.set(d.base.x + d.axis.x * off, d.base.y, d.base.z + d.axis.z * off);
      d.meterGroup.quaternion.copy(camera.quaternion);
      if (!d.meter.splatted) {
        const want = Math.atan2(camPos.x - d.root.position.x, camPos.z - d.root.position.z);
        d.body.rotation.y += angleDelta(d.body.rotation.y, want) * turn;
      }

      const fill = d.meter.paint / PAINT_FULL;
      d.meterFill.scale.x = Math.max(0.0001, fill);
      d.meterFillMat.color.copy(d.paintColor);

      d.flash = Math.max(0, d.flash - frameDt);
      if (d.meter.splatted) {
        d.bodyMat.color.copy(d.paintColor);
        d.bodyMat.emissive.copy(d.paintColor).multiplyScalar(0.45);
        d.label.visible = true;
        d.label.scale.set(40 * pulse, 10 * pulse, 1);
      } else {
        lerpColor.copy(BODY_COLOR).lerp(d.paintColor, fill * 0.55);
        d.bodyMat.color.copy(lerpColor);
        d.bodyMat.emissive.copy(lerpColor).multiplyScalar(d.flash > 0 ? 0.7 : 0.27);
        d.label.visible = false;
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const x of this.disposables) x.dispose();
  }
}
