// ?bench=1[&seconds=24][&quality=low|high]: runs the scripted route in
// scenario.ts with no human input, records every frame, and prints a JSON summary
// to the console and an on-screen box. The result is also left on
// `window.__splatBench` for the headless runner (apps/client/bench/run.mjs).

import { TICK_DT, TICK_RATE, type UserCmd } from '@splat/shared';
import type { FrameProfile } from '../game/profile.ts';
import type { GameContext, ViewAngles } from '../game/types.ts';
import { SEGMENTS, schedule, segmentAt, type ScheduledSegment } from './scenario.ts';
import { dist, heapStats, mean, max, round, shareAbove } from './stats.ts';

/** Hooks the game loop calls when a driver is installed (bench, later replays). */
export interface LoopDriver {
  /** Overwrite the sampled cmd for the tick about to run (may teleport the player). */
  beforeTick(cmd: UserCmd): void;
  /** Set the view used to place the camera this frame (after the ticks ran). */
  frame(alpha: number): void;
  /** End of frame, with the frame's profile filled in. */
  endFrame(p: FrameProfile, now: number): void;
}

export interface BenchHost {
  ctx: GameContext;
  teleport(index: number): void;
  /** extra context for the result: render scale, pixel ratio, etc. */
  describe(): Record<string, unknown>;
}

export interface BenchResult {
  [key: string]: unknown;
}

declare global {
  interface Window {
    __splatBench?: BenchResult;
  }
}

const CAPACITY = 60000;
const HEAP_SAMPLE_MS = 50;
const HEAP_CAPACITY = 4096;
const LONG_FRAME_MS = 50;

interface PerfMemory {
  usedJSHeapSize: number;
}

function gpuString(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

export function createBench(host: BenchHost, params: URLSearchParams): LoopDriver {
  const { ctx } = host;
  const secondsParam = Number(params.get('seconds'));
  const plan = schedule(SEGMENTS, Number.isFinite(secondsParam) && secondsParam > 0 ? secondsParam : 0, TICK_RATE);
  const endTick = plan.length ? plan[plan.length - 1]!.startTick + plan[plan.length - 1]!.ticks : 0;

  const frameMs = new Float32Array(CAPACITY);
  const cpuMs = new Float32Array(CAPACITY);
  const simMs = new Float32Array(CAPACITY);
  const fixedMs = new Float32Array(CAPACITY);
  const systemsMs = new Float32Array(CAPACITY);
  const hudMs = new Float32Array(CAPACITY);
  const drawMs = new Float32Array(CAPACITY);
  const calls = new Float32Array(CAPACITY);
  const tris = new Float32Array(CAPACITY);
  const segOf = new Uint8Array(CAPACITY);
  const heapT = new Float64Array(HEAP_CAPACITY);
  const heapB = new Float64Array(HEAP_CAPACITY);
  let n = 0;
  let heapN = 0;
  let heapAt = 0;
  let startNow = 0;
  let endNow = 0;
  let startTick = -1;
  let current: ScheduledSegment | null = null;
  let done = false;
  const view: ViewAngles = { yaw: 0, pitch: 0 };
  // Chromium's performance.memory is a snapshot taken on each access: read it fresh every time
  const readHeap = (): number | null => (performance as Performance & { memory?: PerfMemory }).memory?.usedJSHeapSize ?? null;
  const hasHeap = readHeap() !== null;
  /** frames over LONG_FRAME_MS, with the shader program count to spot compile hitches */
  const longFrames: { segment: string; t: number; frameMs: number; drawMs: number; jsMs: number; programs: number }[] = [];
  let programsSeen = 0;

  let baseYaw = ctx.view.yaw;
  const viewAt = (tick: number, out: ViewAngles): void => {
    const s = segmentAt(plan, Math.max(0, Math.floor(tick)));
    // a frame interpolating back into the previous segment keeps the new segment's start view
    if (!s || s !== current) return;
    s.seg.view((tick - s.startTick) * TICK_DT, baseYaw, out);
  };

  ctx.inputActive = true;

  const finish = (): void => {
    done = true;
    const seconds = (endNow - startNow) / 1000;
    const heap = hasHeap ? heapStats(heapT, heapB, heapN) : null;
    const gl = ctx.renderer.getContext();
    const gpu = gpuString(gl);
    const segments = plan
      .filter((s) => !s.seg.warmup)
      .map((s) => {
        const idx: number[] = [];
        for (let i = 0; i < n; i++) if (segOf[i] === s.index) idx.push(i);
        const ft = Float32Array.from(idx, (i) => frameMs[i]!);
        const c = Float32Array.from(idx, (i) => calls[i]!);
        const d = dist(ft, ft.length);
        return { name: s.seg.name, frames: ft.length, p50: d.p50, p95: d.p95, max: d.max, drawCalls: round(mean(c, c.length), 1) };
      });
    const result: BenchResult = {
      bench: 'splatcademy',
      version: 1,
      ...host.describe(),
      gpu,
      softwareGL: /swiftshader|llvmpipe|software/i.test(gpu),
      cores: navigator.hardwareConcurrency,
      wallSeconds: round(seconds),
      simSeconds: round((endTick - startTick) * TICK_DT),
      frames: n,
      fps: round(n / Math.max(1e-6, seconds), 1),
      frameMs: dist(frameMs, n),
      over16_7: round(shareAbove(frameMs, n, 1000 / 60), 4),
      over33_3: round(shareAbove(frameMs, n, 1000 / 30), 4),
      jsMs: {
        frame: dist(cpuMs, n),
        sim: dist(simMs, n),
        systemsFixed: dist(fixedMs, n),
        systemsRender: dist(systemsMs, n),
        hud: dist(hudMs, n),
        render: dist(drawMs, n),
      },
      heap: heap
        ? {
            netKBps: round(heap.netBytesPerSec / 1024, 1),
            allocKBps: round(heap.allocBytesPerSec / 1024, 1),
            gcCount: heap.gcCount,
            samples: heapN,
          }
        : 'performance.memory unavailable',
      drawCalls: { mean: round(mean(calls, n), 1), max: max(calls, n) },
      triangles: { mean: Math.round(mean(tris, n)), max: max(tris, n) },
      programs: ctx.renderer.info.programs?.length ?? 0,
      longFrames: longFrames.sort((a, b) => b.frameMs - a.frameMs).slice(0, 12),
      segments,
    };
    window.__splatBench = result;
    const json = JSON.stringify(result, null, 2);
    console.log(`[bench] result\n${json}`);
    const box = document.createElement('pre');
    box.id = 'bench-result';
    box.textContent = json;
    box.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:2000;max-height:calc(100vh - 16px);overflow:auto;margin:0;padding:10px 12px;' +
      'background:rgba(10,12,16,0.88);color:#e9edf2;font:11px/1.35 ui-monospace,Consolas,monospace;border-radius:6px;pointer-events:auto;user-select:text';
    document.body.appendChild(box);
    ctx.inputActive = false;
  };

  return {
    beforeTick(cmd) {
      if (done) return;
      if (startTick < 0) startTick = ctx.tick;
      const local = ctx.tick - startTick;
      if (local >= endTick) {
        finish();
        cmd.forward = cmd.side = cmd.buttons = 0;
        return;
      }
      const s = segmentAt(plan, local)!;
      if (s !== current) {
        current = s;
        host.teleport(s.seg.teleport);
        baseYaw = ctx.view.yaw;
      }
      const t = (local - s.startTick) * TICK_DT;
      s.seg.cmd(t, cmd);
      s.seg.view(t, baseYaw, view);
      cmd.yaw = ctx.view.yaw = view.yaw;
      cmd.pitch = ctx.view.pitch = view.pitch;
    },

    frame(alpha) {
      if (done || startTick < 0) return;
      // the camera shows the state between the previous and the current tick
      viewAt(ctx.tick - startTick - 1 + alpha, view);
      ctx.view.yaw = view.yaw;
      ctx.view.pitch = view.pitch;
    },

    endFrame(p, now) {
      if (done || !current || current.seg.warmup) return;
      if (!startNow) startNow = now;
      endNow = now;
      if (n < CAPACITY && p.frameMs > 0) {
        frameMs[n] = p.frameMs;
        cpuMs[n] = p.cpuMs;
        simMs[n] = p.simMs;
        fixedMs[n] = p.fixedMs;
        systemsMs[n] = p.systemsMs;
        hudMs[n] = p.hudMs;
        drawMs[n] = p.drawMs;
        calls[n] = p.calls;
        tris[n] = p.triangles;
        segOf[n] = current.index;
        n++;
      }
      const programs = ctx.renderer.info.programs?.length ?? 0;
      if (p.frameMs > LONG_FRAME_MS && longFrames.length < 200) {
        longFrames.push({
          segment: current.seg.name,
          t: round((ctx.tick - startTick - current.startTick) * TICK_DT),
          frameMs: round(p.frameMs, 1),
          drawMs: round(p.drawMs, 1),
          jsMs: round(p.cpuMs, 1),
          programs: programs - programsSeen,
        });
      }
      programsSeen = programs;
      if (hasHeap && heapN < HEAP_CAPACITY && now - heapAt >= HEAP_SAMPLE_MS) {
        heapAt = now;
        heapT[heapN] = now;
        heapB[heapN] = readHeap()!;
        heapN++;
      }
    },
  };
}
