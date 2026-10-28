// Shooting system: runs the shared shooter + projectile sim on the fixed tick and
// draws paintballs, splats, the target range, the marker viewmodel, the HUD, and
// plays the sound cues.
//
// Per tick: dummies move, the shooter fires from the eye along the crosshair ray
// (spawning balls, recycled from a pool), every ball steps and sweeps its segment,
// hits paint the world or a dummy, and ctx.aimSpreadDeg is updated for the HUD.
// Per frame: interpolate balls and dummies, ease the view punch, place the
// viewmodel, refresh the HUD feedback and the debug views.
//
// View punch: by default the camera kick follows the spray state exactly. While a
// follow-up shot would still continue the pattern, the view stays kicked by
// `viewPunchScale` of where that shot goes; once the pattern resets the view eases
// back. So when the view has settled, the next shot is a first shot again.

import * as THREE from 'three';
import {
  Buttons,
  LOADOUT,
  TICK_DT,
  WEAPON_META,
  aimConeDeg,
  cloneWeaponDefs,
  createRng,
  createShooterState,
  getEyePosition,
  nextSprayIndex,
  patternOffset,
  refillHopper,
  stepProjectiles,
  stepShooter,
  vec3,
  type AimAngles,
  type MoveSample,
  type Projectile,
  type ProjectileHit,
  type ShooterInput,
  type ShotInfo,
  type WeaponId,
} from '@splat/shared';
import type { SystemFactory } from '../game/types.ts';
import { addTunables } from '../dev/tuning.ts';
import { GameAudio } from '../audio/gameAudio.ts';
import { BallRenderer } from './balls.ts';
import { HitMarkers } from './debugDraw.ts';
import { TargetRange } from './dummies.ts';
import { ShootingHud, type HudState, type OverlayState } from './hud.ts';
import { MAX_DECALS, SHOOTING_DEFAULTS, SHOOTING_META } from './settings.ts';
import { SplatDecals } from './splats.ts';
import { Viewmodel } from './viewmodel.ts';

/** Hitbox/owner id of the local player (dummies use 1000+). */
const LOCAL_PLAYER_ID = 1;
/** Fixed seed offline; the server will hand out per-player seeds in step 4. */
const SPREAD_SEED = 0x5eed5;
/** How fast the camera eases toward a new punch, 1/s. */
const PUNCH_FOLLOW = 35;
/** Spent balls kept for reuse. */
const POOL_CAP = 512;
const TARGET_MARK = new THREE.Color(0xffe14d);
const WORLD_MARK = new THREE.Color(0xffffff);

export const createShootingSystem: SystemFactory = (ctx) => {
  const settings = { ...SHOOTING_DEFAULTS };
  const defs = cloneWeaponDefs();
  const shooter = createShooterState(defs);
  const rng = createRng(SPREAD_SEED);

  const balls: Projectile[] = [];
  const pool: Projectile[] = [];
  const spawned: Projectile[] = [];
  const expired: Projectile[] = [];
  const shots: ShotInfo[] = [];
  const hits: ProjectileHit[] = [];
  const eye = vec3();
  const spawnOffset = vec3();
  const move: MoveSample = { vel: ctx.player.vel, onGround: ctx.player.onGround, ducked: ctx.player.ducked, maxSpeed: ctx.movement.maxSpeed };
  const input: ShooterInput = { fire: false, weapon: 0, yaw: 0, pitch: 0, eye, move };
  const colors = {} as Record<WeaponId, THREE.Color>;
  for (const id of LOADOUT) colors[id] = new THREE.Color(defs[id].paintColor);

  // --- scene objects
  const decalCap = () => (ctx.settings.quality === 'low' ? settings.decalCapLow : settings.decalCap);
  const splats = new SplatDecals(MAX_DECALS, decalCap(), 0.12);
  const ballRenderer = new BallRenderer();
  const hitMarkers = new HitMarkers();
  const range = new TargetRange(ctx.map, ctx.world, ctx.movement, settings, ctx.player.pos);
  const viewmodel = new Viewmodel(ctx.renderer);
  ctx.scene.add(splats.group, ballRenderer.mesh, ballRenderer.hitMesh, hitMarkers.mesh, range.group, viewmodel.root);
  const hud = new ShootingHud(ctx.hud, ctx.renderer.domElement);
  const audio = new GameAudio(ctx.gui);

  // --- dev panel
  const folders = [addTunables(ctx.gui, 'Shooting', settings, SHOOTING_META, { storageKey: 'splat.shooting' })];
  const actions = {
    refill: () => LOADOUT.forEach((id, i) => refillHopper(shooter.weapons[i]!, defs[id].stats)),
    clearSplats: () => {
      splats.clear();
      hud.clearImpacts();
      hitMarkers.clear();
    },
    resetDummies: () => range.reset(),
  };
  folders[0]!.add(actions, 'refill').name('refill hoppers');
  folders[0]!.add(actions, 'clearSplats').name('clear splats');
  folders[0]!.add(actions, 'resetDummies').name('reset dummies');
  for (const id of LOADOUT) {
    folders.push(addTunables(ctx.gui, defs[id].name, defs[id].stats, WEAPON_META, { storageKey: `splat.weapon.${id}` }));
  }
  splats.setCap(decalCap()); // saved settings load after construction

  // --- view punch
  const punchTarget: AimAngles = { yaw: 0, pitch: 0 };
  const punch: AimAngles = { yaw: 0, pitch: 0 };
  const nextOffset: AimAngles = { yaw: 0, pitch: 0 };
  let sinceShot = Infinity;
  let shotThisTick = false;
  let viewmodelPlaced = false;
  let fireWasDown = false;

  // reused per-frame HUD inputs
  const hudState: HudState = { def: defs.splatter, active: 'splatter', ammo: 0, infiniteAmmo: true, sprayIndex: 0, spreadDeg: 0 };
  const overlay: OverlayState = { showPattern: false, showImpacts: false, def: defs.splatter, sprayIndex: 0, spreadDeg: 0, punchPitch: 0, punchYaw: 0 };

  function activeId(): WeaponId {
    return LOADOUT[shooter.active]!;
  }

  function onShot(shot: ShotInfo): void {
    if (!settings.punchHoldsUntilReset) {
      // legacy: kick toward where the next shot goes, ease back soon after you stop
      const def = defs[shot.weapon];
      patternOffset(def, shot.sprayIndex + 1, nextOffset);
      punchTarget.pitch = nextOffset.pitch * def.stats.viewPunchScale;
      punchTarget.yaw = nextOffset.yaw * def.stats.viewPunchScale;
    }
    viewmodel.onShot();
    audio.fire(shot.weapon);
    shotThisTick = true;
  }

  /** Apply one hit; returns the local player's result against a target, if any. */
  function onHit(hit: ProjectileHit): 'hit' | 'splatted' | null {
    const weapon = hit.projectile.weapon;
    const color = colors[weapon];
    hud.addImpact(hit.point, defs[weapon].paintColor, settings.impactCount);
    if (settings.showHitboxes) hitMarkers.add(hit.point, hit.kind === 'target' ? TARGET_MARK : WORLD_MARK, hit.kind === 'target' ? 1.6 : 1.1);
    if (hit.kind === 'world') {
      splats.add(hit.point, hit.normal, hit.projectile.splatRadius, color, hit.projectile.id);
      audio.worldSplat(hit.point);
      return null;
    }
    const result = range.onHit(hit, color);
    return hit.projectile.owner === LOCAL_PLAYER_ID ? result : null;
  }

  function recycle(p: Projectile): void {
    if (pool.length < POOL_CAP) pool.push(p);
  }

  function updateAimSpread(): void {
    const ws = shooter.weapons[shooter.active]!;
    ctx.aimSpreadDeg = aimConeDeg(ws, defs[activeId()].stats, move, TICK_DT);
  }
  updateAimSpread();

  return {
    fixedUpdate(cmd, dt) {
      const player = ctx.player;
      audio.tick(dt);
      range.fixedUpdate(dt, player.pos);

      getEyePosition(player, ctx.movement, eye);
      move.vel = player.vel;
      move.onGround = player.onGround;
      move.ducked = player.ducked;
      move.maxSpeed = ctx.movement.maxSpeed;
      input.fire = (cmd.buttons & Buttons.FIRE) !== 0;
      input.weapon = cmd.weapon;
      input.yaw = cmd.yaw;
      input.pitch = cmd.pitch;
      const press = input.fire && !fireWasDown;
      fireWasDown = input.fire;

      spawned.length = 0;
      shots.length = 0;
      stepShooter(shooter, defs, input, rng, dt, { infiniteAmmo: settings.infiniteAmmo, owner: LOCAL_PLAYER_ID }, spawned, shots, pool);
      viewmodel.setActive(activeId());
      for (let i = 0; i < spawned.length; i++) {
        const b = spawned[i]!;
        // draw it leaving the muzzle as last rendered; the sim ball starts at the eye
        if (viewmodelPlaced) {
          spawnOffset.x = viewmodel.muzzleWorld.x - b.pos.x;
          spawnOffset.y = viewmodel.muzzleWorld.y - b.pos.y;
          spawnOffset.z = viewmodel.muzzleWorld.z - b.pos.z;
        } else {
          spawnOffset.x = spawnOffset.y = spawnOffset.z = 0;
        }
        ballRenderer.onSpawn(b, spawnOffset);
        balls.push(b);
      }
      for (let i = 0; i < shots.length; i++) onShot(shots[i]!);
      const ws = shooter.weapons[shooter.active]!;
      if (press && shots.length === 0 && !settings.infiniteAmmo && ws.ammo <= 0) audio.dryFire();

      expired.length = 0;
      const n = stepProjectiles(balls, ctx.world, range.hitboxes, dt, hits, expired);
      let hitTarget = false;
      let splatHit: ProjectileHit | null = null;
      for (let i = 0; i < n; i++) {
        const hit = hits[i]!;
        const result = onHit(hit);
        if (result) hitTarget = true;
        if (result === 'splatted') splatHit = hit;
      }
      // one cue per tick, however many pellets landed
      if (hitTarget) {
        hud.onTargetHit();
        audio.targetHit();
      }
      if (splatHit) {
        hud.onSplatted(defs[splatHit.projectile.weapon].paintColor, range.nameOf(splatHit.target));
        audio.splatted();
      }
      for (let i = 0; i < n; i++) recycle(hits[i]!.projectile);
      for (let i = 0; i < expired.length; i++) {
        ballRenderer.onExpire(expired[i]!);
        recycle(expired[i]!);
      }

      audio.movement(player, ctx.movement.maxSpeed, dt);
      updateAimSpread();
    },

    render(alpha, frameDt) {
      if (decalCap() !== splats.cap) splats.setCap(decalCap());

      const id = activeId();
      const def = defs[id];
      const ws = shooter.weapons[shooter.active]!;

      // view punch
      if (shotThisTick) {
        sinceShot = 0;
        shotThisTick = false;
      } else {
        sinceShot += frameDt;
      }
      let recovering: boolean;
      if (settings.punchHoldsUntilReset) {
        const next = nextSprayIndex(ws, def.stats, TICK_DT);
        if (next > 0) {
          patternOffset(def, next, nextOffset);
          punchTarget.pitch = nextOffset.pitch * def.stats.viewPunchScale;
          punchTarget.yaw = nextOffset.yaw * def.stats.viewPunchScale;
        } else {
          punchTarget.pitch = 0;
          punchTarget.yaw = 0;
        }
        const t2 = punchTarget.pitch * punchTarget.pitch + punchTarget.yaw * punchTarget.yaw;
        const p2 = punch.pitch * punch.pitch + punch.yaw * punch.yaw;
        recovering = t2 < p2;
      } else {
        const interval = 60 / Math.max(1, def.stats.rpm);
        if (sinceShot > interval + TICK_DT) {
          const decay = Math.exp(-settings.punchRecovery * frameDt);
          punchTarget.pitch *= decay;
          punchTarget.yaw *= decay;
        }
        recovering = false;
      }
      const follow = 1 - Math.exp(-(recovering ? settings.punchRecovery : PUNCH_FOLLOW) * frameDt);
      punch.pitch += (punchTarget.pitch - punch.pitch) * follow;
      punch.yaw += (punchTarget.yaw - punch.yaw) * follow;
      ctx.viewPunch.pitch = punch.pitch;
      ctx.viewPunch.yaw = punch.yaw;

      range.render(alpha, frameDt, ctx.camera, settings.showHitboxes);
      ballRenderer.update(balls, alpha, TICK_DT, frameDt, colors, settings.showHitboxes);
      hitMarkers.mesh.visible = settings.showHitboxes;
      viewmodel.update(ctx.camera, frameDt, settings.viewmodelKick);
      viewmodelPlaced = true;
      audio.updateListener(ctx.camera);

      hudState.def = def;
      hudState.active = id;
      hudState.ammo = ws.ammo;
      hudState.infiniteAmmo = settings.infiniteAmmo;
      hudState.sprayIndex = ws.sprayIndex;
      hudState.spreadDeg = ctx.aimSpreadDeg;
      hud.updatePanel(hudState, defs);
      hud.updateFeedback(frameDt);

      overlay.showPattern = settings.showPattern;
      overlay.showImpacts = settings.showImpacts;
      overlay.def = def;
      overlay.sprayIndex = ws.sprayIndex;
      overlay.spreadDeg = ctx.aimSpreadDeg;
      overlay.punchPitch = punch.pitch;
      overlay.punchYaw = punch.yaw;
      hud.drawOverlay(overlay, ctx.camera);
    },

    dispose() {
      ctx.viewPunch.pitch = 0;
      ctx.viewPunch.yaw = 0;
      splats.dispose();
      ballRenderer.dispose();
      hitMarkers.dispose();
      range.dispose();
      viewmodel.dispose();
      hud.dispose();
      audio.dispose();
      for (const f of folders) f.destroy();
    },
  };
};
