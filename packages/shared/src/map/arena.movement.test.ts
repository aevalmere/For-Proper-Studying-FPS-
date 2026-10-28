// Integration: the arena's movement features behave as labelled under the
// goldsrc preset. A failure here means either the map or movement changed.

import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../constants.ts';
import { Buttons, emptyCmd } from '../input.ts';
import { vec3 } from '../math.ts';
import { MOVEMENT_PRESETS } from '../movement/config.ts';
import { createPlayerState, stepPlayer, type PlayerState } from '../movement/pmove.ts';
import { buildCollisionWorld } from '../world/collision.ts';
import { ARENA, ARENA_DECOR, ARENA_HEIGHTS } from './arena.ts';

const world = buildCollisionWorld(ARENA);
const cfg = { ...MOVEMENT_PRESETS.goldsrc };

function teleport(name: string): { s: PlayerState; yaw: number } {
  const tp = ARENA_DECOR.teleports.find((t) => t.name === name)!;
  const s = createPlayerState(tp.pos);
  // settle onto the floor
  const cmd = emptyCmd();
  cmd.yaw = tp.yaw;
  for (let i = 0; i < 8; i++) stepPlayer(s, cmd, cfg, world, TICK_DT);
  return { s, yaw: tp.yaw };
}

/** Run `ticks` ticks; `buttons(t)` picks the buttons for tick t. Always holds forward. */
function run(s: PlayerState, yaw: number, ticks: number, buttons: (t: number) => number = () => 0): number {
  const cmd = emptyCmd();
  let maxY = s.pos.y;
  for (let t = 0; t < ticks; t++) {
    cmd.seq = t;
    cmd.yaw = yaw;
    cmd.forward = 1;
    cmd.buttons = buttons(t);
    stepPlayer(s, cmd, cfg, world, TICK_DT);
    maxY = Math.max(maxY, s.pos.y);
  }
  return maxY;
}

/** Walk into the face first, then jump (optionally crouching) while still pushing forward. */
function jumpAt(name: string, crouch: boolean): PlayerState {
  const { s, yaw } = teleport(name);
  run(s, yaw, 64); // reach and press against the ledge
  run(s, yaw, 96, (t) => (t < 2 ? Buttons.JUMP : 0) | (crouch ? Buttons.CROUCH : 0));
  run(s, yaw, 32); // stand up on top if we made it
  return s;
}

describe('arena movement features (goldsrc preset)', () => {
  it('the 56 ledge needs a crouch-jump', () => {
    expect(jumpAt('Mid crouch-jump ledge', false).pos.y).toBeCloseTo(0, 0);
    expect(jumpAt('Mid crouch-jump ledge', true).pos.y).toBeCloseTo(ARENA_HEIGHTS.crouchJumpLedge, 0);
  });

  it('a normal jump climbs the 40 step from the ledge to the mid platform', () => {
    const s = jumpAt('Mid crouch-jump ledge', true);
    run(s, 0, 32, (t) => (t < 2 ? Buttons.JUMP : 0));
    run(s, 0, 32);
    expect(s.pos.y).toBeCloseTo(ARENA_HEIGHTS.midPlatform, 0);
  });

  it('16-unit stairs and the 27 degree ramp walk straight up to the platform', () => {
    for (const name of ['Mid stairs (16)', 'Mid ramp (27 deg)']) {
      const { s, yaw } = teleport(name);
      // no jumping, so the highest point is the highest floor reached; running on
      // would carry the player across the platform and off the far side
      const maxY = run(s, yaw, 80);
      expect(maxY, name).toBeCloseTo(ARENA_HEIGHTS.midPlatform, 0);
      expect(s.pos.y, name).toBeCloseTo(ARENA_HEIGHTS.midPlatform, 0);
      expect(s.onGround, name).toBe(true);
    }
  });

  it('the 30 degree ramp reaches the catwalk', () => {
    const { s, yaw } = teleport('Catwalk ramp (30 deg)');
    run(s, yaw, 128);
    expect(s.pos.y).toBeCloseTo(ARENA_HEIGHTS.catwalk, 0);
  });

  it('the 58 degree ramp cannot be walked up', () => {
    const { s, yaw } = teleport('Steep ramp (58 deg)');
    const maxY = run(s, yaw, 192);
    expect(maxY).toBeLessThan(ARENA_HEIGHTS.catwalk - 32);
    expect(s.pos.z).toBeLessThan(928);
  });

  it('runs at max speed down the practice strip', () => {
    const { s, yaw } = teleport('Practice strip');
    run(s, yaw, 128);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeCloseTo(cfg.maxSpeed, 0);
    expect(s.pos.x).toBeGreaterThan(vec3(-1472, 0, 0).x + 256);
  });
});
