// The sound set: toy-like and school-appropriate (pops, thups, chimes; no gunshots).
// Each entry is synthesized once at startup and carries its own mixing rules.

import { createRng, type Rng } from '@splat/shared';
import { addNoise, addTone, finish, samples } from './synth.ts';

export type SoundId =
  | 'fireSplatter'
  | 'fireLobber'
  | 'fireSpritzer'
  | 'dryFire'
  | 'hit'
  | 'splat'
  | 'worldSplat'
  | 'jump'
  | 'land'
  | 'step1'
  | 'step2';

export interface SoundDef {
  /** gain before the mixer buses */
  gain: number;
  /** a play within this many ms of the previous one is skipped */
  minIntervalMs: number;
  /** at most this many copies at once; another one replaces the oldest copy */
  maxInstances: number;
  /** when every voice is busy, a sound may steal one of equal or lower priority */
  priority: number;
  /** random playback-rate spread (±), so repeats don't sound identical */
  rateJitter: number;
  build(rng: Rng): Float32Array;
}

// note frequencies for the chimes
const C6 = 1046.5;
const E6 = 1318.5;
const G6 = 1568;
const C7 = 2093;

export const SOUNDS: Record<SoundId, SoundDef> = {
  // Splatter "thup": a short low pop with a soft air puff
  fireSplatter: {
    gain: 0.5,
    minIntervalMs: 40,
    maxInstances: 3,
    priority: 2,
    rateJitter: 0.04,
    build(rng) {
      const s = samples(0.12);
      addTone(s, { f0: 420, f1: 120, glide: 0.035, attack: 0.001, decay: 0.022, partials: [[2, 0.25]] });
      addTone(s, { f0: 90, decay: 0.03, gain: 0.4 });
      addNoise(s, rng, { lp0: 3500, lp1: 700, hp: 300, attack: 0.0005, decay: 0.008, gain: 0.5 });
      return finish(s);
    },
  },
  // Lobber "pomp": a rounder, hollow tube pop
  fireLobber: {
    gain: 0.6,
    minIntervalMs: 60,
    maxInstances: 2,
    priority: 2,
    rateJitter: 0.03,
    build(rng) {
      const s = samples(0.3);
      addTone(s, { f0: 260, f1: 85, glide: 0.08, attack: 0.003, decay: 0.06, partials: [[1.5, 0.3], [2, 0.15]] });
      addTone(s, { f0: 600, f1: 350, glide: 0.02, decay: 0.012, gain: 0.25 });
      addNoise(s, rng, { lp0: 1800, lp1: 500, hp: 200, decay: 0.02, gain: 0.35 });
      return finish(s);
    },
  },
  // Spritzer "pfft": a burst of air with a small thump
  fireSpritzer: {
    gain: 0.55,
    minIntervalMs: 60,
    maxInstances: 2,
    priority: 2,
    rateJitter: 0.04,
    build(rng) {
      const s = samples(0.22);
      addNoise(s, rng, { lp0: 7000, lp1: 900, hp: 500, attack: 0.002, decay: 0.05 });
      addTone(s, { f0: 180, f1: 80, glide: 0.04, decay: 0.03, gain: 0.45 });
      return finish(s);
    },
  },
  // empty hopper: a dry plastic click
  dryFire: {
    gain: 0.35,
    minIntervalMs: 120,
    maxInstances: 1,
    priority: 2,
    rateJitter: 0.05,
    build(rng) {
      const s = samples(0.06);
      addNoise(s, rng, { lp0: 8000, hp: 2500, decay: 0.003, gain: 0.6 });
      addTone(s, { f0: 1800, decay: 0.008, gain: 0.3 });
      return finish(s);
    },
  },
  // target hit: a bubbly pop into a soft ding (pitch rises with the hit streak)
  hit: {
    gain: 0.55,
    minIntervalMs: 25,
    maxInstances: 3,
    priority: 3,
    rateJitter: 0,
    build(rng) {
      const s = samples(0.3);
      addTone(s, { f0: 520, f1: 1040, glide: 0.012, attack: 0.001, decay: 0.012, gain: 0.6 });
      addTone(s, { at: 0.008, f0: C6, attack: 0.002, decay: 0.09, gain: 0.7, partials: [[2, 0.18], [3, 0.06]] });
      addNoise(s, rng, { lp0: 6000, hp: 2000, decay: 0.003, gain: 0.15 });
      return finish(s);
    },
  },
  // meter filled: a wet splorch and a rising C-major chime
  splat: {
    gain: 0.7,
    minIntervalMs: 80,
    maxInstances: 2,
    priority: 4,
    rateJitter: 0,
    build(rng) {
      const s = samples(0.7);
      addNoise(s, rng, { lp0: 2000, lp1: 300, hp: 120, attack: 0.002, decay: 0.07, gain: 0.6 });
      addTone(s, { f0: 220, f1: 110, glide: 0.08, decay: 0.06, gain: 0.5 });
      const chime = [[2, 0.2]] as const;
      addTone(s, { at: 0.03, f0: C6, decay: 0.12, gain: 0.5, partials: chime });
      addTone(s, { at: 0.09, f0: E6, decay: 0.12, gain: 0.5, partials: chime });
      addTone(s, { at: 0.15, f0: G6, decay: 0.16, gain: 0.5, partials: chime });
      addTone(s, { at: 0.21, f0: C7, decay: 0.2, gain: 0.35, partials: chime });
      return finish(s);
    },
  },
  // a ball splatting on the world: a quiet wet "plap"
  worldSplat: {
    gain: 0.28,
    minIntervalMs: 30,
    maxInstances: 4,
    priority: 1,
    rateJitter: 0.12,
    build(rng) {
      const s = samples(0.1);
      addNoise(s, rng, { lp0: 2600, lp1: 500, hp: 150, attack: 0.001, decay: 0.018 });
      addTone(s, { f0: 300, f1: 140, glide: 0.03, decay: 0.015, gain: 0.5 });
      return finish(s);
    },
  },
  // jump: a soft breathy "hup"
  jump: {
    gain: 0.25,
    minIntervalMs: 100,
    maxInstances: 1,
    priority: 2,
    rateJitter: 0.05,
    build(rng) {
      const s = samples(0.15);
      addNoise(s, rng, { lp0: 1200, lp1: 2200, hp: 400, attack: 0.015, decay: 0.04, gain: 0.6 });
      addTone(s, { f0: 190, f1: 260, glide: 0.06, attack: 0.005, decay: 0.035, gain: 0.35 });
      return finish(s);
    },
  },
  // landing: a thud (volume and pitch follow the landing speed)
  land: {
    gain: 0.45,
    minIntervalMs: 120,
    maxInstances: 1,
    priority: 2,
    rateJitter: 0.04,
    build(rng) {
      const s = samples(0.25);
      addTone(s, { f0: 120, f1: 48, glide: 0.06, attack: 0.001, decay: 0.05 });
      addNoise(s, rng, { lp0: 900, lp1: 250, attack: 0.001, decay: 0.03, gain: 0.5 });
      return finish(s);
    },
  },
  step1: {
    gain: 0.18,
    minIntervalMs: 120,
    maxInstances: 2,
    priority: 0,
    rateJitter: 0.06,
    build(rng) {
      const s = samples(0.08);
      addNoise(s, rng, { lp0: 1500, lp1: 600, hp: 120, attack: 0.001, decay: 0.012, gain: 0.8 });
      addTone(s, { f0: 150, f1: 90, glide: 0.02, decay: 0.012, gain: 0.4 });
      return finish(s);
    },
  },
  step2: {
    gain: 0.18,
    minIntervalMs: 120,
    maxInstances: 2,
    priority: 0,
    rateJitter: 0.06,
    build(rng) {
      const s = samples(0.08);
      addNoise(s, rng, { lp0: 1200, lp1: 450, hp: 120, attack: 0.001, decay: 0.012, gain: 0.8 });
      addTone(s, { f0: 130, f1: 80, glide: 0.02, decay: 0.012, gain: 0.4 });
      return finish(s);
    },
  },
};

export const SOUND_IDS = Object.keys(SOUNDS) as SoundId[];

/** Build every sound's samples (a few ms of work, once at startup). */
export function synthesizeAll(): Record<SoundId, Float32Array> {
  const out = {} as Record<SoundId, Float32Array>;
  SOUND_IDS.forEach((id, i) => {
    out[id] = SOUNDS[id].build(createRng(0x50a7d + i * 7919));
  });
  return out;
}
