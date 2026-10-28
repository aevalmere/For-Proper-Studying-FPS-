import type { Vec3 } from '../math.ts';

export type RampDir = '+x' | '-x' | '+z' | '-z';

/**
 * Map geometry is a list of convex brushes. `box` is an axis-aligned block.
 * `ramp` fills the same bounds but its top face slopes from min.y at the low edge
 * up to max.y at the edge in direction `up` (a ramp with up '+z' climbs toward +z).
 */
export type BrushShape =
  | { kind: 'box'; min: Vec3; max: Vec3 }
  | { kind: 'ramp'; min: Vec3; max: Vec3; up: RampDir };

export interface MapBrush {
  shape: BrushShape;
  /** 0xRRGGBB, flat color for the graybox renderer */
  color: number;
  /** free-form tags, e.g. 'floor', 'cover', 'booth' */
  tags?: string[];
}

export type Team = 0 | 1;

export interface SpawnPoint {
  pos: Vec3;
  yaw: number;
  /** null = free-for-all spawn */
  team: Team | null;
}

export interface MapZone {
  kind: 'studyBooth';
  min: Vec3;
  max: Vec3;
  team: Team | null;
}

export interface MapDef {
  id: string;
  name: string;
  brushes: MapBrush[];
  spawns: SpawnPoint[];
  zones: MapZone[];
  /** Positions for offline target-range dummies (feet position). */
  dummySpawns: Vec3[];
}

export interface Plane {
  /** outward unit normal */
  n: Vec3;
  /** plane equation: dot(n, p) = d */
  d: number;
}

export interface CompiledBrush {
  planes: Plane[];
  min: Vec3;
  max: Vec3;
}

export interface CollisionWorld {
  brushes: CompiledBrush[];
}

export interface TraceResult {
  /** 0..1 along start→end before touching solid; 1 = no hit */
  fraction: number;
  endPos: Vec3;
  /** surface normal of the hit plane (zero vector if no hit) */
  normal: Vec3;
  /** start position was inside a brush */
  startSolid: boolean;
  /** the whole move was inside a brush */
  allSolid: boolean;
  /** index into world.brushes, -1 if no hit */
  brush: number;
}
