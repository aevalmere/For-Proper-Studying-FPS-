// CS-style FOV: the value is the horizontal FOV on a 4:3 screen. The vertical FOV
// it implies is kept fixed, and wider screens see more horizontally (Hor+), the
// way CS:GO/CS2 handle 16:9.

import { DEG2RAD, RAD2DEG } from '@splat/shared';

/** Three.js PerspectiveCamera.fov (vertical, degrees) for a CS-style 4:3 horizontal FOV. */
export function verticalFovFromCs(fov43: number): number {
  return 2 * Math.atan(Math.tan((fov43 * DEG2RAD) / 2) * 0.75) * RAD2DEG;
}

/** Actual horizontal FOV (degrees) for a vertical FOV at an aspect ratio. */
export function horizontalFov(verticalFov: number, aspect: number): number {
  return 2 * Math.atan(Math.tan((verticalFov * DEG2RAD) / 2) * aspect) * RAD2DEG;
}
