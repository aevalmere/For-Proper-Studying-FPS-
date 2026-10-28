// Non-solid map dressing: painted markings, text labels, and sandbox teleports.
// Kept out of MapDef.brushes so it never touches collision or projectile traces.

import type { Vec3 } from '../math.ts';
import type { MapBrush } from '../world/types.ts';

export type AxisDir = '+x' | '-x' | '+z' | '-z';

export interface MapLabel {
  text: string;
  /** center of the label, on the surface it is painted on */
  pos: Vec3;
  /** outward normal of that surface; '+y' is a floor label */
  facing: AxisDir | '+y';
  /** label height in units; the label is 4x as wide and the text shrinks to fit */
  size: number;
  /** 0xRRGGBB text color (default white) */
  color?: number;
  /** floor labels only: the direction the top of the text points (default '-z') */
  up?: AxisDir;
}

export interface MapTeleport {
  name: string;
  /** feet position */
  pos: Vec3;
  yaw: number;
}

export interface MapDecor {
  /**
   * Paint: brushes drawn flush over solid faces (floor stripes, team accents,
   * booth frames). Each should sit inside or on the surface of a solid brush;
   * the renderer draws them with a depth offset so the coplanar face wins.
   */
  markings: MapBrush[];
  labels: MapLabel[];
  /** sandbox teleport points for the dev panel and the respawn key */
  teleports: MapTeleport[];
}
