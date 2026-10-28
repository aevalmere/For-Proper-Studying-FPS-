import { describe, expect, it } from 'vitest';
import { ADAPTIVE_DEFAULTS, AdaptiveScale } from './adaptiveScale.ts';

/** Feed `seconds` of frames whose time comes from `ms(scale)`, return the scales seen. */
function drive(a: AdaptiveScale, seconds: number, ms: (scale: number) => number): number[] {
  const seen: number[] = [];
  let t = 0;
  while (t < seconds * 1000) {
    const f = ms(a.scale);
    t += f;
    if (a.frame(f)) seen.push(a.scale);
  }
  return seen;
}

describe('AdaptiveScale', () => {
  it('leaves the scale alone while frames make the budget', () => {
    const a = new AdaptiveScale(1);
    expect(drive(a, 30, () => 16.7)).toEqual([]);
    expect(a.scale).toBe(1);
  });

  it('steps down when fill-rate bound, and keeps the step because it helped', () => {
    const a = new AdaptiveScale(1);
    // GPU bound: frame time scales with pixel count (scale^2)
    drive(a, 20, (s) => 30 * s * s);
    expect(a.scale).toBeLessThan(1);
    expect(a.scale).toBeGreaterThanOrEqual(ADAPTIVE_DEFAULTS.min);
    // at 0.8 the frame is 19.2 ms: under budget, so it settles there
    expect(a.scale).toBeCloseTo(0.8, 5);
  });

  it('probes back up only occasionally, and undoes a probe that brings misses back', () => {
    const a = new AdaptiveScale(1);
    const seen = drive(a, 120, (s) => 30 * s * s);
    // down to 0.8, then probes to 0.85 (21.7 ms: misses) that are undone, with backoff
    expect(Math.max(...seen.slice(2))).toBeLessThanOrEqual(0.85);
    expect(a.scale).toBeCloseTo(0.8, 5);
    // 0.9, 0.8, then at most a few probe/undo pairs in two minutes: no pumping
    expect(seen.length).toBeLessThanOrEqual(2 + 2 * 3);
  });

  it('reverts a step that did not help (CPU bound) and holds off', () => {
    const a = new AdaptiveScale(1);
    const seen = drive(a, 30, () => 28);
    expect(seen[0]).toBeCloseTo(0.9, 5);
    expect(seen[1]).toBe(1);
    // held for holdWindows: no further attempts within the run
    expect(seen.length).toBe(2);
    expect(a.scale).toBe(1);
  });

  it('gives resolution back once there is headroom, never above the setting', () => {
    const a = new AdaptiveScale(0.9);
    let heavy = true;
    const seen = drive(a, 15, (s) => (heavy ? 30 * s * s : 8));
    expect(a.scale).toBeLessThan(0.9);
    heavy = false;
    drive(a, 60, (s) => (heavy ? 30 * s * s : 8));
    expect(a.scale).toBe(0.9);
    expect(seen.every((s) => s <= 0.9)).toBe(true);
  });

  it('never goes below the minimum', () => {
    const a = new AdaptiveScale(1);
    drive(a, 120, (s) => 200 * s * s);
    expect(a.scale).toBe(ADAPTIVE_DEFAULTS.min);
  });

  it('ignores stalls longer than a whole window (tab switch)', () => {
    const a = new AdaptiveScale(1);
    for (let i = 0; i < 20; i++) expect(a.frame(5000)).toBe(false);
    expect(a.scale).toBe(1);
  });

  it('reset() makes the new setting the ceiling and starts over', () => {
    const a = new AdaptiveScale(1);
    drive(a, 20, (s) => 30 * s * s);
    a.reset(0.6);
    expect(a.scale).toBe(0.6);
  });
});
