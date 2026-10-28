// net_graph-style perf overlay (F2): a frame-time bar graph with the JS share of
// each frame stacked inside it, plus fps/p95, the JS split, render scale, draw
// calls and heap. One small 2D canvas, redrawn at most REDRAW_HZ; nothing is drawn
// or measured while it's hidden apart from writing into a ring buffer.

import type { FrameProfile } from '../game/profile.ts';

const FRAMES = 240;
const W = 260;
const H = 118;
const GRAPH_H = 56;
/** ms at the top of the graph */
const GRAPH_MAX_MS = 50;
const REDRAW_HZ = 30;
const TEXT_HZ = 4;

export interface PerfExtras {
  renderScale: number;
  adaptive: boolean;
  /** drawing buffer size */
  bufferW: number;
  bufferH: number;
}

interface PerfMemory {
  usedJSHeapSize: number;
}

export class PerfGraph {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  private readonly frame = new Float32Array(FRAMES);
  private readonly js = new Float32Array(FRAMES);
  private cursor = 0;
  private filled = 0;
  private visible = false;
  private drawAt = 0;
  private textAt = 0;
  private lines: string[] = ['', '', '', ''];
  private readonly sorted = new Float32Array(FRAMES);
  // running sums since the last text refresh
  private sumSim = 0;
  private sumFixed = 0;
  private sumSys = 0;
  private sumDraw = 0;
  private sumJs = 0;
  private n = 0;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'perf-graph hidden';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.g = this.canvas.getContext('2d');
    this.g?.scale(dpr, dpr);
    parent.appendChild(this.canvas);
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.canvas.classList.toggle('hidden', !v);
    this.drawAt = this.textAt = 0;
  }

  /** Once per frame, after the frame's profile is complete. */
  push(p: FrameProfile, now: number, extras: PerfExtras): void {
    if (p.frameMs <= 0) return;
    this.frame[this.cursor] = p.frameMs;
    this.js[this.cursor] = p.cpuMs;
    this.cursor = (this.cursor + 1) % FRAMES;
    if (this.filled < FRAMES) this.filled++;
    if (!this.visible || !this.g) return;

    this.sumSim += p.simMs;
    this.sumFixed += p.fixedMs;
    this.sumSys += p.systemsMs;
    this.sumDraw += p.drawMs;
    this.sumJs += p.cpuMs;
    this.n++;
    if (now - this.textAt >= 1000 / TEXT_HZ) {
      this.textAt = now;
      this.refreshText(p, extras);
    }
    if (now - this.drawAt >= 1000 / REDRAW_HZ - 1) {
      this.drawAt = now;
      this.draw();
    }
  }

  private refreshText(p: FrameProfile, x: PerfExtras): void {
    const n = this.filled;
    for (let i = 0; i < n; i++) this.sorted[i] = this.frame[i]!;
    const view = this.sorted.subarray(0, n).sort();
    const p50 = view[Math.floor(n * 0.5)] ?? 0;
    const p95 = view[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
    const worst = view[n - 1] ?? 0;
    const k = this.n ? 1 / this.n : 0;
    const mem = (performance as Performance & { memory?: PerfMemory }).memory;
    this.lines = [
      `${p50 > 0 ? Math.round(1000 / p50) : 0} fps  p50 ${p50.toFixed(1)}  p95 ${p95.toFixed(1)}  max ${worst.toFixed(0)} ms`,
      `js ${(this.sumJs * k).toFixed(2)}  sim ${(this.sumSim * k).toFixed(2)}  fixed ${(this.sumFixed * k).toFixed(2)}  sys ${(this.sumSys * k).toFixed(2)}  draw ${(this.sumDraw * k).toFixed(2)}`,
      `scale ${x.renderScale.toFixed(2)}${x.adaptive ? ' auto' : ''}  ${x.bufferW}x${x.bufferH}  calls ${p.calls}  tris ${(p.triangles / 1000).toFixed(1)}k`,
      mem ? `heap ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB` : '',
    ];
    this.sumSim = this.sumFixed = this.sumSys = this.sumDraw = this.sumJs = 0;
    this.n = 0;
  }

  private draw(): void {
    const g = this.g!;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10, 12, 16, 0.72)';
    g.fillRect(0, 0, W, H);

    const top = 4;
    const y = (ms: number) => top + GRAPH_H - Math.min(ms, GRAPH_MAX_MS) * (GRAPH_H / GRAPH_MAX_MS);
    // budget lines: 60 fps and 30 fps
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(0, Math.round(y(1000 / 60)), W, 1);
    g.fillRect(0, Math.round(y(1000 / 30)), W, 1);

    const barW = W / FRAMES;
    const n = this.filled;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor - n + i + FRAMES) % FRAMES;
      const ms = this.frame[idx]!;
      const x = (FRAMES - n + i) * barW;
      g.fillStyle = ms <= 1000 / 60 + 1 ? '#3fb950' : ms <= 1000 / 30 + 1 ? '#e3b341' : '#f85149';
      const yt = y(ms);
      g.fillRect(x, yt, barW, top + GRAPH_H - yt);
      // JS part of the frame, lighter, from the bottom
      const yj = y(Math.min(ms, this.js[idx]!));
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.fillRect(x, yj, barW, top + GRAPH_H - yj);
    }

    g.font = '11px ui-monospace, Consolas, monospace';
    g.fillStyle = '#e9edf2';
    g.textBaseline = 'top';
    for (let i = 0; i < this.lines.length; i++) g.fillText(this.lines[i]!, 5, top + GRAPH_H + 5 + i * 13);
  }

  dispose(): void {
    this.canvas.remove();
  }
}
