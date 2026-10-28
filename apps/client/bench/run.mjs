#!/usr/bin/env node
// Headless benchmark runner for the client's ?bench mode.
//
//   pnpm --filter @splat/client build
//   node apps/client/bench/run.mjs --throttle 1,4,6
//
// Serves a built client (default apps/client/dist) on a local port, opens it in
// headless Chromium at 1366x768, DPR 1 (a typical Chromebook screen), applies CDP
// CPU throttling as a Chromebook proxy, waits for window.__splatBench, and prints
// a summary table plus the raw JSON.
//
// Options:
//   --dist <dir>         built client to serve (default apps/client/dist)
//   --url <url>          bench an already running server instead (e.g. http://localhost:5173/)
//   --throttle 1,4,6     CPU throttle rates, one run each (default 4,6)
//   --seconds 24         recorded seconds of the route (default: the route's nominal length)
//   --quality low|high   client quality preset (default low)
//   --params a=1&b=2     extra URL params for the client
//   --gl gpu|swiftshader WebGL backend (default gpu: ANGLE on the real GPU; falls back if unavailable)
//   --vsync              keep the 60 Hz frame cap (default: uncapped, so frame time = real cost)
//   --repeat N           runs per throttle rate; the median-p95 run is reported (default 1)
//   --out <file>         also write all results as JSON
//   --profile <prefix>   record a CPU profile (<prefix>-<rate>x.cpuprofile) and a sampled
//                        allocation profile, and print the top functions of each. Build
//                        with `vite build --minify false` first to get readable names.
//   --trace <prefix>     record a timeline trace (<prefix>-<rate>x.json, loadable in DevTools)
//                        and print where the renderer main thread spent its time
//
// Needs a Playwright-compatible module: `playwright`, `playwright-core` or
// `patchright`, resolved from the working directory, PLAYWRIGHT_MODULE (a path to
// the package), or a CodeGPT VS Code extension install. Nothing is added to the
// repo's dependencies.

import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const distDir = resolve(opt('dist', join(here, '..', 'dist')));
const externalUrl = opt('url', null);
const throttles = String(opt('throttle', '4,6'))
  .split(',')
  .map(Number)
  .filter((x) => x >= 1);
const seconds = opt('seconds', '');
const quality = opt('quality', 'low');
const extra = opt('params', '');
const gl = opt('gl', 'gpu');
const vsync = has('vsync');
const repeat = Math.max(1, Number(opt('repeat', '1')) || 1);
const outFile = opt('out', null);
const profile = opt('profile', null);
const trace = opt('trace', null);

function resolvePlaywright() {
  const tries = [];
  const bases = [process.cwd() + '/', here + '/'];
  if (process.env.PLAYWRIGHT_MODULE) bases.unshift(process.env.PLAYWRIGHT_MODULE);
  for (const root of [join(homedir(), '.vscode/extensions'), join(homedir(), '.vscode-server/extensions')]) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith('danielsanmedium.dscodegpt-'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (dirs.length) bases.push(join(root, dirs[dirs.length - 1], 'standalone') + '/');
  }
  for (const base of bases) {
    for (const name of ['playwright', 'playwright-core', 'patchright']) {
      tries.push(`${name} from ${base}`);
      try {
        const req = createRequire(base.endsWith('/') ? base : base + '/');
        const mod = base === process.env.PLAYWRIGHT_MODULE ? req(base) : req(name);
        const chromium = mod?.chromium ?? mod?.default?.chromium;
        if (chromium) return chromium;
      } catch {
        // try the next one
      }
    }
  }
  throw new Error(`No Playwright-compatible module found. Tried:\n  ${tries.join('\n  ')}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

function serve(dir) {
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`${dir} has no index.html: run \`pnpm --filter @splat/client build\` first`);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(normalize(dir))) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function launchArgs() {
  const a = ['--enable-precise-memory-info', '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required'];
  if (!vsync) a.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
  if (gl === 'swiftshader') a.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  else a.push('--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader');
  return a;
}

async function runOnce(chromium, baseUrl, rate) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: launchArgs() });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 300));
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const q = new URLSearchParams(extra);
    q.set('bench', '1');
    q.set('quality', quality);
    if (seconds) q.set('seconds', seconds);
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${q.toString()}`;
    await cdp.send('Performance.enable');
    if (profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.startSampling', {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const traceEvents = [];
    if (trace) {
      cdp.on('Tracing.dataCollected', (e) => traceEvents.push(...e.value));
      await cdp.send('Tracing.start', {
        traceConfig: {
          includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'v8.gc', 'blink.gc', 'gpu', 'cc', 'viz'],
          recordMode: 'recordContinuously',
        },
      });
    }
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    const budget = (Number(seconds) || 30) * 1000 * Math.max(2, rate) + 60000;

    // CDP heap poll: a cross-check for performance.memory (covers warmup too)
    const heap = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        try {
          const h = await cdp.send('Runtime.getHeapUsage');
          heap.push([Date.now(), h.usedSize]);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    // read the on-screen box rather than window.__splatBench: patchright evaluates in
    // an isolated world that can't see page globals, but the DOM is shared
    // (polled from here, not with waitForSelector, which would poll inside the page every frame)
    const deadline = Date.now() + budget;
    let box = null;
    while (!box && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      box = await page.$('#bench-result');
    }
    polling = false;
    await poll;
    if (!box) throw new Error(`bench did not finish within ${budget} ms`);
    const result = JSON.parse(await box.textContent());
    if (trace) {
      const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
      await cdp.send('Tracing.end');
      await done;
      writeFileSync(`${trace}-${rate}x.json`, JSON.stringify({ traceEvents }));
      console.log(`
Renderer main thread, ${rate}x (by total duration):
${summarizeTrace(traceEvents, 30)}`);
    }
    if (profile) {
      const { profile: cpu } = await cdp.send('Profiler.stop');
      const { profile: alloc } = await cdp.send('HeapProfiler.stopSampling');
      writeFileSync(`${profile}-${rate}x.cpuprofile`, JSON.stringify(cpu));
      console.log(`\nCPU self time, ${rate}x (top 25):\n${summarizeCpu(cpu, 25)}`);
      console.log(`\nAllocations by function, ${rate}x (top 20, sampled):\n${summarizeAlloc(alloc, 20)}`);
    }
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    let rise = 0;
    let gcs = 0;
    for (let i = 1; i < heap.length; i++) {
      const d = heap[i][1] - heap[i - 1][1];
      if (d > 0) rise += d;
      else if (d <= -256 * 1024) gcs++;
    }
    const span = heap.length > 1 ? (heap[heap.length - 1][0] - heap[0][0]) / 1000 : 0;
    const cdpStats = {
      heapAllocKBps: span ? Math.round(rise / 1024 / span) : 0,
      heapGcDrops: gcs,
      layoutCount: m.LayoutCount,
      recalcStyleCount: m.RecalcStyleCount,
      layoutMs: Math.round((m.LayoutDuration ?? 0) * 1000),
      recalcStyleMs: Math.round((m.RecalcStyleDuration ?? 0) * 1000),
      scriptMs: Math.round((m.ScriptDuration ?? 0) * 1000),
      taskMs: Math.round((m.TaskDuration ?? 0) * 1000),
    };
    return { throttle: rate, url, errors, ...result, cdp: cdpStats };
  } finally {
    await browser.close();
  }
}

const label = (cf) => {
  const file = cf.url ? cf.url.split('/').pop().split('?')[0] : '';
  return `${cf.functionName || '(anonymous)'} ${file}:${cf.lineNumber + 1}`;
};

/** Self time per function from a CDP CPU profile, as text. */
function summarizeCpu(cpu, top) {
  const dt = new Map();
  for (let i = 0; i < cpu.samples.length; i++) dt.set(cpu.samples[i], (dt.get(cpu.samples[i]) ?? 0) + (cpu.timeDeltas[i] ?? 0));
  const self = new Map();
  let total = 0;
  for (const node of cpu.nodes) {
    const us = dt.get(node.id) ?? 0;
    total += us;
    const k = label(node.callFrame);
    self.set(k, (self.get(k) ?? 0) + us);
  }
  return [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, us]) => `${(us / 1000).toFixed(0).padStart(7)} ms ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
    .join('\n');
}

/** Total/max duration per event name on the renderer main thread (top-level events only). */
function summarizeTrace(events, top) {
  const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  if (!main) return '(no renderer main thread in trace)';
  const mine = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && e.dur > 0).sort((a, b) => a.ts - b.ts);
  const by = new Map();
  let span = 0;
  if (mine.length) span = (mine[mine.length - 1].ts + mine[mine.length - 1].dur - mine[0].ts) / 1000;
  // nesting: only count an event's self time (its duration minus direct children)
  const stack = [];
  const self = new Map();
  for (const e of mine) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) self.set(parent, (self.get(parent) ?? parent.dur) - e.dur);
    stack.push(e);
    const r = by.get(e.name) ?? { total: 0, self: 0, max: 0, n: 0 };
    r.total += e.dur;
    r.max = Math.max(r.max, e.dur);
    r.n++;
    by.set(e.name, r);
  }
  for (const e of mine) by.get(e.name).self += Math.max(0, self.get(e) ?? e.dur);
  const rows = [...by].sort((a, b) => b[1].self - a[1].self).slice(0, top);
  return (
    `span ${span.toFixed(0)} ms\n` +
    rows
      .map(
        ([k, r]) =>
          `${(r.self / 1000).toFixed(0).padStart(7)} ms self ${(r.total / 1000).toFixed(0).padStart(7)} ms total  ` +
          `max ${(r.max / 1000).toFixed(1).padStart(6)}  n ${String(r.n).padStart(6)}  ${k}`,
      )
      .join('\n')
  );
}

/** Bytes allocated per function (self) from a sampling heap profile, as text. */
function summarizeAlloc(alloc, top) {
  const self = new Map();
  let total = 0;
  const walk = (node) => {
    const k = label(node.callFrame);
    self.set(k, (self.get(k) ?? 0) + node.selfSize);
    total += node.selfSize;
    for (const c of node.children ?? []) walk(c);
  };
  walk(alloc.head);
  return [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, b]) => `${(b / 1024).toFixed(0).padStart(7)} KB ${((b / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
    .join('\n');
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const f = (x) => (typeof x === 'number' ? x.toFixed(2) : String(x));

function table(results) {
  const rows = [
    ['throttle', ...results.map((r) => `${r.throttle}x`)],
    ['gpu', ...results.map((r) => (r.softwareGL ? 'SwiftShader' : 'GPU'))],
    ['fps', ...results.map((r) => f(r.fps))],
    ['frame p50 ms', ...results.map((r) => f(r.frameMs.p50))],
    ['frame p95 ms', ...results.map((r) => f(r.frameMs.p95))],
    ['frame p99 ms', ...results.map((r) => f(r.frameMs.p99))],
    ['frame max ms', ...results.map((r) => f(r.frameMs.max))],
    ['> 16.7 ms', ...results.map((r) => pct(r.over16_7))],
    ['> 33.3 ms', ...results.map((r) => pct(r.over33_3))],
    ['JS frame mean', ...results.map((r) => f(r.jsMs.frame.mean))],
    ['JS frame p95', ...results.map((r) => f(r.jsMs.frame.p95))],
    ['  sim ticks', ...results.map((r) => f(r.jsMs.sim.mean))],
    ['  systems fixed', ...results.map((r) => f(r.jsMs.systemsFixed.mean))],
    ['  systems render', ...results.map((r) => f(r.jsMs.systemsRender.mean))],
    ['  hud', ...results.map((r) => f(r.jsMs.hud.mean))],
    ['  renderer.render', ...results.map((r) => f(r.jsMs.render.mean))],
    ['heap alloc KB/s', ...results.map((r) => (typeof r.heap === 'object' ? f(r.heap.allocKBps) : 'n/a'))],
    ['heap net KB/s', ...results.map((r) => (typeof r.heap === 'object' ? f(r.heap.netKBps) : 'n/a'))],
    ['GCs', ...results.map((r) => (typeof r.heap === 'object' ? String(r.heap.gcCount) : 'n/a'))],
    ['CDP alloc KB/s', ...results.map((r) => String(r.cdp?.heapAllocKBps ?? 'n/a'))],
    ['layouts / styles', ...results.map((r) => `${r.cdp?.layoutCount} / ${r.cdp?.recalcStyleCount}`)],
    ['draw calls', ...results.map((r) => `${r.drawCalls.mean} (max ${r.drawCalls.max})`)],
    ['triangles', ...results.map((r) => `${r.triangles.mean}`)],
  ];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((x, c) => String(x).padEnd(widths[c])).join('  ')).join('\n');
}

const chromium = resolvePlaywright();
const server = externalUrl ? null : await serve(distDir);
const baseUrl = externalUrl ?? `http://127.0.0.1:${server.address().port}/`;
const all = [];
try {
  for (const rate of throttles) {
    const runs = [];
    for (let i = 0; i < repeat; i++) {
      const r = await runOnce(chromium, baseUrl, rate);
      runs.push(r);
      process.stderr.write(`throttle ${rate}x run ${i + 1}/${repeat}: p95 ${r.frameMs.p95} ms, ${r.fps} fps (${r.gpu})\n`);
      if (r.errors.length) process.stderr.write(`  page errors:\n    ${r.errors.join('\n    ')}\n`);
    }
    runs.sort((a, b) => a.frameMs.p95 - b.frameMs.p95);
    all.push({ ...runs[Math.floor(runs.length / 2)], repeats: runs.map((r) => r.frameMs.p95) });
  }
} finally {
  server?.close();
}

console.log(table(all));
console.log(`\ngpu: ${all[0]?.gpu}`);
console.log(`quality ${quality}, ${vsync ? 'vsync on' : 'uncapped frame rate'}, 1366x768 DPR 1, served from ${externalUrl ?? distDir}`);
if (outFile) {
  writeFileSync(outFile, JSON.stringify(all, null, 2));
  console.log(`wrote ${outFile}`);
}
