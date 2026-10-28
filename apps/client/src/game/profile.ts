// Per-frame timing split for the perf overlay and the ?bench run. The loop fills
// one of these every frame (performance.now() around each phase; a few hundred
// nanoseconds in total), and consumers read it at the end of the frame.

export interface FrameProfile {
  /** rAF timestamp delta, ms (0 on the first frame) */
  frameMs: number;
  /** sim ticks run this frame */
  ticks: number;
  /** input sampling + stepPlayer, summed over this frame's ticks, ms */
  simMs: number;
  /** systems' fixedUpdate, summed over this frame's ticks, ms */
  fixedMs: number;
  /** systems' render(), ms */
  systemsMs: number;
  /** core HUD and overlay updates, ms */
  hudMs: number;
  /** renderer.render() (JS side: culling, sorting, WebGL calls), ms */
  drawMs: number;
  /** the whole rAF callback, ms */
  cpuMs: number;
  /** renderer.info for this frame's draw */
  calls: number;
  triangles: number;
}

export function createFrameProfile(): FrameProfile {
  return { frameMs: 0, ticks: 0, simMs: 0, fixedMs: 0, systemsMs: 0, hudMs: 0, drawMs: 0, cpuMs: 0, calls: 0, triangles: 0 };
}

export function resetFrameProfile(p: FrameProfile): void {
  p.frameMs = 0;
  p.ticks = 0;
  p.simMs = 0;
  p.fixedMs = 0;
  p.systemsMs = 0;
  p.hudMs = 0;
  p.drawMs = 0;
  p.cpuMs = 0;
  p.calls = 0;
  p.triangles = 0;
}
