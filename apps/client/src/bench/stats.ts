// Summary statistics for the benchmark. No DOM, so it can be unit tested.

/** Nearest-rank percentile (p in 0..100) of the first `n` values. Copies, so `values` is untouched. */
export function percentile(values: ArrayLike<number>, n: number, p: number): number {
  if (n <= 0) return 0;
  const sorted = Float64Array.from({ length: n }, (_, i) => values[i]!).sort();
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * n);
  return sorted[Math.min(n - 1, Math.max(0, rank - 1))]!;
}

export function mean(values: ArrayLike<number>, n: number): number {
  if (n <= 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i]!;
  return s / n;
}

export function max(values: ArrayLike<number>, n: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) if (values[i]! > m) m = values[i]!;
  return m;
}

/** Fraction (0..1) of the first `n` values strictly above `limit`. */
export function shareAbove(values: ArrayLike<number>, n: number, limit: number): number {
  if (n <= 0) return 0;
  let c = 0;
  for (let i = 0; i < n; i++) if (values[i]! > limit) c++;
  return c / n;
}

export interface Dist {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function dist(values: ArrayLike<number>, n: number): Dist {
  return {
    mean: round(mean(values, n)),
    p50: round(percentile(values, n, 50)),
    p95: round(percentile(values, n, 95)),
    p99: round(percentile(values, n, 99)),
    max: round(max(values, n)),
  };
}

export interface HeapStats {
  /** bytes/s: net change in used heap over the run (end minus start, through any GCs) */
  netBytesPerSec: number;
  /** bytes/s: sum of every increase between samples; approximates the allocation rate */
  allocBytesPerSec: number;
  /** drops of at least `gcDropBytes` between consecutive samples (likely collections) */
  gcCount: number;
}

/**
 * Heap trend from (time ms, usedJSHeapSize) samples. Collections make the raw
 * series a sawtooth, so the allocation rate is the sum of the rises, not the slope.
 */
export function heapStats(timesMs: ArrayLike<number>, bytes: ArrayLike<number>, n: number, gcDropBytes = 256 * 1024): HeapStats {
  if (n < 2) return { netBytesPerSec: 0, allocBytesPerSec: 0, gcCount: 0 };
  const seconds = (timesMs[n - 1]! - timesMs[0]!) / 1000;
  if (!(seconds > 0)) return { netBytesPerSec: 0, allocBytesPerSec: 0, gcCount: 0 };
  let rise = 0;
  let gcs = 0;
  for (let i = 1; i < n; i++) {
    const d = bytes[i]! - bytes[i - 1]!;
    if (d > 0) rise += d;
    else if (-d >= gcDropBytes) gcs++;
  }
  return {
    netBytesPerSec: Math.round((bytes[n - 1]! - bytes[0]!) / seconds),
    allocBytesPerSec: Math.round(rise / seconds),
    gcCount: gcs,
  };
}

export function round(v: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
