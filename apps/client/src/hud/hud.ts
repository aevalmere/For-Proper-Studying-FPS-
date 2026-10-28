// Plain-DOM HUD: crosshair, speedometer, FPS, debug line, and the click-to-play
// overlay.
//
// Per-frame DOM work is kept tiny because every text change makes the browser
// re-lay-out and re-raster part of the page, and the bench trace showed the main
// thread waiting on that raster: text goes into Text nodes and is written only when
// it changes, readouts refresh at most READOUT_HZ, the crosshair gap moves with
// compositor-only transforms, and nothing here reads layout per frame (the viewport
// size is cached on resize).

import { DEG2RAD } from '@splat/shared';
import type { ClientSettings } from '../settings.ts';

export interface HudFrame {
  /** horizontal speed, u/s */
  speed: number;
  verticalSpeed: number;
  maxSpeed: number;
  /** speed at the last takeoff / landing (0 = none yet) */
  takeoffSpeed: number;
  landSpeed: number;
  /** cone half-angle of the next shot, degrees (ctx.aimSpreadDeg) */
  spreadDeg: number;
  /** camera vertical FOV, degrees */
  fovDeg: number;
  /** frame time, s */
  dt: number;
  /** performance.now() of this frame */
  now: number;
}

/** Numeric readouts refresh at most this often: plenty to read, half the re-raster at 60 fps. */
export const READOUT_HZ = 30;
/** Dynamic crosshair easing, 1/s: opens fast so moving reads at once, closes smoothly. */
const GAP_OPEN_RATE = 28;
const GAP_CLOSE_RATE = 12;
/** largest dynamic gap, as a fraction of the viewport height */
const GAP_MAX_FRACTION = 0.2;

/** Pixels from the screen center to a direction `deg` off-axis, for a vertical FOV and viewport height. */
export function angleToPixels(deg: number, fovDeg: number, viewportHeight: number): number {
  const focal = viewportHeight / 2 / Math.tan((fovDeg * DEG2RAD) / 2);
  return Math.tan(Math.min(89, Math.max(0, deg)) * DEG2RAD) * focal;
}

/**
 * One easing step of the dynamic crosshair gap toward `target` px. Returns the new
 * eased value; the caller writes whole pixels only when it has moved far enough.
 */
export function easeGap(shown: number, target: number, dt: number): number {
  const rate = target > shown ? GAP_OPEN_RATE : GAP_CLOSE_RATE;
  return shown + (target - shown) * (1 - Math.exp(-rate * Math.max(0, dt)));
}

export interface OverlayHandlers {
  play(): void;
  fullscreen(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  parent?.appendChild(e);
  return e;
}

/** An element holding one Text node; writing `.data` is cheaper than textContent. */
function textEl(className: string, parent: HTMLElement): Text {
  const t = document.createTextNode('');
  el('div', className, parent).appendChild(t);
  return t;
}

const CONTROLS: [string, string][] = [
  ['W A S D', 'move'],
  ['Mouse', 'aim'],
  ['Space / wheel', 'jump (wheel is a setting)'],
  ['C', 'crouch (also Ctrl in fullscreen)'],
  ['Shift', 'walk'],
  ['Mouse 1', 'paint'],
  ['1 2 3', 'weapon'],
  ['R', 'respawn at the chosen teleport'],
  ['F1 or `', 'dev panel'],
  ['Esc', 'release the mouse'],
];

export class Hud {
  /** HUD root (ctx.hud): systems may append their own elements */
  readonly root: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly arms: HTMLElement[];
  private readonly dot: HTMLElement;
  private readonly speedBox: HTMLElement;
  private readonly speed: Text;
  private readonly vspeed: Text;
  private readonly jumps: Text;
  private readonly fps: Text;
  private readonly debug: Text;
  private readonly overlay: HTMLElement;
  private readonly message: HTMLElement;
  private fast = false;
  private readoutAt = -Infinity;
  private viewW = 1;
  private viewH = 1;
  /** dynamic crosshair: eased gap (px) and the whole-pixel value last written */
  private gapShown = 0;
  private gapPx = 0;
  private dynamic = true;

  private frames = 0;
  private windowStart = 0;
  private worstMs = 0;

  constructor(parent: HTMLElement, handlers: OverlayHandlers) {
    this.root = el('div', 'hud', parent);
    this.root.id = 'hud';

    this.crosshair = el('div', 'crosshair', this.root);
    this.arms = [0, 1, 2, 3].map(() => el('div', 'arm', this.crosshair));
    this.dot = el('div', 'arm dot', this.crosshair);

    const speedo = el('div', 'speedo', this.root);
    this.speed = textEl('speed', speedo);
    this.speedBox = this.speed.parentElement!;
    this.vspeed = textEl('vspeed', speedo);
    this.jumps = textEl('jumps', speedo);

    const corner = el('div', 'corner', this.root);
    this.fps = textEl('fps', corner);
    this.debug = textEl('debug', corner);

    this.overlay = el('div', 'overlay', parent);
    this.overlay.id = 'overlay';
    const card = el('div', 'card', this.overlay);
    el('h1', 'title', card).textContent = 'Splatcademy';
    el('p', 'subtitle', card).textContent = 'Movement and paint sandbox';
    const play = el('button', 'play', card);
    play.type = 'button';
    play.textContent = 'Click to play';
    const fs = el('button', 'secondary', card);
    fs.type = 'button';
    fs.textContent = 'Fullscreen (Ctrl crouches)';
    const list = el('dl', 'controls', card);
    for (const [k, v] of CONTROLS) {
      el('dt', '', list).textContent = k;
      el('dd', '', list).textContent = v;
    }
    this.message = el('p', 'message', card);

    fs.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.fullscreen();
    });
    // anywhere else on the overlay starts play
    this.overlay.addEventListener('click', () => handlers.play());
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());

    this.layoutCrosshair = this.layoutCrosshair.bind(this);
    window.addEventListener('resize', this.layoutCrosshair);
  }

  showOverlay(show: boolean): void {
    this.overlay.classList.toggle('hidden', !show);
    this.root.classList.toggle('paused', show);
  }

  setMessage(text: string): void {
    this.message.textContent = text;
  }

  applySettings(s: ClientSettings): void {
    this.fps.parentElement!.classList.toggle('hidden', !s.showFps);
    this.debug.parentElement!.classList.toggle('hidden', !s.showDebug);
    this.dynamic = s.dynamicCrosshair;
    if (!this.dynamic) {
      this.gapShown = 0;
      this.setGap(0);
    }
    this.applyCrosshair(s);
  }

  private crosshairSettings: ClientSettings | null = null;

  private applyCrosshair(s: ClientSettings): void {
    this.crosshairSettings = s;
    const len = Math.round(s.crosshairSize);
    const gap = Math.round(s.crosshairGap);
    const t = Math.max(1, Math.round(s.crosshairThickness));
    // integer offsets around the center pixel keep the lines crisp
    const lo = -Math.floor(t / 2);
    const rects: [number, number, number, number][] = [
      [lo, -gap - len, t, len], // top
      [lo, gap + (t % 2), t, len], // bottom
      [-gap - len, lo, len, t], // left
      [gap + (t % 2), lo, len, t], // right
    ];
    this.arms.forEach((a, i) => {
      const [x, y, w, h] = rects[i]!;
      a.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;display:${len > 0 ? 'block' : 'none'}`;
    });
    this.dot.style.cssText = `left:${lo}px;top:${lo}px;width:${t}px;height:${t}px;display:${s.crosshairDot ? 'block' : 'none'}`;
    // cssText dropped the arms' dynamic-gap transforms: put them back
    const px = this.gapPx;
    this.gapPx = 0;
    this.setGap(px);
    this.crosshair.style.setProperty('--ch-color', s.crosshairColor);
    this.crosshair.classList.toggle('outlined', s.crosshairOutline);
    this.layoutCrosshair();
  }

  private layoutCrosshair(): void {
    // resize only: the size is cached so update() never reads layout
    this.viewW = this.root.clientWidth || window.innerWidth;
    this.viewH = this.root.clientHeight || window.innerHeight;
    this.crosshair.style.transform = `translate(${Math.floor(this.viewW / 2)}px, ${Math.floor(this.viewH / 2)}px)`;
  }

  private set(t: Text, text: string): void {
    if (t.data !== text) t.data = text;
  }

  /** Push the four arms out by `px` beyond the static gap (transform only: no layout). */
  private setGap(px: number): void {
    if (px === this.gapPx) return;
    this.gapPx = px;
    const [top, bottom, left, right] = this.arms as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    top.style.transform = px ? `translate(0,${-px}px)` : '';
    bottom.style.transform = px ? `translate(0,${px}px)` : '';
    left.style.transform = px ? `translate(${-px}px,0)` : '';
    right.style.transform = px ? `translate(${px}px,0)` : '';
  }

  update(f: HudFrame): void {
    if (this.dynamic) {
      const target = Math.min(angleToPixels(f.spreadDeg, f.fovDeg, this.viewH), this.viewH * GAP_MAX_FRACTION);
      this.gapShown = easeGap(this.gapShown, target, f.dt);
      // whole pixels keep the arms crisp; moving only past 0.75 px stops 1 px flicker
      if (Math.abs(this.gapShown - this.gapPx) > 0.75 || (this.gapShown < 0.5 && this.gapPx !== 0)) {
        this.setGap(Math.round(this.gapShown));
      }
    }

    if (f.now - this.readoutAt < 1000 / READOUT_HZ - 1) return;
    this.readoutAt = f.now;
    this.set(this.speed, String(Math.round(f.speed)));
    const fast = f.speed > f.maxSpeed + 0.5;
    if (fast !== this.fast) {
      this.fast = fast;
      this.speedBox.classList.toggle('fast', fast);
    }
    const vs = Math.round(f.verticalSpeed);
    this.set(this.vspeed, vs === 0 ? 'vert 0' : `vert ${vs > 0 ? '+' : ''}${vs}`);
    this.set(this.jumps, f.takeoffSpeed > 0 ? `takeoff ${Math.round(f.takeoffSpeed)}  land ${Math.round(f.landSpeed)}` : '');
  }

  /** Call once per frame with the frame time; refreshes the FPS readout twice a second. */
  countFrame(now: number, frameMs: number): void {
    this.frames++;
    if (frameMs > this.worstMs) this.worstMs = frameMs;
    if (!this.windowStart) this.windowStart = now;
    const elapsed = now - this.windowStart;
    if (elapsed >= 500) {
      const fps = (this.frames * 1000) / elapsed;
      this.set(this.fps, `${Math.round(fps)} fps  ${(elapsed / this.frames).toFixed(1)} ms  (worst ${this.worstMs.toFixed(1)})`);
      this.frames = 0;
      this.windowStart = now;
      this.worstMs = 0;
    }
  }

  setDebug(text: string): void {
    this.set(this.debug, text);
  }

  dispose(): void {
    window.removeEventListener('resize', this.layoutCrosshair);
    this.root.remove();
    this.overlay.remove();
  }
}
