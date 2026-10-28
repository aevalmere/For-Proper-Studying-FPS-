import { describe, expect, it } from 'vitest';
import { createRng, nextFloat, nextRange } from './rng.ts';

describe('rng', () => {
  it('replays the same sequence from the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) expect(nextFloat(a)).toBe(nextFloat(b));
  });

  it('stays in [0, 1) and covers the range', () => {
    const r = createRng(7);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 10000; i++) {
      const v = nextFloat(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.99);
  });

  it('keeps its state as plain JSON-safe data', () => {
    const r = createRng(1);
    nextFloat(r);
    const copy = JSON.parse(JSON.stringify(r)) as typeof r;
    expect(nextRange(copy, 5, 10)).toBe(nextRange(r, 5, 10));
  });
});
