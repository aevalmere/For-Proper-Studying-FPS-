// Tiny offline synth: sounds are built once at startup into Float32Arrays from
// gliding sine tones and filtered noise, so the game ships no audio files.
// Noise comes from the shared seeded Rng, so every build sounds the same.

import { nextFloat, type Rng } from '@splat/shared';

/** Sample rate the sounds are built at; WebAudio resamples to the device rate. */
export const SYNTH_RATE = 44100;
const TAU = Math.PI * 2;

export function samples(seconds: number): Float32Array {
  return new Float32Array(Math.ceil(seconds * SYNTH_RATE));
}

export interface ToneOpts {
  /** start time in the buffer, s */
  at?: number;
  /** start frequency, Hz */
  f0: number;
  /** end frequency, Hz (default f0); reached exponentially after `glide` s */
  f1?: number;
  glide?: number;
  /** linear attack, s */
  attack?: number;
  /** exponential decay time constant, s */
  decay: number;
  gain?: number;
  /** extra partials as [frequency multiple, relative gain] */
  partials?: readonly (readonly [number, number])[];
}

/** Mix a gliding sine (plus partials) with an attack / exponential-decay envelope into `out`. */
export function addTone(out: Float32Array, o: ToneOpts): void {
  const attack = o.attack ?? 0.002;
  const gain = o.gain ?? 1;
  const f1 = o.f1 ?? o.f0;
  const glide = o.glide ?? 0;
  const start = Math.floor((o.at ?? 0) * SYNTH_RATE);
  const len = Math.min(out.length - start, Math.ceil((attack + o.decay * 7) * SYNTH_RATE));
  const parts: (readonly [number, number])[] = [[1, 1], ...(o.partials ?? [])];
  const phase = parts.map(() => 0);
  for (let i = 0; i < len; i++) {
    const t = i / SYNTH_RATE;
    const g = glide > 0 ? Math.min(1, t / glide) : 1;
    const f = o.f0 * Math.pow(f1 / o.f0, g);
    const env = t < attack ? t / attack : Math.exp(-(t - attack) / o.decay);
    let v = 0;
    for (let k = 0; k < parts.length; k++) {
      phase[k]! += (TAU * f * parts[k]![0]) / SYNTH_RATE;
      v += Math.sin(phase[k]!) * parts[k]![1];
    }
    out[start + i]! += v * env * gain;
  }
}

export interface NoiseOpts {
  at?: number;
  attack?: number;
  decay: number;
  gain?: number;
  /** low-pass cutoff at the start, Hz (two one-pole stages) */
  lp0: number;
  /** low-pass cutoff at the end of the decay, Hz (default lp0) */
  lp1?: number;
  /** one-pole high-pass cutoff, Hz (0 = none) */
  hp?: number;
}

/** Mix filtered white noise with an attack / exponential-decay envelope into `out`. */
export function addNoise(out: Float32Array, rng: Rng, o: NoiseOpts): void {
  const attack = o.attack ?? 0.001;
  const gain = o.gain ?? 1;
  const lp1 = o.lp1 ?? o.lp0;
  const start = Math.floor((o.at ?? 0) * SYNTH_RATE);
  const total = attack + o.decay * 7;
  const len = Math.min(out.length - start, Math.ceil(total * SYNTH_RATE));
  const hpA = o.hp ? 1 - Math.exp((-TAU * o.hp) / SYNTH_RATE) : 0;
  let l1 = 0;
  let l2 = 0;
  let hpLow = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SYNTH_RATE;
    const fc = o.lp0 * Math.pow(lp1 / o.lp0, Math.min(1, t / Math.max(1e-4, attack + o.decay * 3)));
    const a = 1 - Math.exp((-TAU * fc) / SYNTH_RATE);
    const x = nextFloat(rng) * 2 - 1;
    l1 += a * (x - l1);
    l2 += a * (l1 - l2);
    let y = l2;
    if (hpA > 0) {
      hpLow += hpA * (y - hpLow);
      y -= hpLow;
    }
    const env = t < attack ? t / attack : Math.exp(-(t - attack) / o.decay);
    out[start + i]! += y * env * gain;
  }
}

/** Normalize to `peak` and fade the last few ms so a cut-off tail never clicks. */
export function finish(out: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]!));
  const k = max > 0 ? peak / max : 0;
  const fade = Math.min(out.length, Math.ceil(0.006 * SYNTH_RATE));
  for (let i = 0; i < out.length; i++) {
    const tail = out.length - i;
    out[i]! *= k * (tail < fade ? tail / fade : 1);
  }
  return out;
}
