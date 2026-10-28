// Scripted ?bench route: no human input. Each segment teleports to a map
// teleport, then drives movement, aim and the trigger as functions of time since
// the segment started. Everything is a function of sim time (tick count), so the
// simulated content (balls, splats, dummy hits) is identical on a fast or a slow
// machine; only the frame rate differs.
//
// No DOM here so it can be unit tested.

import { Buttons, DEG2RAD, type UserCmd } from '@splat/shared';
import type { ViewAngles } from '../game/types.ts';

export interface Segment {
  name: string;
  /** index into ARENA_DECOR.teleports */
  teleport: number;
  /** nominal length, seconds (scaled by the run's `seconds`) */
  seconds: number;
  /** not recorded: lets shaders compile and caches settle */
  warmup?: boolean;
  /** movement, trigger and weapon for time `t` (s) into the segment */
  cmd(t: number, out: UserCmd): void;
  /** view angles for time `t`; `baseYaw` is the teleport's yaw */
  view(t: number, baseYaw: number, out: ViewAngles): void;
}

const FIRE = Buttons.FIRE;
const JUMP = Buttons.JUMP;

/** Semi-auto markers need a fresh press per shot: on for `period/2`, off for the rest. */
function pulse(t: number, period: number): boolean {
  return t % period < period / 2;
}

function moveCmd(out: UserCmd, forward: number, side: number, buttons: number, weapon: number): void {
  out.forward = forward;
  out.side = side;
  out.buttons = buttons;
  out.weapon = weapon;
}

// Teleport indices in ARENA_DECOR (see packages/shared/src/map/arena.ts).
const TP_ORANGE_SPAWN = 0;
const TP_RANGE = 3;
const TP_MID_STAIRS = 4;
const TP_NORTH = 9;

export const SEGMENTS: readonly Segment[] = [
  {
    name: 'warmup',
    teleport: TP_ORANGE_SPAWN,
    seconds: 1.5,
    warmup: true,
    cmd: (t, o) => moveCmd(o, 0, 0, t > 0.5 && pulse(t, 0.25) ? FIRE : 0, 0),
    view: (t, yaw, o) => {
      o.yaw = yaw + Math.sin(t * 4) * 70 * DEG2RAD;
      o.pitch = -4 * DEG2RAD;
    },
  },
  {
    // strafe A/D on the firing line, spray across the dummies
    name: 'range-splatter',
    teleport: TP_RANGE,
    seconds: 4,
    cmd: (t, o) => moveCmd(o, 0, Math.floor(t / 0.5) % 2 ? 1 : -1, FIRE, 0),
    view: (t, yaw, o) => {
      o.yaw = yaw + Math.sin(t * 1.3) * 14 * DEG2RAD;
      o.pitch = (-2 + Math.sin(t * 2.1) * 2) * DEG2RAD;
    },
  },
  {
    name: 'range-lobber',
    teleport: TP_RANGE,
    seconds: 3,
    cmd: (t, o) => moveCmd(o, 0, 0, pulse(t, 0.25) ? FIRE : 0, 1),
    view: (t, yaw, o) => {
      o.yaw = yaw + Math.sin(t * 1.7) * 12 * DEG2RAD;
      o.pitch = 4 * DEG2RAD;
    },
  },
  {
    name: 'range-spritzer',
    teleport: TP_RANGE,
    seconds: 3,
    cmd: (t, o) => moveCmd(o, t > 1.5 ? 1 : 0, 0, pulse(t, 0.25) ? FIRE : 0, 2),
    view: (t, yaw, o) => {
      o.yaw = yaw + Math.sin(t * 2.3) * 10 * DEG2RAD;
      o.pitch = -3 * DEG2RAD;
    },
  },
  {
    // run the full-length north sightline painting both walls and the floor
    name: 'north-run',
    teleport: TP_NORTH,
    seconds: 6,
    cmd: (t, o) => moveCmd(o, 1, 0, FIRE | (t % 1.2 < 0.05 ? JUMP : 0), 0),
    view: (t, yaw, o) => {
      o.yaw = yaw + Math.sin(t * 1.1) * 38 * DEG2RAD;
      o.pitch = (-6 + Math.sin(t * 1.9) * 7) * DEG2RAD;
    },
  },
  {
    // climb the mid stairs (facing south), then a slow 360 over the whole arena
    name: 'mid-overview',
    teleport: TP_MID_STAIRS,
    seconds: 4.5,
    cmd: (t, o) => moveCmd(o, t < 1 ? 1 : 0, 0, t > 1 ? FIRE : 0, 0),
    view: (t, yaw, o) => {
      o.yaw = yaw + (Math.max(0, t - 1) * (Math.PI * 2)) / 3.5;
      o.pitch = -5 * DEG2RAD;
    },
  },
  {
    // spawn exit: the widest view across the arena, bhopping and spraying
    name: 'spawn-overview',
    teleport: TP_ORANGE_SPAWN,
    seconds: 3,
    cmd: (t, o) => moveCmd(o, 1, Math.sin(t * 3) > 0 ? 1 : -1, FIRE | (t % 0.8 < 0.05 ? JUMP : 0), Math.floor(t) % 3 === 2 ? 1 : 0),
    view: (t, yaw, o) => {
      o.yaw = yaw + Math.sin(t * 1.5) * 60 * DEG2RAD;
      o.pitch = (-2 + Math.sin(t * 2.5) * 4) * DEG2RAD;
    },
  },
];

/** Recorded length of the default route, seconds. */
export const NOMINAL_SECONDS = SEGMENTS.reduce((s, x) => s + (x.warmup ? 0 : x.seconds), 0);

export interface ScheduledSegment {
  seg: Segment;
  index: number;
  startTick: number;
  ticks: number;
}

/** Lay the segments out on the tick timeline; recorded segments are scaled so they total `seconds`. */
export function schedule(segments: readonly Segment[], seconds: number, tickRate: number): ScheduledSegment[] {
  const k = seconds > 0 ? seconds / NOMINAL_SECONDS : 1;
  const out: ScheduledSegment[] = [];
  let tick = 0;
  segments.forEach((seg, index) => {
    const ticks = Math.max(1, Math.round((seg.warmup ? seg.seconds : seg.seconds * k) * tickRate));
    out.push({ seg, index, startTick: tick, ticks });
    tick += ticks;
  });
  return out;
}

/** The scheduled segment covering `tick`, or null past the end. */
export function segmentAt(plan: readonly ScheduledSegment[], tick: number): ScheduledSegment | null {
  for (const s of plan) if (tick >= s.startTick && tick < s.startTick + s.ticks) return s;
  return null;
}
