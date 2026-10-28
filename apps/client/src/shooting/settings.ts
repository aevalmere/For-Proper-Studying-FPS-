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
  /** draw target hitboxes and ball hit radii as wireframes, and mark exact hit points */
  showHitboxes: boolean;
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
  /** viewmodel push-back per shot, u */
  viewmodelKick: number;
  /** view punch return rate after you stop firing, 1/s */
  punchRecovery: number;
  /**
   * the camera kick stays up until the spray pattern actually resets, so the view
   * always shows where a follow-up shot goes; off = it eases back as soon as you stop
   */
  punchHoldsUntilReset: boolean;
}

export const SHOOTING_DEFAULTS: ShootingSettings = {
  infiniteAmmo: true,
  showPattern: false,
  showImpacts: false,
  showHitboxes: false,
  impactCount: 30,
  decalCap: 400,
  decalCapLow: 150,
  dummiesMove: true,
  dummyStrafeSpeed: 150,
  dummyStrafeRange: 90,
  dummyResetSeconds: 3,
  viewmodelKick: 1.6,
  punchRecovery: 8,
  punchHoldsUntilReset: true,
};

export const SHOOTING_META: Partial<Record<keyof ShootingSettings, TunableMeta>> = {
  infiniteAmmo: { min: 0, max: 1, step: 1, label: 'infinite ammo' },
  showPattern: { min: 0, max: 1, step: 1, label: 'show spray pattern' },
  showImpacts: { min: 0, max: 1, step: 1, label: 'show impacts' },
  showHitboxes: { min: 0, max: 1, step: 1, label: 'show hitboxes' },
  impactCount: { min: 1, max: 200, step: 1, label: 'impacts shown' },
  decalCap: { min: 20, max: 2000, step: 10, label: 'splat cap' },
  decalCapLow: { min: 20, max: 2000, step: 10, label: 'splat cap (low quality)' },
  dummiesMove: { min: 0, max: 1, step: 1, label: 'dummies strafe' },
  dummyStrafeSpeed: { min: 0, max: 400, step: 5, label: 'dummy speed (u/s)' },
  dummyStrafeRange: { min: 0, max: 400, step: 5, label: 'dummy strafe range (u)' },
  dummyResetSeconds: { min: 0.5, max: 10, step: 0.1, label: 'splatted reset (s)' },
  viewmodelKick: { min: 0, max: 6, step: 0.05, label: 'viewmodel kick (u)' },
  punchRecovery: { min: 1, max: 30, step: 0.5, label: 'punch recovery (1/s)' },
  punchHoldsUntilReset: { min: 0, max: 1, step: 1, label: 'kick holds until spray reset' },
};

/** Upper bound for decalCap; the splat meshes are allocated once at this size. */
export const MAX_DECALS = 2000;
