// Offline target range: graybox dummies at map.dummySpawns, each with a paint meter
// and a number. Hits fill the meter; a full meter splats the dummy (it turns
// paint-colored and freezes), and it resets after a few seconds.
//
// Hitbox = mesh: each dummy's HitCapsule comes from playerHitCapsule (the same
// volume a player will have), and its body mesh and debug wireframe are built from
// that capsule's radius and height, so what you see is exactly what the balls test.
// A round body makes facing irrelevant to hits, so dummies keep turning to face
// you (the visor shows it), and splats are stored on the capsule in root space so
// they stay where they landed while the body turns.
//
// Every dummy except each third one strafes side to side across the player's line
// of sight; the strafe axis is re-aimed only as the dummy passes its center, so it
// never jumps. Strafe range is clamped so a dummy can't slide into a wall or a
// neighbour. Dummy state is stepped on the fixed tick (hitbox prevPos/pos for the
// swept test); meshes interpolate between ticks like the balls do.

import * as THREE from 'three';
import {
  type CollisionWorld,
  type HitCapsule,
  type MapDef,
  type MovementConfig,
  type Paintable,
  type ProjectileHit,
  type Vec3,
  PAINT_FULL,
  applyPaint,
  createHitCapsule,
  createPlayerState,
  emptyTrace,
  playerHitCapsule,
  traceRay,
  vec3,
} from '@splat/shared';
import type { ShootingSettings } from './settings.ts';
import { SplatDecals } from './splats.ts';
import { DEBUG_RENDER_ORDER, capsuleWireGeometry, debugLineMaterial } from './debugDraw.ts';

/** Hitbox ids for dummies start here; the local player is id 1. */
export const DUMMY_ID_BASE = 1000;
const SPLATS_PER_DUMMY = 24;
const BODY_COLOR = new THREE.Color(0xd9d3c3);
const BODY_EMISSIVE = 0.27;
const FLASH_COLOR = new THREE.Color(0xffffff);
/** seconds a hit flash lasts */
const FLASH_TIME = 0.12;
const METER_WIDTH = 32;
const METER_HEIGHT = 3;
/** colored meter fill eases toward the real value at this rate, 1/s */
const METER_EASE = 9;
/** how far a wall/room probe reaches, u */
const ROOM_REACH = 512;
/** body turn rate toward the player, 1/s */
const TURN_RATE = 6;
const SIGNS = [1, -1] as const;
const PROBE_HEIGHTS = [0.25, 0.75] as const;

interface Dummy {
  id: number;
  /** shown in the HUD notice and on the badge: "Dummy 3" */
  name: string;
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
  /** fill drawn in paint color, eased toward meter.paint so each hit's chunk shows */
  shownFill: number;
  paintColor: THREE.Color;
  resetTimer: number;
  flash: number;
  /** meter pop on hit, 1 → 0 */
  bump: number;
  hitbox: HitCapsule;
  root: THREE.Group;
  body: THREE.Group;
  bodyMat: THREE.MeshLambertMaterial;
  splats: SplatDecals;
  meterFill: THREE.Mesh;
  meterFillMat: THREE.MeshBasicMaterial;
  meterChunk: THREE.Mesh;
  meterGroup: THREE.Group;
  label: THREE.Sprite;
  wire: THREE.LineSegments;
}

function textTexture(text: string, w: number, h: number, font: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = Math.max(4, h / 8);
  g.strokeStyle = '#1b1530';
  g.strokeText(text, w / 2, h / 2 + 2);
  g.fillStyle = '#ffffff';
  g.fillText(text, w / 2, h / 2 + 2);
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

const tmpN = new THREE.Vector3();
const tmpPoint = { x: 0, y: 0, z: 0 };
const lerpColor = new THREE.Color();
const camPos = new THREE.Vector3();
const probeStart = vec3();
const probeEnd = vec3();
const probe = emptyTrace();

export class TargetRange {
  readonly hitboxes: HitCapsule[] = [];
  readonly group = new THREE.Group();
  private readonly dummies: Dummy[] = [];
  private readonly settings: ShootingSettings;
  private readonly world: CollisionWorld;
  private readonly disposables: { dispose(): void }[] = [];
  private time = 0;
  private wiresShown = false;

  constructor(map: MapDef, world: CollisionWorld, movement: MovementConfig, settings: ShootingSettings, viewer: Vec3) {
    this.settings = settings;
    this.world = world;
    const labelTex = textTexture('SPLATTED!', 256, 64, 'bold 44px system-ui, sans-serif');
    const labelMat = new THREE.SpriteMaterial({ map: labelTex, depthWrite: false });
    const meterBgMat = new THREE.MeshBasicMaterial({ color: 0x1b1530 });
    const meterChunkMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const baseMat = new THREE.MeshLambertMaterial({ color: 0x5b5f6b, emissive: 0x1d1f24 });
    const visorMat = new THREE.MeshLambertMaterial({ color: 0x2b2f3a, emissive: 0x15171c });
    const wireMat = debugLineMaterial(0x39ff88);
    const meterBgGeom = new THREE.PlaneGeometry(METER_WIDTH + 2, METER_HEIGHT + 2);
    const meterFillGeom = new THREE.PlaneGeometry(METER_WIDTH, METER_HEIGHT).translate(METER_WIDTH / 2, 0, 0);
    this.disposables.push(labelTex, labelMat, meterBgMat, meterChunkMat, baseMat, visorMat, wireMat, meterBgGeom, meterFillGeom);

    map.dummySpawns.forEach((pos, i) => {
      const id = DUMMY_ID_BASE + i;
      const name = `Dummy ${i + 1}`;
      const hitbox = playerHitCapsule(createHitCapsule(id, pos, 0, 0), createPlayerState(pos), movement);
      const { radius, height } = hitbox;

      const root = new THREE.Group();
      root.position.set(pos.x, pos.y, pos.z);
      const body = new THREE.Group();
      body.rotation.y = Math.atan2(viewer.x - pos.x, viewer.z - pos.z);
      root.add(body);

      // the body is the hitbox: same radius, same height, same clamping
      const core = Math.min(radius, height / 2);
      const bodyMat = new THREE.MeshLambertMaterial({ color: BODY_COLOR.clone(), emissive: new THREE.Color(0x3a3833) });
      const capsuleGeom = new THREE.CapsuleGeometry(core, Math.max(0, height - core * 2), 6, 18);
      const capsule = new THREE.Mesh(capsuleGeom, bodyMat);
      capsule.position.y = height / 2;
      capsule.castShadow = true; // only matters when the 'high' quality preset enables shadows
      body.add(capsule);

      const baseGeom = new THREE.CylinderGeometry(radius + 4, radius + 6, 2, 20);
      const stand = new THREE.Mesh(baseGeom, baseMat);
      stand.position.y = 1;
      root.add(stand);

      // visor on the front (+Z in body space) so you can tell which way it faces
      const visorGeom = new THREE.BoxGeometry(radius * 1.1, 5, 4);
      const visor = new THREE.Mesh(visorGeom, visorMat);
      visor.position.set(0, height - radius * 0.9, radius - 1.2);
      body.add(visor);

      // splats live on the capsule in root space: the capsule is round, so turning the body doesn't move its surface
      const splats = new SplatDecals(SPLATS_PER_DUMMY, SPLATS_PER_DUMMY, 0.15);
      root.add(splats.group);

      const meterGroup = new THREE.Group();
      meterGroup.position.y = height + 10;
      const meterBg = new THREE.Mesh(meterBgGeom, meterBgMat);
      const meterChunk = new THREE.Mesh(meterFillGeom, meterChunkMat);
      meterChunk.position.set(-METER_WIDTH / 2, 0, 0.04);
      meterChunk.scale.x = 0.0001;
      const meterFillMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const meterFill = new THREE.Mesh(meterFillGeom, meterFillMat);
      meterFill.position.set(-METER_WIDTH / 2, 0, 0.08);
      meterFill.scale.x = 0.0001;
      // number badge left of the meter, matching the "Splatted Dummy 3!" notice
      const badgeTex = textTexture(String(i + 1), 64, 64, 'bold 46px system-ui, sans-serif');
      const badgeMat = new THREE.SpriteMaterial({ map: badgeTex, depthWrite: false });
      const badge = new THREE.Sprite(badgeMat);
      badge.scale.set(9, 9, 1);
      badge.position.set(-METER_WIDTH / 2 - 7, 0, 0);
      meterGroup.add(meterBg, meterChunk, meterFill, badge);
      root.add(meterGroup);

      const label = new THREE.Sprite(labelMat);
      label.scale.set(40, 10, 1);
      label.position.y = height + 20;
      label.visible = false;
      root.add(label);

      const wireGeom = capsuleWireGeometry(radius, height);
      const wire = new THREE.LineSegments(wireGeom, wireMat);
      wire.renderOrder = DEBUG_RENDER_ORDER;
      wire.visible = false;
      root.add(wire);

      this.group.add(root);
      this.disposables.push(capsuleGeom, baseGeom, visorGeom, bodyMat, meterFillMat, badgeTex, badgeMat, wireGeom, splats);

      const d: Dummy = {
        id,
        name,
        base: vec3(pos.x, pos.y, pos.z),
        axis: vec3(1, 0, 0),
        room: 0,
        offset: 0,
        prevOffset: 0,
        dir: i % 2 === 0 ? 1 : -1,
        strafes: i % 3 !== 0,
        meter: { paint: 0, splatted: false },
        shownFill: 0,
        paintColor: new THREE.Color(0xffffff),
        resetTimer: 0,
        flash: 0,
        bump: 0,
        hitbox,
        root,
        body,
        bodyMat,
        splats,
        meterFill,
        meterFillMat,
        meterChunk,
        meterGroup,
        label,
        wire,
      };
      this.dummies.push(d);
      this.hitboxes.push(d.hitbox);
    });
    for (const d of this.dummies) this.aim(d, viewer);
  }

  /** "Dummy 3" for a hitbox id, or '' if it isn't a dummy. */
  nameOf(id: number): string {
    return this.dummies[id - DUMMY_ID_BASE]?.name ?? '';
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
    const r = d.hitbox.radius;
    const width = r * 2;
    let room = ROOM_REACH;
    for (const sign of SIGNS) {
      for (const k of PROBE_HEIGHTS) {
        const h = d.hitbox.height * k;
        probeStart.x = p.x;
        probeStart.y = p.y + h;
        probeStart.z = p.z;
        probeEnd.x = p.x + a.x * ROOM_REACH * sign;
        probeEnd.y = p.y + h;
        probeEnd.z = p.z + a.z * ROOM_REACH * sign;
        traceRay(this.world, probeStart, probeEnd, probe);
        room = Math.min(room, probe.fraction * ROOM_REACH - r - 4);
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
      const hb = d.hitbox;
      hb.prevPos.x = hb.pos.x;
      hb.prevPos.y = hb.pos.y;
      hb.prevPos.z = hb.pos.z;
      hb.pos.x = d.base.x + d.axis.x * d.offset;
      hb.pos.y = d.base.y;
      hb.pos.z = d.base.z + d.axis.z * d.offset;
    }
  }

  /** Apply a projectile's target hit. Returns 'splatted' when this hit filled the meter. */
  onHit(hit: ProjectileHit, color: THREE.Color): 'hit' | 'splatted' | null {
    const d = this.dummies[hit.target - DUMMY_ID_BASE];
    if (!d || d.id !== hit.target) return null;
    d.flash = FLASH_TIME;
    d.bump = 1;
    if (!d.meter.splatted) d.paintColor.copy(color);
    const filled = applyPaint(d.meter, hit.projectile.paint);
    if (filled) d.resetTimer = this.settings.dummyResetSeconds;

    // a small splat on the body: the contact point relative to the feet, snapped onto the capsule
    const hb = d.hitbox;
    const core = Math.min(hb.radius, hb.height / 2);
    const lx = hit.point.x - hb.pos.x;
    const ly = hit.point.y - hb.pos.y;
    const lz = hit.point.z - hb.pos.z;
    const cy = Math.min(Math.max(ly, core), hb.height - core);
    tmpN.set(lx, ly - cy, lz);
    if (tmpN.lengthSq() < 1e-6) tmpN.set(hit.normal.x, hit.normal.y, hit.normal.z);
    tmpN.normalize();
    tmpPoint.x = tmpN.x * core;
    tmpPoint.y = cy + tmpN.y * core;
    tmpPoint.z = tmpN.z * core;
    const size = Math.min(hit.projectile.splatRadius * 0.6, core * 0.7);
    d.splats.add(tmpPoint, tmpN, size, color, hit.projectile.id);
    return filled ? 'splatted' : 'hit';
  }

  private resetDummy(d: Dummy): void {
    d.meter.paint = 0;
    d.meter.splatted = false;
    d.resetTimer = 0;
    d.shownFill = 0;
    d.splats.clear();
  }

  reset(): void {
    for (const d of this.dummies) {
      this.resetDummy(d);
      d.offset = 0;
      d.prevOffset = 0;
    }
  }

  render(alpha: number, frameDt: number, camera: THREE.Camera, showHitboxes: boolean): void {
    this.time += frameDt;
    camera.getWorldPosition(camPos);
    const turn = 1 - Math.exp(-TURN_RATE * frameDt);
    const ease = 1 - Math.exp(-METER_EASE * frameDt);
    const pulse = 1 + 0.08 * Math.sin(this.time * 12);
    const wires = showHitboxes !== this.wiresShown;
    this.wiresShown = showHitboxes;
    for (const d of this.dummies) {
      if (wires) d.wire.visible = showHitboxes;
      const off = d.prevOffset + (d.offset - d.prevOffset) * alpha;
      d.root.position.set(d.base.x + d.axis.x * off, d.base.y, d.base.z + d.axis.z * off);
      d.meterGroup.quaternion.copy(camera.quaternion);
      if (!d.meter.splatted) {
        const want = Math.atan2(camPos.x - d.root.position.x, camPos.z - d.root.position.z);
        d.body.rotation.y += angleDelta(d.body.rotation.y, want) * turn;
      }

      // meter: the white chunk jumps to the new value, the paint color catches up
      const fill = d.meter.paint / PAINT_FULL;
      d.shownFill += (fill - d.shownFill) * ease;
      if (fill - d.shownFill < 0.002) d.shownFill = fill;
      d.meterChunk.scale.x = Math.max(0.0001, fill);
      d.meterFill.scale.x = Math.max(0.0001, d.shownFill);
      d.meterFillMat.color.copy(d.paintColor);
      d.bump = Math.max(0, d.bump - frameDt * 7);
      const pop = 1 + 0.3 * d.bump * d.bump;
      d.meterGroup.scale.set(pop, pop, 1);

      d.flash = Math.max(0, d.flash - frameDt);
      const flash = d.flash / FLASH_TIME;
      if (d.meter.splatted) {
        d.bodyMat.color.copy(d.paintColor);
        d.bodyMat.emissive.copy(d.paintColor).multiplyScalar(0.45);
        d.label.visible = true;
        d.label.scale.set(40 * pulse, 10 * pulse, 1);
      } else {
        lerpColor.copy(BODY_COLOR).lerp(d.paintColor, fill * 0.55);
        d.bodyMat.color.copy(lerpColor);
        d.bodyMat.emissive.copy(lerpColor).multiplyScalar(BODY_EMISSIVE);
        d.label.visible = false;
      }
      if (flash > 0) d.bodyMat.emissive.lerp(FLASH_COLOR, 0.75 * flash);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const x of this.disposables) x.dispose();
  }
}
