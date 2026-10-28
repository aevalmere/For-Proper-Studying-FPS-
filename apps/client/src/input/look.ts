// Mouse look math. CS convention: one mouse count turns sensitivity * m_yaw
// degrees, m_yaw = m_pitch = 0.022, so a CS player's sensitivity carries over 1:1.

import { DEG2RAD } from '@splat/shared';
import type { ViewAngles } from '../game/types.ts';

export const M_YAW = 0.022;
export const PITCH_LIMIT = 89 * DEG2RAD;

const TWO_PI = Math.PI * 2;

/** Radians turned per mouse count. */
export function radiansPerCount(sensitivity: number): number {
  return sensitivity * M_YAW * DEG2RAD;
}

/** Apply raw mouse counts to the view. +x (mouse right) turns right, +y (mouse down) looks down. */
export function applyMouseLook(view: ViewAngles, dx: number, dy: number, sensitivity: number, invertY = false): void {
  const k = radiansPerCount(sensitivity);
  view.yaw -= dx * k;
  view.pitch -= (invertY ? -dy : dy) * k;
  if (view.pitch > PITCH_LIMIT) view.pitch = PITCH_LIMIT;
  else if (view.pitch < -PITCH_LIMIT) view.pitch = -PITCH_LIMIT;
  // keep yaw in (-pi, pi] so it never loses float precision
  if (view.yaw > Math.PI || view.yaw <= -Math.PI) view.yaw -= TWO_PI * Math.round(view.yaw / TWO_PI);
}
