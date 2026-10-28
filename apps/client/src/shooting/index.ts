// Shooting system: runs the shared shooter + projectile sim on the fixed tick and
// draws paintballs, splats, the target range, the marker viewmodel, and the HUD.
//
// Per tick: dummies move, the shooter fires from the eye (spawning balls), every
// ball steps and traces its segment, hits paint the world or a dummy.
// Per frame: interpolate balls and dummies, ease the view punch, place the
// viewmodel, refresh the HUD and the debug overlay.

import * as THREE from 'three';
import {
  Buttons,
  LOADOUT,
  TICK_DT,
  WEAPON_META,
  cloneWeaponDefs,
  computeSpreadDeg,
  createRng,
  createShooterState,
  getEyePosition,
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
import { BallRenderer } from './balls.ts';
import { TargetRange } from './dummies.ts';
import { ShootingHud } from './hud.ts';
import { MAX_DECALS, SHOOTING_DEFAULTS, SHOOTING_META } from './settings.ts';
import { SplatDecals } from './splats.ts';
import { Viewmodel } from './viewmodel.ts';

/** Hitbox/owner id of the local player (dummies use 1000+). */
const LOCAL_PLAYER_ID = 1;
/** Fixed seed offline; the server will hand out per-player seeds in step 4. */
const SPREAD_SEED = 0x5eed5;
/** How fast the camera eases toward a new punch, 1/s. */
const PUNCH_FOLLOW = 35;

export const createShootingSystem: SystemFactory = (ctx) => {
  const settings = { ...SHOOTING_DEFAULTS };
  const defs = cloneWeaponDefs();
  const shooter = createShooterState(defs);
  const rng = createRng(SPREAD_SEED);

  const balls: Projectile[] = [];
  const spawned: Projectile[] = [];
  const shots: ShotInfo[] = [];
  const hits: ProjectileHit[] = [];
  const eye = vec3();
  const move: MoveSample = { vel: ctx.player.vel, onGround: ctx.player.onGround, ducked: ctx.player.ducked, maxSpeed: ctx.movement.maxSpeed };
  const input: ShooterInput = { fire: false, weapon: 0, yaw: 0, pitch: 0, eye, move };
  const colors = {} as Record<WeaponId, THREE.Color>;
  for (const id of LOADOUT) colors[id] = new THREE.Color(defs[id].paintColor);

  // --- scene objects
  const decalCap = () => (ctx.settings.quality === 'low' ? settings.decalCapLow : settings.decalCap);
  const splats = new SplatDecals(MAX_DECALS, decalCap(), 0.12);
  const ballRenderer = new BallRenderer();
  const range = new TargetRange(ctx.map, ctx.world, ctx.movement, settings, ctx.player.pos);
  const viewmodel = new Viewmodel(ctx.renderer);
  ctx.scene.add(splats.group, ballRenderer.mesh, range.group, viewmodel.root);
  const hud = new ShootingHud(ctx.hud, ctx.renderer.domElement);

  // --- dev panel
  const folders = [addTunables(ctx.gui, 'Shooting', settings, SHOOTING_META, { storageKey: 'splat.shooting' })];
  const actions = {
    refill: () => LOADOUT.forEach((id, i) => refillHopper(shooter.weapons[i]!, defs[id].stats)),
    clearSplats: () => {
      splats.clear();
      hud.clearImpacts();
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

  // --- view punch: target set per shot, eased per frame, recovers once you stop
  const punchTarget: AimAngles = { yaw: 0, pitch: 0 };
  const punch: AimAngles = { yaw: 0, pitch: 0 };
  const nextOffset: AimAngles = { yaw: 0, pitch: 0 };
  let sinceShot = Infinity;
  let shotThisTick = false;

  function activeId(): WeaponId {
    return LOADOUT[shooter.active]!;
  }

  function onShot(shot: ShotInfo): void {
    const def = defs[shot.weapon];
    // CS-style: the shot just fired went to pattern[i]; the camera kicks toward
    // where the next one will go, scaled down so the balls land above the crosshair.
    patternOffset(def, shot.sprayIndex + 1, nextOffset);
    punchTarget.pitch = nextOffset.pitch * def.stats.viewPunchScale;
    punchTarget.yaw = nextOffset.yaw * def.stats.viewPunchScale;
    viewmodel.onShot();
    shotThisTick = true;
  }

  function onHit(hit: ProjectileHit): void {
    const weapon = hit.projectile.weapon;
    const color = colors[weapon];
    hud.addImpact(hit.point, defs[weapon].paintColor, settings.impactCount);
    if (hit.kind === 'world') {
      splats.add(hit.point, hit.normal, hit.projectile.splatRadius, color, hit.projectile.id);
      return;
    }
    const result = range.onHit(hit, color);
    if (result && hit.projectile.owner === LOCAL_PLAYER_ID) {
      hud.onTargetHit();
      if (result === 'splatted') hud.onSplatted(defs[weapon].paintColor);
    }
  }

  return {
    fixedUpdate(cmd, dt) {
      const player = ctx.player;
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

      spawned.length = 0;
      shots.length = 0;
      stepShooter(shooter, defs, input, rng, dt, { infiniteAmmo: settings.infiniteAmmo, owner: LOCAL_PLAYER_ID }, spawned, shots);
      viewmodel.setActive(activeId());
      for (const b of spawned) {
        ballRenderer.onSpawn(b, viewmodel.muzzleOffset);
        balls.push(b);
      }
      for (const s of shots) onShot(s);

      hits.length = 0;
      stepProjectiles(balls, ctx.world, range.hitboxes, dt, hits);
      for (const h of hits) onHit(h);
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
      const interval = 60 / Math.max(1, def.stats.rpm);
      if (sinceShot > interval + TICK_DT) {
        const decay = Math.exp(-settings.punchRecovery * frameDt);
        punchTarget.pitch *= decay;
        punchTarget.yaw *= decay;
      }
      const follow = 1 - Math.exp(-PUNCH_FOLLOW * frameDt);
      punch.pitch += (punchTarget.pitch - punch.pitch) * follow;
      punch.yaw += (punchTarget.yaw - punch.yaw) * follow;
      ctx.viewPunch.pitch = punch.pitch;
      ctx.viewPunch.yaw = punch.yaw;

      range.render(alpha, frameDt, ctx.camera);
      ballRenderer.update(balls, alpha, TICK_DT, colors, settings.ballVisualScale);
      viewmodel.update(ctx.camera, frameDt, settings.viewmodelKick);

      const spreadDeg = computeSpreadDeg(def.stats, ws.sprayIndex, move);
      hud.updatePanel(
        { def, active: id, ammo: ws.ammo, infiniteAmmo: settings.infiniteAmmo, sprayIndex: ws.sprayIndex, spreadDeg },
        defs,
      );
      hud.drawOverlay(
        {
          showPattern: settings.showPattern,
          showImpacts: settings.showImpacts,
          def,
          sprayIndex: ws.sprayIndex,
          spreadDeg,
          punchPitch: punch.pitch,
          punchYaw: punch.yaw,
        },
        ctx.camera,
        frameDt,
      );
    },

    dispose() {
      ctx.viewPunch.pitch = 0;
      ctx.viewPunch.yaw = 0;
      splats.dispose();
      ballRenderer.dispose();
      range.dispose();
      viewmodel.dispose();
      hud.dispose();
      for (const f of folders) f.destroy();
    },
  };
};
