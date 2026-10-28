// Global shooting toggles for the dev panel's "Shooting" folder. Per-marker stats
// live in @splat/shared weapons.ts (one folder each); these are sandbox and visual
// knobs that the server will never need.

import type { TunableMeta } from '@splat/shared';

export interface ShootingSettings {
  /** hopper never empties (phase 0 default; the question economy comes in step 3) */
  infiniteAmmo: boolean;
  /** draw the active marker's spray pattern as dots around the crosshair */
  showPattern: boolean;
  /** draw where recent balls landed */
  showImpacts: boolean;
  /** how many recent impacts to draw */
  impactCount: number;
  /** world splat decals kept before the oldest are recycled */
  decalCap: number;
  /** decalCap used instead when the client quality setting is 'low' (Chromebooks) */
  decalCapLow: number;
  /** some target dummies strafe side to side */
  dummiesMove: boolean;
  /** dummy strafe speed, u/s */
  dummyStrafeSpeed: number;
  /** dummy strafe half-width, u */
  dummyStrafeRange: number;
  /** seconds a splatted dummy stays splatted */
  dummyResetSeconds: number;
  /** rendered ball size relative to its sim radius */
  ballVisualScale: number;
  /** viewmodel push-back per shot, u */
  viewmodelKick: number;
  /** view punch return rate after you stop firing, 1/s */
  punchRecovery: number;
}

export const SHOOTING_DEFAULTS: ShootingSettings = {
  infiniteAmmo: true,
  showPattern: false,
  showImpacts: false,
  impactCount: 30,
  decalCap: 400,
  decalCapLow: 150,
  dummiesMove: true,
  dummyStrafeSpeed: 150,
  dummyStrafeRange: 90,
  dummyResetSeconds: 3,
  ballVisualScale: 1.6,
  viewmodelKick: 1.6,
  punchRecovery: 8,
};

export const SHOOTING_META: Partial<Record<keyof ShootingSettings, TunableMeta>> = {
  infiniteAmmo: { min: 0, max: 1, step: 1, label: 'infinite ammo' },
  showPattern: { min: 0, max: 1, step: 1, label: 'show spray pattern' },
  showImpacts: { min: 0, max: 1, step: 1, label: 'show impacts' },
  impactCount: { min: 1, max: 200, step: 1, label: 'impacts shown' },
  decalCap: { min: 20, max: 2000, step: 10, label: 'splat cap' },
  decalCapLow: { min: 20, max: 2000, step: 10, label: 'splat cap (low quality)' },
  dummiesMove: { min: 0, max: 1, step: 1, label: 'dummies strafe' },
  dummyStrafeSpeed: { min: 0, max: 400, step: 5, label: 'dummy speed (u/s)' },
  dummyStrafeRange: { min: 0, max: 400, step: 5, label: 'dummy strafe range (u)' },
  dummyResetSeconds: { min: 0.5, max: 10, step: 0.1, label: 'splatted reset (s)' },
  ballVisualScale: { min: 0.5, max: 4, step: 0.05, label: 'ball visual size ×' },
  viewmodelKick: { min: 0, max: 6, step: 0.05, label: 'viewmodel kick (u)' },
  punchRecovery: { min: 1, max: 30, step: 0.5, label: 'punch recovery (1/s)' },
};

/** Upper bound for decalCap; the splat meshes are allocated once at this size. */
export const MAX_DECALS = 2000;
