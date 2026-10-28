// Contract between the client game loop (game/) and feature systems such as
// shooting/. The loop owns the context; systems read it and add to the scene/HUD.

import type * as THREE from 'three';
import type GUI from 'lil-gui';
import type { CollisionWorld, MapDef, MovementConfig, MovementModifiers, PlayerState, UserCmd } from '@splat/shared';
import type { ClientSettings } from '../settings.ts';

export interface ViewAngles {
  /** radians, see view-angle convention in @splat/shared math.ts */
  yaw: number;
  pitch: number;
}

export interface GameContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  map: MapDef;
  world: CollisionWorld;
  /** local player's sim state as of the latest tick */
  player: PlayerState;
  /** live movement tuning; the dev panel mutates it in place */
  movement: MovementConfig;
  /** look angles from the mouse, updated every frame */
  view: ViewAngles;
  /** additive camera kick a system may set (e.g. recoil); the loop adds it when placing the camera */
  viewPunch: ViewAngles;
  /** HUD overlay root; systems append their own elements */
  hud: HTMLElement;
  /** dev tuning panel root */
  gui: GUI;
  /** ticks simulated since start */
  tick: number;

  /**
   * Local player's state one tick earlier, for render interpolation. Replaced
   * (via clonePlayerState) at the start of every tick, so read it fresh.
   */
  prevPlayer: PlayerState;
  /** passed to stepPlayer each tick; power-ups / the question panel scale these */
  modifiers: MovementModifiers;
  /** live client settings (sensitivity, FOV, quality...); quality is 'low' on Chromebooks */
  settings: ClientSettings;
  /** true while the pointer is locked (or drag-look fallback is active) and game input is live */
  inputActive: boolean;
  /**
   * Spread (degrees, cone half-angle) the next shot would have right now. Written by
   * the shooting system each tick; the HUD's dynamic crosshair reads it.
   */
  aimSpreadDeg: number;
}

export interface ClientSystem {
  /** Once per 64 Hz tick, after the local player has moved this tick. */
  fixedUpdate(cmd: UserCmd, dt: number): void;
  /** Once per rendered frame. `alpha` is 0..1 between the previous and current tick. */
  render(alpha: number, frameDt: number): void;
  dispose?(): void;
}

export type SystemFactory = (ctx: GameContext) => ClientSystem;
