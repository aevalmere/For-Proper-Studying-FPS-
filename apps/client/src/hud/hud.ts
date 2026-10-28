// Plain-DOM HUD: crosshair, speedometer, FPS, debug line, and the click-to-play
// overlay. Text is only written when it changes, to keep per-frame DOM work tiny.

import type { ClientSettings } from '../settings.ts';

export interface HudFrame {
  /** horizontal speed, u/s */
  speed: number;
  verticalSpeed: number;
  maxSpeed: number;
  /** speed at the last takeoff / landing (0 = none yet) */
  takeoffSpeed: number;
  landSpeed: number;
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
  private readonly speed: HTMLElement;
  private readonly vspeed: HTMLElement;
  private readonly jumps: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly debug: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly message: HTMLElement;
  private readonly cache = new Map<HTMLElement, string>();
  private fast = false;

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
    this.speed = el('div', 'speed', speedo);
    this.vspeed = el('div', 'vspeed', speedo);
    this.jumps = el('div', 'jumps', speedo);

    const corner = el('div', 'corner', this.root);
    this.fps = el('div', 'fps', corner);
    this.debug = el('div', 'debug', corner);

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
    this.fps.classList.toggle('hidden', !s.showFps);
    this.debug.classList.toggle('hidden', !s.showDebug);
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
    this.crosshair.style.setProperty('--ch-color', s.crosshairColor);
    this.crosshair.classList.toggle('outlined', s.crosshairOutline);
    this.layoutCrosshair();
  }

  private layoutCrosshair(): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    this.crosshair.style.transform = `translate(${Math.floor(w / 2)}px, ${Math.floor(h / 2)}px)`;
  }

  private set(e: HTMLElement, text: string): void {
    if (this.cache.get(e) === text) return;
    this.cache.set(e, text);
    e.textContent = text;
  }

  update(f: HudFrame): void {
    this.set(this.speed, String(Math.round(f.speed)));
    const fast = f.speed > f.maxSpeed + 0.5;
    if (fast !== this.fast) {
      this.fast = fast;
      this.speed.classList.toggle('fast', fast);
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
