// Adaptive resolution: drop the render scale while frames keep missing their
// budget, and give it back when it's safe.
//
// Down: after `overWindows` windows in a row with at least `overShare` missed
// frames, step down. Lowering resolution only helps when the GPU's fill rate is the
// bottleneck; on a CPU-bound machine it would just blur the picture. So each step
// down is a trial: if the mean frame time hasn't dropped by `minGain` after
// `trialWindows`, the step is reverted and no step down is tried for `holdWindows`.
// (The miss share can't judge it: when every frame misses, a step that makes frames
// 20% faster still shows 100% misses.)
//
// Up: frame times can't show headroom with vsync on (frames are 16.7 ms however
// light they are), so going back up is a probe: after `probeWindows` clean windows,
// try half a step; if misses come back within `trialWindows`, undo it and wait twice
// as long before the next probe.
//
// No DOM: the loop feeds frame times in and applies the scale it returns.

export interface AdaptiveScaleConfig {
  /** a frame slower than this is a miss, ms (60 fps with slack for jitter) */
  budgetMs: number;
  /** evaluation window, ms of frame time */
  windowMs: number;
  /** miss share at or above which a window counts as over budget */
  overShare: number;
  /** consecutive over-budget windows before stepping down */
  overWindows: number;
  /** miss share at or below which a window counts as clean */
  cleanShare: number;
  /** consecutive clean windows before probing a step up */
  probeWindows: number;
  /** scale change per step down; probes up are half this */
  step: number;
  /** lowest scale it will choose */
  min: number;
  /** windows after a change before judging it */
  trialWindows: number;
  /** a step down is kept only if mean frame time fell by at least this fraction */
  minGain: number;
  /** windows to wait after a failed step down before trying again */
  holdWindows: number;
}

export const ADAPTIVE_DEFAULTS: AdaptiveScaleConfig = {
  budgetMs: 20,
  windowMs: 1000,
  overShare: 0.1,
  overWindows: 3,
  cleanShare: 0.01,
  probeWindows: 20,
  step: 0.1,
  min: 0.5,
  trialWindows: 2,
  // 6% let run-to-run noise "pass" on CPU-bound machines and dropped the scale for
  // nothing; a real fill-rate win from one 0.1 step is well above 10%
  minGain: 0.1,
  holdWindows: 60,
};

type Trial = 'none' | 'down' | 'up';

export class AdaptiveScale {
  /** scale to render at now (≤ the ceiling) */
  scale: number;
  /** total scale changes, for the perf overlay and bench */
  changes = 0;
  private max: number;
  // current window
  private frames = 0;
  private misses = 0;
  private elapsed = 0;
  // window history
  private over = 0;
  private clean = 0;
  private hold = 0;
  private probeAfter: number;
  private readonly recentMean: number[] = [];
  // running trial
  private trial: Trial = 'none';
  private trialLeft = 0;
  private trialBefore = 0;
  private trialSum = 0;
  private trialMissed = false;

  constructor(
    max: number,
    private readonly cfg: AdaptiveScaleConfig = ADAPTIVE_DEFAULTS,
  ) {
    this.max = max;
    this.scale = max;
    this.probeAfter = cfg.probeWindows;
  }

  /** The user's render scale changed: it's the new ceiling, and the controller starts over at it. */
  reset(max: number): void {
    this.max = max;
    this.scale = max;
    this.frames = this.misses = this.elapsed = 0;
    this.over = this.clean = this.hold = 0;
    this.probeAfter = this.cfg.probeWindows;
    this.recentMean.length = 0;
    this.trial = 'none';
  }

  /** Feed one frame time; returns true when `scale` changed. */
  frame(frameMs: number): boolean {
    if (!(frameMs > 0)) return false;
    // a frame longer than a whole window is a stall (tab switch, breakpoint), not load
    if (frameMs > this.cfg.windowMs) return false;
    this.frames++;
    if (frameMs > this.cfg.budgetMs) this.misses++;
    this.elapsed += frameMs;
    if (this.elapsed < this.cfg.windowMs) return false;
    const share = this.misses / this.frames;
    const meanMs = this.elapsed / this.frames;
    this.frames = this.misses = this.elapsed = 0;
    return this.window(share, meanMs);
  }

  private window(share: number, meanMs: number): boolean {
    const c = this.cfg;
    this.recentMean.push(meanMs);
    if (this.recentMean.length > c.overWindows) this.recentMean.shift();
    if (this.hold > 0) this.hold--;

    if (this.trial !== 'none') {
      this.trialSum += meanMs;
      if (share >= c.overShare) this.trialMissed = true;
      if (--this.trialLeft > 0) return false;
      const kind = this.trial;
      this.trial = 'none';
      this.over = this.clean = 0;
      if (kind === 'down' && this.trialSum / c.trialWindows > this.trialBefore * (1 - c.minGain)) {
        // didn't help: the bottleneck isn't fill rate
        this.hold = c.holdWindows;
        return this.set(this.scale + c.step);
      }
      if (kind === 'up') {
        if (this.trialMissed) {
          this.probeAfter *= 2;
          return this.set(this.scale - c.step / 2);
        }
        this.probeAfter = c.probeWindows;
      }
      return false;
    }

    if (share >= c.overShare) {
      this.clean = 0;
      if (++this.over >= c.overWindows && this.hold === 0 && this.scale > c.min + 1e-6) {
        this.startTrial('down', this.recentMean.reduce((a, b) => a + b, 0) / this.recentMean.length);
        return this.set(this.scale - c.step);
      }
      return false;
    }
    this.over = 0;
    if (share <= c.cleanShare) {
      if (++this.clean >= this.probeAfter && this.scale < this.max - 1e-6) {
        this.startTrial('up', meanMs);
        return this.set(this.scale + c.step / 2);
      }
      return false;
    }
    this.clean = 0;
    return false;
  }

  private startTrial(kind: Trial, before: number): void {
    this.trial = kind;
    this.trialLeft = this.cfg.trialWindows;
    this.trialBefore = before;
    this.trialSum = 0;
    this.trialMissed = false;
    this.over = this.clean = 0;
  }

  private set(next: number): boolean {
    const v = Math.round(Math.min(this.max, Math.max(this.cfg.min, next)) * 100) / 100;
    if (v === this.scale) return false;
    this.scale = v;
    this.changes++;
    return true;
  }
}
