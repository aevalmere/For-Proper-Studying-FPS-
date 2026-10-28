import { describe, expect, it } from 'vitest';
import { dist, heapStats, percentile, shareAbove } from './stats.ts';

describe('bench stats', () => {
  it('nearest-rank percentiles', () => {
    const v = [5, 1, 4, 2, 3];
    expect(percentile(v, 5, 50)).toBe(3);
    expect(percentile(v, 5, 100)).toBe(5);
    expect(percentile(v, 5, 0)).toBe(1);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 100, 95)).toBe(95);
    expect(percentile(hundred, 100, 99)).toBe(99);
  });

  it('only looks at the first n values and does not reorder the input', () => {
    const v = new Float32Array([3, 1, 2, 1000, 1000]);
    expect(percentile(v, 3, 100)).toBe(3);
    expect(Array.from(v)).toEqual([3, 1, 2, 1000, 1000]);
  });

  it('share above a limit', () => {
    expect(shareAbove([10, 20, 30, 40], 4, 16.7)).toBe(0.75);
    expect(shareAbove([], 0, 1)).toBe(0);
  });

  it('dist summary', () => {
    const d = dist([1, 2, 3, 4], 4);
    expect(d).toEqual({ mean: 2.5, p50: 2, p95: 4, p99: 4, max: 4 });
  });

  it('heap: allocation rate is the sum of rises, collections are drops', () => {
    // 1 MB/s of allocation with a 2 MB collection every 2 s
    const t: number[] = [];
    const b: number[] = [];
    let heap = 10 << 20;
    for (let i = 0; i <= 40; i++) {
      t.push(i * 100);
      b.push(heap);
      heap += 1 << 17; // 128 KB per 100 ms
      if (i % 20 === 19) heap -= 2 << 20;
    }
    const h = heapStats(t, b, t.length);
    expect(h.allocBytesPerSec).toBeGreaterThan(1.1e6);
    expect(h.allocBytesPerSec).toBeLessThan(1.4e6);
    expect(h.gcCount).toBe(2);
  });
});
