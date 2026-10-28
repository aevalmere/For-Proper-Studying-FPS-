// Graybox arena. Layout (top view, +x east, +z south; yaw 0 looks north / -z):
//
//   z=-1024 +---------------------------------------------------------------+
//           | north corridor: long sightline along z=-896, ledges on wall    |
//   z=-640  |      ===divider===  gap  ===divider===   gap   ===divider===    |
//           | ORANGE |  cover      stairs                      cover  | BLUE |
//           | base   |  crates   [mid platform 96]  ramps      crates | base |
//           | +booth |           crouch ledge                         |+booth|
//   z=640   |      ===divider===  gap  ===divider===   gap   ===divider===    |
//           | south lane: catwalk 128 on 30 deg ramps, steep 58 deg ramp     |
//   z=1024  +--door------------------------------------------------door----+
//           | practice strip: flat, stripes every 256 from x=-1408          |
//   z=1296  +--door---------------------------------------------------------+
//           | target range: firing line x=-1344, dummies at 256..1536       |
//   z=1664  +---------------------------------------------------------------+
//          x=-1536                                                   x=1536
//
// Orange (team 0) is west, blue (team 1) east; the blue half is the orange half
// mirrored across x=0. Floor top is y=0. Hull is 32 wide, 72 tall (36 ducked),
// step height 18, jump ~45, crouch-jump ~63. Ledge heights are chosen with a few
// units of margin either side of those numbers.

import { type Vec3, vec3 } from '../math.ts';
import type { MapBrush, MapDef, MapZone, RampDir, SpawnPoint, Team } from '../world/types.ts';
import type { AxisDir, MapDecor, MapLabel, MapTeleport } from './decor.ts';

// index.ts only re-exports this file, so the decor types ride along from here.
export * from './decor.ts';

// --- palette ---------------------------------------------------------------
// Neutral grays for structure; team colors are Okabe-Ito orange/blue and only
// appear as accents (markings, booth frames, labels).
export const TEAM_COLORS: Record<Team, number> = { 0: 0xe69f00, 1: 0x0072b2 };
const TEAM_NAMES: Record<Team, string> = { 0: 'ORANGE', 1: 'BLUE' };

const C = {
  floor: 0x7b8189,
  annexFloor: 0x6e7880,
  outerWall: 0x8a9098,
  divider: 0x969ca5,
  cover: 0xaaa497,
  ledge: 0xa0a8b2,
  ramp: 0xbac0c8,
  steep: 0xc3a596,
  booth: 0xddd8cb,
  white: 0xe8e8e8,
  yellow: 0xf0e442,
} as const;

/** Heights the movement features are built around (see header). */
export const ARENA_HEIGHTS = {
  step: 16,
  /** clears with a normal jump, not with a step */
  jumpLedge: 40,
  /** needs a crouch-jump */
  crouchJumpLedge: 56,
  midPlatform: 96,
  catwalk: 128,
} as const;

// --- builders ----------------------------------------------------------------

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, ...tags: string[]): MapBrush {
  return {
    shape: {
      kind: 'box',
      min: vec3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      max: vec3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
    },
    color,
    tags,
  };
}

/** Ramp filling the bounds, climbing toward `up` (see BrushShape). */
function ramp(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, up: RampDir, color: number, ...tags: string[]): MapBrush {
  const b = box(x0, y0, z0, x1, y1, z1, color, ...tags);
  return { ...b, shape: { kind: 'ramp', min: b.shape.min, max: b.shape.max, up } };
}

const FLIP_DIR: Record<AxisDir, AxisDir> = { '+x': '-x', '-x': '+x', '+z': '+z', '-z': '-z' };

/** Mirror across x=0. */
function mirrorBrush(b: MapBrush, color = b.color): MapBrush {
  const { min, max } = b.shape;
  const m = vec3(-max.x, min.y, min.z);
  const M = vec3(-min.x, max.y, max.z);
  const shape = b.shape.kind === 'ramp' ? { kind: 'ramp' as const, min: m, max: M, up: FLIP_DIR[b.shape.up] } : { kind: 'box' as const, min: m, max: M };
  return { shape, color, tags: b.tags ? [...b.tags] : [] };
}

function mirrorVec(v: Vec3): Vec3 {
  return vec3(-v.x, v.y, v.z);
}

function mirrorLabel(l: MapLabel, text = l.text, color = l.color): MapLabel {
  const out: MapLabel = { ...l, text, pos: mirrorVec(l.pos), facing: l.facing === '+y' ? '+y' : FLIP_DIR[l.facing] };
  if (color !== undefined) out.color = color;
  if (l.up) out.up = FLIP_DIR[l.up];
  return out;
}

function label(text: string, x: number, y: number, z: number, facing: MapLabel['facing'], size: number, color?: number, up?: AxisDir): MapLabel {
  const l: MapLabel = { text, pos: vec3(x, y, z), facing, size };
  if (color !== undefined) l.color = color;
  if (up) l.up = up;
  return l;
}

// --- geometry ----------------------------------------------------------------

const X = 1536; // half length of the arena
const WALL_H = 512;
const ANNEX_H = 384;
const DIVIDER_H = 160;

const brushes: MapBrush[] = [];
const markings: MapBrush[] = [];
const labels: MapLabel[] = [];

// Shell: floor slabs (arena and annex), outer walls.
brushes.push(
  box(-X - 32, -32, -1056, X + 32, 0, 1040, C.floor, 'floor'),
  box(-X - 32, -32, 1040, X + 32, 0, 1696, C.annexFloor, 'floor', 'annex'),
  box(-X - 32, 0, -1056, -X, WALL_H, 1696, C.outerWall, 'wall', 'outer'),
  box(X, 0, -1056, X + 32, WALL_H, 1696, C.outerWall, 'wall', 'outer'),
  box(-X, 0, -1056, X, WALL_H, -1024, C.outerWall, 'wall', 'outer'),
  box(-X, 0, 1664, X, WALL_H, 1696, C.outerWall, 'wall', 'outer'),
);

// Arena / practice-strip wall (z 1024..1040), doors near each base.
brushes.push(
  box(-X, 0, 1024, -1504, ANNEX_H, 1040, C.divider, 'wall'),
  box(-1504, 128, 1024, -1408, ANNEX_H, 1040, C.divider, 'wall'),
  box(-1408, 0, 1024, 1408, ANNEX_H, 1040, C.divider, 'wall'),
  box(1408, 128, 1024, 1504, ANNEX_H, 1040, C.divider, 'wall'),
  box(1504, 0, 1024, X, ANNEX_H, 1040, C.divider, 'wall'),
);
// Strip / range wall (z 1296..1312), one door behind the firing line.
brushes.push(
  box(-X, 0, 1296, -1504, ANNEX_H, 1312, C.divider, 'wall'),
  box(-1504, 128, 1296, -1408, ANNEX_H, 1312, C.divider, 'wall'),
  box(-1408, 0, 1296, X, ANNEX_H, 1312, C.divider, 'wall'),
);
labels.push(
  label('PRACTICE + RANGE', -1456, 168, 1024, '-z', 24),
  label('PRACTICE', 1456, 168, 1024, '-z', 24),
  label('RANGE', -1456, 168, 1296, '-z', 24),
);

// Lane dividers (north z -656..-640, south z 640..656), shared by both halves.
for (const [x0, x1] of [
  [-1024, -704],
  [-576, -128],
  [128, 576],
  [704, 1024],
] as const) {
  brushes.push(box(x0, 0, -656, x1, DIVIDER_H, -640, C.divider, 'wall'));
}
for (const [x0, x1] of [
  [-1024, -640],
  [-384, 384],
  [640, 1024],
] as const) {
  brushes.push(box(x0, 0, 640, x1, DIVIDER_H, 656, C.divider, 'wall'));
}

// Mid platform (center, symmetric): stairs north, walkable ramps east/west,
// crouch-jump ledge south (56) from which a normal jump (40) reaches the top.
const P = ARENA_HEIGHTS.midPlatform;
brushes.push(box(-160, 0, -96, 160, P, 96, C.ledge, 'platform'));
brushes.push(ramp(-352, 0, -64, -160, P, 64, '+x', C.ramp, 'ramp')); // 26.6 deg
brushes.push(ramp(160, 0, -64, 352, P, 64, '-x', C.ramp, 'ramp'));
for (let k = 1; k <= 6; k++) {
  const z1 = -96 - 32 * (6 - k);
  brushes.push(box(-64, 0, z1 - 32, 64, ARENA_HEIGHTS.step * k, z1, C.ledge, 'stairs'));
}
brushes.push(box(-64, 0, 96, 64, ARENA_HEIGHTS.crouchJumpLedge, 160, C.ledge, 'ledge'));
labels.push(
  label('CROUCH-JUMP 56', 0, 28, 160, '+z', 24),
  label('JUMP 40', 0, 76, 96, '+z', 24),
  label('STEPS 16', 0, 0, -320, '+y', 32, undefined, '+z'),
  label('RAMP 27', -416, 0, 0, '+y', 32, undefined, '+x'),
  label('RAMP 27', 416, 0, 0, '+y', 32, undefined, '-x'),
);

// North corridor centerpiece: crouch-jump ledge against the north wall.
brushes.push(box(-96, 0, -1024, 96, ARENA_HEIGHTS.crouchJumpLedge, -960, C.ledge, 'ledge'));
labels.push(label('CROUCH-JUMP 56', 0, 28, -960, '+z', 24));

// South lane center: catwalk along the south wall, steep (unwalkable) ramp.
const CW = ARENA_HEIGHTS.catwalk;
brushes.push(box(-512, 0, 928, 512, CW, 1024, C.ledge, 'catwalk'));
brushes.push(ramp(-128, 0, 848, 128, CW, 928, '+z', C.steep, 'ramp', 'steep')); // 58 deg
labels.push(label('TOO STEEP 58', 0, 0, 800, '+y', 32, undefined, '+z'));

// --- one half (orange, west); mirrored for blue ---------------------------------

interface Half {
  brushes: MapBrush[];
  /** team-colored paint; recolored when mirrored */
  teamMarkings: MapBrush[];
  labels: MapLabel[];
  teamLabels: MapLabel[];
}

const half: Half = { brushes: [], teamMarkings: [], labels: [], teamLabels: [] };
const T0 = TEAM_COLORS[0];

// Base: spawn shield walls between spawn and mid.
half.brushes.push(
  box(-1168, 0, -352, -1152, 128, -128, C.divider, 'wall', 'spawnShield'),
  box(-1168, 0, 128, -1152, 128, 352, C.divider, 'wall', 'spawnShield'),
);
half.teamMarkings.push(
  box(-1168, 112, -352, -1152, 128, -128, T0),
  box(-1168, 112, 128, -1152, 128, 352, T0),
);

// Study booth: enclosed nook in the base's north-west corner, door facing the spawns.
// Interior x -1536..-1392, z -480..-352, y 0..112.
half.brushes.push(
  box(-1536, 0, -496, -1376, 176, -480, C.booth, 'booth'), // north wall
  box(-1392, 0, -480, -1376, 176, -336, C.booth, 'booth'), // east wall
  box(-1536, 0, -352, -1488, 176, -336, C.booth, 'booth'), // south wall, west of door
  box(-1424, 0, -352, -1392, 176, -336, C.booth, 'booth'), // south wall, east of door
  box(-1488, 96, -352, -1424, 176, -336, C.booth, 'booth'), // lintel
  box(-1536, 112, -480, -1392, 176, -352, C.booth, 'booth'), // roof
);
half.teamMarkings.push(
  box(-1504, 0, -352, -1488, 112, -336, T0), // door frame
  box(-1424, 0, -352, -1408, 112, -336, T0),
  box(-1504, 96, -352, -1408, 112, -336, T0),
  box(-1520, -1, -464, -1408, 0, -368, T0), // floor pad
  box(-1536, 160, -496, -1376, 176, -336, T0), // roof band, visible across the base
);
half.teamLabels.push(label('STUDY', -1456, 136, -336, '+z', 40, T0));

// Base dressing: spawn pad outline, base line, back wall band and name.
half.teamMarkings.push(
  box(-1472, -1, -232, -1464, 0, 232, T0),
  box(-1352, -1, -232, -1344, 0, 232, T0),
  box(-1472, -1, -232, -1344, 0, -224, T0),
  box(-1472, -1, 224, -1344, 0, 232, T0),
  box(-1132, -1, -1024, -1124, 0, 1024, T0),
  box(-1537, 192, -1024, -1536, 208, 1024, T0),
);
half.teamLabels.push(label(`${TEAM_NAMES[0]} BASE`, -1536, 256, 0, '+x', 64, T0));

// North corridor: crates flush against the divider, jump ledge on the north wall.
// The sightline band (z -928..-864) stays clear for the whole length.
half.brushes.push(
  box(-896, 0, -720, -832, 64, -656, C.cover, 'cover', 'crate'),
  box(-448, 0, -720, -384, 32, -656, C.cover, 'cover', 'crate'),
  box(-384, 0, -720, -320, 64, -656, C.cover, 'cover', 'crate'),
  box(-704, 0, -1024, -320, ARENA_HEIGHTS.jumpLedge, -960, C.ledge, 'ledge'),
);
half.labels.push(label('JUMP 40', -512, 20, -960, '+z', 24));

// Middle lane cover.
half.brushes.push(
  // crate + half crate near the base exit (north)
  box(-1024, 0, -448, -960, 64, -384, C.cover, 'cover', 'crate'),
  box(-960, 0, -448, -928, 32, -384, C.cover, 'cover', 'crate'),
  // crate + tall crate (64 -> 112 is a crouch-jump) near the base exit (south)
  box(-1024, 0, 384, -960, 64, 448, C.cover, 'cover', 'crate'),
  box(-1024, 0, 448, -960, 112, 512, C.cover, 'cover', 'crate'),
  // wall across the lane: blocks the view from mid into the spawn gap
  box(-768, 0, -192, -752, 128, 192, C.divider, 'wall', 'cover'),
  // lookout block on a walkable ramp (26.6 deg)
  box(-512, 0, -560, -384, 96, -480, C.ledge, 'ledge'),
  ramp(-704, 0, -560, -512, 96, -480, '+x', C.ramp, 'ramp'),
  // waist-high wall (crouch cover, jump over)
  box(-544, 0, -416, -528, ARENA_HEIGHTS.jumpLedge, -224, C.cover, 'cover'),
  // jump box (normal-jump ledge)
  box(-640, 0, 256, -512, ARENA_HEIGHTS.jumpLedge, 384, C.ledge, 'ledge'),
  // crates flanking the mid platform
  box(-320, 0, 288, -256, 64, 352, C.cover, 'cover', 'crate'),
  box(-320, 0, -416, -256, 64, -352, C.cover, 'cover', 'crate'),
);
half.labels.push(label('JUMP 40', -576, 20, 384, '+z', 24));

// South lane: catwalk ramp (29.7 deg), crates.
half.brushes.push(
  ramp(-736, 0, 928, -512, CW, 1024, '+x', C.ramp, 'ramp'),
  box(-960, 0, 720, -896, 64, 784, C.cover, 'cover', 'crate'),
  box(-288, 0, 720, -224, 64, 784, C.cover, 'cover', 'crate'),
);
half.labels.push(label('RAMP 30', -784, 0, 976, '+y', 24, undefined, '+x'));

// Emit both halves.
const T1 = TEAM_COLORS[1];
brushes.push(...half.brushes, ...half.brushes.map((b) => mirrorBrush(b)));
markings.push(...half.teamMarkings, ...half.teamMarkings.map((b) => mirrorBrush(b, T1)));
labels.push(
  ...half.labels,
  ...half.teamLabels,
  ...half.labels.map((l) => mirrorLabel(l)),
  ...half.teamLabels.map((l) => mirrorLabel(l, l.text.replace(TEAM_NAMES[0], TEAM_NAMES[1]), T1)),
);

// --- practice strip (z 1040..1296) ---------------------------------------------
// Stripes every 256 units from the start line at x=-1408; every 1024 is yellow.
const STRIP_START = -1408;
for (let k = 0; STRIP_START + 256 * k <= 1408; k++) {
  const x = STRIP_START + 256 * k;
  const major = k % 4 === 0;
  const w = major ? 8 : 4;
  markings.push(box(x - w, -1, 1040, x + w, 0, 1296, major ? C.yellow : C.white, 'marker'));
  const text = k === 0 ? 'START' : String(256 * k);
  labels.push(label(text, x + 32, 0, 1168, '+y', 32, major ? C.yellow : undefined, '+x'));
  // wall copy, except where it would hang over a door opening
  if (Math.abs(x) + 64 <= 1408) labels.push(label(text, x, 96, 1040, '+z', 32, major ? C.yellow : undefined));
}

// --- target range (z 1312..1664) ---------------------------------------------------
const FIRING_LINE = -1344;
markings.push(box(FIRING_LINE - 4, -1, 1312, FIRING_LINE + 4, 0, 1664, C.yellow, 'marker'));
labels.push(label('FIRING LINE', FIRING_LINE - 40, 0, 1488, '+y', 32, C.yellow, '+x'));
for (const d of [256, 512, 768, 1024, 1280, 1536]) {
  const x = FIRING_LINE + d;
  markings.push(box(x - 2, -1, 1312, x + 2, 0, 1664, C.white, 'marker'));
  labels.push(label(String(d), x, 96, 1664, '-z', 32));
  labels.push(label(String(d), x - 24, 0, 1360, '+y', 24, undefined, '+x'));
}

// [distance from the firing line, z]
const DUMMIES: [number, number][] = [
  [256, 1424],
  [256, 1552],
  [512, 1488],
  [768, 1424],
  [768, 1552],
  [1024, 1488],
  [1280, 1424],
  [1536, 1552],
];
const dummySpawns: Vec3[] = DUMMIES.map(([d, z]) => vec3(FIRING_LINE + d, 0, z));

// --- spawns, zones, teleports -----------------------------------------------------

const FACE_EAST = -Math.PI / 2; // looks down +x
const FACE_WEST = Math.PI / 2; // looks down -x
const FACE_NORTH = 0;
const FACE_SOUTH = Math.PI;

const spawns: SpawnPoint[] = [];
for (const team of [0, 1] as const) {
  const sx = team === 0 ? 1 : -1;
  for (const x of [-1440, -1376]) {
    for (const z of [-192, -64, 64, 192]) {
      spawns.push({ pos: vec3(x * sx, 0, z), yaw: team === 0 ? FACE_EAST : FACE_WEST, team });
    }
  }
}

const boothZone = (team: Team): MapZone => {
  const s = team === 0 ? 1 : -1;
  const xa = -1536 * s;
  const xb = -1392 * s;
  return { kind: 'studyBooth', min: vec3(Math.min(xa, xb), 0, -480), max: vec3(Math.max(xa, xb), 112, -352), team };
};

const teleports: MapTeleport[] = [
  { name: 'Orange spawn', pos: vec3(-1408, 0, 0), yaw: FACE_EAST },
  { name: 'Blue spawn', pos: vec3(1408, 0, 0), yaw: FACE_WEST },
  { name: 'Practice strip', pos: vec3(-1472, 0, 1168), yaw: FACE_EAST },
  { name: 'Target range', pos: vec3(-1408, 0, 1488), yaw: FACE_EAST },
  { name: 'Mid stairs (16)', pos: vec3(0, 0, -352), yaw: FACE_SOUTH },
  { name: 'Mid crouch-jump ledge', pos: vec3(0, 0, 256), yaw: FACE_NORTH },
  { name: 'Mid ramp (27 deg)', pos: vec3(-480, 0, 0), yaw: FACE_EAST },
  { name: 'Steep ramp (58 deg)', pos: vec3(0, 0, 736), yaw: FACE_SOUTH },
  { name: 'Catwalk ramp (30 deg)', pos: vec3(-832, 0, 976), yaw: FACE_EAST },
  { name: 'North sightline', pos: vec3(-1408, 0, -896), yaw: FACE_EAST },
  { name: 'Orange study booth', pos: vec3(-1456, 0, -416), yaw: FACE_SOUTH },
];

export const ARENA: MapDef = {
  id: 'arena',
  name: 'Graybox Arena',
  brushes,
  spawns,
  zones: [boothZone(0), boothZone(1)],
  dummySpawns,
};

export const ARENA_DECOR: MapDecor = { markings, labels, teleports };
