// Builds the GameContext and runs the loop.
//
// Per frame:  mouse look -> N fixed ticks -> camera (interpolated eye + punch)
//             -> system.render -> HUD -> draw
// Per tick:   sample UserCmd -> stepPlayer -> system.fixedUpdate
//
// Mouse look is applied before the ticks, so a tick simulated this frame already
// uses this frame's view angles, and the camera rotation is never interpolated.

import * as THREE from 'three';
import GUI from 'lil-gui';
import {
  ARENA,
  ARENA_DECOR,
  DEFAULT_MODIFIERS,
  LOADOUT,
  MOVEMENT_PRESETS,
  TICK_DT,
  buildCollisionWorld,
  clonePlayerState,
  copy,
  createPlayerState,
  emptyCmd,
  getEyePosition,
  lengthXZ,
  lerp,
  stepPlayer,
  vec3,
  type MapTeleport,
  type MovementConfig,
  type PlayerState,
  type Vec3,
} from '@splat/shared';
import { createShootingSystem } from '../shooting/index.ts';
import { buildDevPanel } from '../dev/panel.ts';
import { Hud } from '../hud/hud.ts';
import { Input } from '../input/input.ts';
import { applyMouseLook } from '../input/look.ts';
import { createRenderRig } from '../render/renderer.ts';
import { buildMapView, mapBounds } from '../render/mapMesh.ts';
import { loadSettings, type ClientSettings } from '../settings.ts';
import { planSteps, stepAlpha, type FixedStep } from './fixedStep.ts';
import type { ClientSystem, GameContext, SystemFactory } from './types.ts';

/** Systems registered at startup. */
const SYSTEMS: [string, SystemFactory][] = [['shooting', createShootingSystem]];

/** Below this the player has fallen out of the map: put them back. */
const KILL_Y = -1000;

export interface Game {
  ctx: GameContext;
  start(): void;
  stop(): void;
}

function isVec(v: unknown): v is Vec3 {
  return !!v && typeof v === 'object' && 'x' in v && 'y' in v && 'z' in v;
}

/** Overwrite `dst` with `src` in place (vector fields copied, not replaced), so references to ctx.player stay valid. */
function assignState(dst: PlayerState, src: PlayerState): void {
  const d = dst as unknown as Record<string, unknown>;
  const s = src as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    const sv = s[k];
    const dv = d[k];
    if (isVec(sv) && isVec(dv)) copy(dv, sv);
    else d[k] = sv;
  }
}

function readNumber(cfg: MovementConfig, key: string, fallback: number): number {
  const v = (cfg as unknown as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : fallback;
}

function topDownCamera(bounds: { min: THREE.Vector3; max: THREE.Vector3 }, aspect: number): THREE.OrthographicCamera {
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  let hw = (bounds.max.x - bounds.min.x) / 2 + 32;
  let hh = (bounds.max.z - bounds.min.z) / 2 + 32;
  if (hw / hh < aspect) hw = hh * aspect;
  else hh = hw / aspect;
  const cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 1, 6000);
  cam.up.set(0, 0, -1); // north (-z) at the top of the screen
  cam.position.set(cx, 3000, cz);
  cam.lookAt(cx, 0, cz);
  return cam;
}

export function createGame(container: HTMLElement): Game {
  const params = new URLSearchParams(location.search);
  const settings: ClientSettings = loadSettings();
  const map = ARENA;
  const decor = ARENA_DECOR;
  const teleports: MapTeleport[] = decor.teleports.length
    ? decor.teleports
    : map.spawns.map((s, i) => ({ name: `spawn ${i}`, pos: s.pos, yaw: s.yaw }));
  const bounds = mapBounds(map);

  const rig = createRenderRig(container, settings, bounds);
  const { renderer, scene, camera } = rig;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const mapView = buildMapView(map, decor, settings.quality === 'high' ? Math.min(8, maxAniso) : Math.min(2, maxAniso));
  mapView.grid.uGridStrength.value = settings.gridStrength;
  scene.add(mapView.group);
  scene.updateMatrixWorld(true);

  let input: Input | null = null;
  const hud = new Hud(container, {
    play: () => void input?.requestLock(),
    fullscreen: () => void input?.enterFullscreen(),
  });
  hud.applySettings(settings);
  hud.showOverlay(true);

  const tpParam = Number(params.get('tp'));
  if (params.has('tp') && Number.isInteger(tpParam) && tpParam >= 0 && tpParam < teleports.length) settings.spawnAt = tpParam;
  if (settings.spawnAt >= teleports.length) settings.spawnAt = 0;
  const spawn = teleports[settings.spawnAt]!;

  // a mutable copy: the dev panel edits it in place, the preset stays pristine
  const firstPreset = Object.values(MOVEMENT_PRESETS)[0] as MovementConfig;
  const movement = structuredClone(firstPreset);
  const player = createPlayerState(spawn.pos);
  const gui = new GUI({ title: 'Splatcademy dev (F1)', width: 310 });

  // previous-tick state for interpolation; mirrored to ctx.prevPlayer
  let prev = clonePlayerState(player);
  const ctx: GameContext = {
    scene,
    camera,
    renderer,
    map,
    world: buildCollisionWorld(map),
    player,
    movement,
    view: { yaw: spawn.yaw, pitch: 0 },
    viewPunch: { yaw: 0, pitch: 0 },
    hud: hud.root,
    gui,
    tick: 0,
    prevPlayer: prev,
    modifiers: { ...DEFAULT_MODIFIERS },
    settings,
    inputActive: false,
  };
  const deg = (k: string) => (params.has(k) ? (Number(params.get(k)) * Math.PI) / 180 : null);
  ctx.view.yaw = deg('yaw') ?? ctx.view.yaw;
  ctx.view.pitch = deg('pitch') ?? 0;

  // jump stats for the HUD
  let takeoffSpeed = 0;
  let landSpeed = 0;

  const respawn = () => {
    const tp = teleports[settings.spawnAt] ?? teleports[0]!;
    assignState(ctx.player, createPlayerState(tp.pos));
    ctx.prevPlayer = prev = clonePlayerState(ctx.player);
    ctx.view.yaw = tp.yaw;
    ctx.view.pitch = 0;
    takeoffSpeed = landSpeed = 0;
  };

  let panelVisible = params.get('panel') !== '0';
  gui.show(panelVisible);

  input = new Input(renderer.domElement, settings, {
    respawn,
    togglePanel: () => {
      panelVisible = !panelVisible;
      gui.show(panelVisible);
    },
    activeChange: (active) => {
      ctx.inputActive = active;
      hud.showOverlay(!active);
    },
    message: (text) => hud.setMessage(text),
  }, LOADOUT.length);
  if (input.dragFallback) hud.setMessage('Mouse lock is not available here: drag with the mouse to look.');

  buildDevPanel(gui, ctx.movement, settings, teleports, {
    settingChanged: (key) => {
      switch (key) {
        case 'fov':
          rig.setFov(settings.fov);
          break;
        case 'quality':
          rig.applyQuality(settings.quality);
          break;
        case 'gridStrength':
          mapView.grid.uGridStrength.value = settings.gridStrength;
          break;
        case 'opposingKeys':
          input!.cmd.opposingKeys = settings.opposingKeys;
          break;
        default:
          hud.applySettings(settings);
      }
    },
    respawn,
    fullscreen: () => void input!.enterFullscreen(),
    antialias: rig.antialias,
    lowLatency: settings.lowLatency,
  });

  const systems: ClientSystem[] = [];
  for (const [name, factory] of SYSTEMS) {
    try {
      systems.push(factory(ctx));
    } catch (err) {
      // keep the movement sandbox usable while a feature system is broken
      console.error(`[game] system "${name}" failed to start`, err);
    }
  }

  const topCam = params.get('view') === 'top' ? topDownCamera(bounds, window.innerWidth / window.innerHeight) : null;

  // --- loop -----------------------------------------------------------------
  const cmd = emptyCmd();
  const stepper: FixedStep = { acc: 0 };
  const look = { dx: 0, dy: 0 };
  const eyePrev = vec3();
  const eyeCur = vec3();
  const eye = vec3();
  let raf = 0;
  let last = 0;
  let debugAt = 0;

  const tick = () => {
    input!.cmd.sample(cmd, ctx.tick, ctx.view.yaw, ctx.view.pitch);
    if (!ctx.inputActive) {
      cmd.forward = 0;
      cmd.side = 0;
      cmd.buttons = 0;
    }
    ctx.prevPlayer = prev = clonePlayerState(ctx.player);
    const wasOnGround = ctx.player.onGround;
    stepPlayer(ctx.player, cmd, ctx.movement, ctx.world, TICK_DT, ctx.modifiers);
    if (wasOnGround && !ctx.player.onGround) takeoffSpeed = lengthXZ(ctx.player.vel);
    if (!wasOnGround && ctx.player.onGround && takeoffSpeed > 0) landSpeed = lengthXZ(ctx.player.vel);
    if (ctx.player.pos.y < KILL_Y) respawn();
    for (const s of systems) s.fixedUpdate(cmd, TICK_DT);
    ctx.tick++;
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const frameMs = last ? now - last : 0;
    last = now;

    input!.consumeLook(look);
    if (look.dx || look.dy) applyMouseLook(ctx.view, look.dx, look.dy, settings.sensitivity, settings.invertY);

    const steps = planSteps(stepper, frameMs / 1000, TICK_DT);
    for (let i = 0; i < steps; i++) tick();
    const alpha = stepAlpha(stepper, TICK_DT);

    getEyePosition(prev, ctx.movement, eyePrev);
    getEyePosition(ctx.player, ctx.movement, eyeCur);
    lerp(eye, eyePrev, eyeCur, alpha);
    camera.position.set(eye.x, eye.y, eye.z);
    camera.rotation.set(ctx.view.pitch + ctx.viewPunch.pitch, ctx.view.yaw + ctx.viewPunch.yaw, 0);

    for (const s of systems) s.render(alpha, frameMs / 1000);

    const p = ctx.player;
    hud.update({
      speed: lengthXZ(p.vel),
      verticalSpeed: p.vel.y,
      maxSpeed: readNumber(ctx.movement, 'maxSpeed', 320),
      takeoffSpeed,
      landSpeed,
    });
    hud.countFrame(now, frameMs);
    if (settings.showDebug && now - debugAt > 66) {
      debugAt = now;
      hud.setDebug(
        `tick ${ctx.tick}  ${p.onGround ? 'ground' : 'air'}  ${p.ducked ? 'ducked' : 'standing'}\n` +
          `pos ${p.pos.x.toFixed(0)} ${p.pos.y.toFixed(1)} ${p.pos.z.toFixed(0)}  ` +
          `yaw ${((ctx.view.yaw * 180) / Math.PI).toFixed(1)}  pitch ${((ctx.view.pitch * 180) / Math.PI).toFixed(1)}\n` +
          `raw input ${input!.raw}  draw calls ${renderer.info.render.calls}`,
      );
    }

    renderer.render(scene, topCam ?? camera);
  };

  return {
    ctx,
    start() {
      if (!raf) raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      for (const s of systems) s.dispose?.();
      input?.dispose();
    },
  };
}
