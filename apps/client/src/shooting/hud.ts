// Shooting HUD:
// - a DOM panel (marker, ammo, spray/spread readouts), rebuilt only when a value changes
// - a hitmarker on the crosshair (its own element; the crosshair belongs to the
//   client core) with a bigger paint-colored variant when a hit splats the target
// - a "Splatted Dummy 3!" notice under the crosshair
// - a 2D canvas overlay for the spray-pattern and recent-impact debug views, only
//   sized and drawn while one of those is switched on
// Feedback elements animate through opacity/transform only, so they never trigger layout.

import * as THREE from 'three';
import { LOADOUT, type Vec3, type WeaponDef, type WeaponId } from '@splat/shared';

const STYLE_ID = 'splat-shooting-style';
const CSS = `
.splat-shoot-panel {
  position: absolute; left: 18px; bottom: 18px; min-width: 190px;
  padding: 10px 14px; border-radius: 12px;
  background: rgba(20, 16, 40, 0.55); color: #fff;
  font: 600 13px/1.35 system-ui, sans-serif; text-align: left;
  pointer-events: none; user-select: none; text-shadow: 0 1px 2px rgba(0,0,0,0.6);
}
.splat-shoot-name { font-size: 18px; font-weight: 800; letter-spacing: 0.04em; }
.splat-shoot-ammo { font-size: 28px; font-weight: 800; font-variant-numeric: tabular-nums; }
.splat-shoot-ammo small { font-size: 14px; opacity: 0.7; }
.splat-shoot-slots { margin-top: 2px; opacity: 0.85; }
.splat-shoot-slots span { display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 5px; }
.splat-shoot-slots span.on { background: rgba(255,255,255,0.22); }
.splat-shoot-debug { margin-top: 4px; font: 500 12px/1.3 ui-monospace, monospace; opacity: 0.8; }
.splat-shoot-overlay { position: fixed; pointer-events: none; }
.splat-hitmarker {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0;
  pointer-events: none; opacity: 0; --hm-color: #ffffff; --hm-gap: 7px;
}
.splat-hm-tick {
  position: absolute; left: -1.25px; top: 0; width: 2.5px; height: 8px;
  background: var(--hm-color); border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(20, 16, 40, 0.75);
  transform-origin: 50% 0;
}
.splat-hitmarker.big { --hm-gap: 9px; }
.splat-hitmarker.big .splat-hm-tick { left: -2px; width: 4px; height: 13px; }
.splat-notice {
  position: absolute; left: 50%; top: 50%; margin-top: 46px;
  transform: translateX(-50%); white-space: nowrap; pointer-events: none; opacity: 0;
  font: 800 24px/1 system-ui, sans-serif; letter-spacing: 0.02em;
  -webkit-text-stroke: 5px #1b1530; paint-order: stroke fill;
}
`;

const HIT_TIME = 0.16;
const SPLAT_MARK_TIME = 0.42;
const NOTICE_TIME = 1.4;
const TICK_ANGLES = [45, 135, 225, 315] as const;

interface Impact {
  pos: THREE.Vector3;
  color: string;
}

export interface HudState {
  def: WeaponDef;
  active: WeaponId;
  ammo: number;
  infiniteAmmo: boolean;
  /** index of the next shot */
  sprayIndex: number;
  /** cone the next shot's balls land in, deg */
  spreadDeg: number;
}

export interface OverlayState {
  showPattern: boolean;
  showImpacts: boolean;
  def: WeaponDef;
  sprayIndex: number;
  spreadDeg: number;
  /** current view punch, radians; the camera center is offset by it */
  punchPitch: number;
  punchYaw: number;
}

const tmpV = new THREE.Vector3();
const DEG = Math.PI / 180;

export class ShootingHud {
  private readonly panel: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly ammoEl: HTMLDivElement;
  private readonly slotsEl: HTMLDivElement;
  private readonly debugEl: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly target: HTMLCanvasElement;
  private readonly impacts: Impact[] = [];
  private impactCursor = 0;
  private markTimer = 0;
  private markTime = HIT_TIME;
  private markBig = false;
  private noticeTimer = 0;
  private overlayOn = false;
  // last panel inputs, so strings are only rebuilt on change
  private lastActive: WeaponId | null = null;
  private lastAmmo = -1;
  private lastInfinite: boolean | null = null;
  private lastIndex = -1;
  private lastSpread = -1;
  private lastBall = -1;
  private width = 0;
  private height = 0;

  constructor(hudRoot: HTMLElement, rendererCanvas: HTMLCanvasElement) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.target = rendererCanvas;
    this.panel = document.createElement('div');
    this.panel.className = 'splat-shoot-panel';
    this.nameEl = this.child('splat-shoot-name');
    this.ammoEl = this.child('splat-shoot-ammo');
    this.slotsEl = this.child('splat-shoot-slots');
    this.debugEl = this.child('splat-shoot-debug');
    hudRoot.appendChild(this.panel);

    this.marker = document.createElement('div');
    this.marker.className = 'splat-hitmarker';
    for (const a of TICK_ANGLES) {
      const t = document.createElement('div');
      t.className = 'splat-hm-tick';
      t.style.transform = `rotate(${a}deg) translateY(var(--hm-gap))`;
      this.marker.appendChild(t);
    }
    hudRoot.appendChild(this.marker);

    this.notice = document.createElement('div');
    this.notice.className = 'splat-notice';
    hudRoot.appendChild(this.notice);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'splat-shoot-overlay';
    this.canvas.style.display = 'none';
    this.g = this.canvas.getContext('2d')!;
    hudRoot.appendChild(this.canvas);
  }

  private child(cls: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = cls;
    this.panel.appendChild(el);
    return el;
  }

  addImpact(p: Vec3, color: string, keep: number): void {
    const cap = Math.max(1, Math.floor(keep));
    if (this.impacts.length > cap) {
      // oldest-first order, then keep the newest `cap`
      const ordered = [...this.impacts.slice(this.impactCursor), ...this.impacts.slice(0, this.impactCursor)];
      this.impacts.length = 0;
      this.impacts.push(...ordered.slice(ordered.length - cap));
      this.impactCursor = 0;
    }
    if (this.impacts.length < cap) {
      this.impacts.push({ pos: new THREE.Vector3(p.x, p.y, p.z), color });
    } else {
      const slot = this.impacts[this.impactCursor % cap]!;
      slot.pos.set(p.x, p.y, p.z);
      slot.color = color;
      this.impactCursor = (this.impactCursor + 1) % cap;
    }
  }

  clearImpacts(): void {
    this.impacts.length = 0;
    this.impactCursor = 0;
  }

  /** Our ball hit a target: white hitmarker (unless a splat marker is still showing). */
  onTargetHit(): void {
    if (this.markBig && this.markTimer > HIT_TIME) return;
    this.setMarker(false, '#ffffff');
    this.markTime = this.markTimer = HIT_TIME;
  }

  /** Our hit filled a target's meter: big paint-colored hitmarker and the notice. */
  onSplatted(color: string, targetName: string): void {
    this.setMarker(true, color);
    this.markTime = this.markTimer = SPLAT_MARK_TIME;
    this.notice.textContent = targetName ? `Splatted ${targetName}!` : 'Splatted!';
    this.notice.style.color = color;
    this.noticeTimer = NOTICE_TIME;
  }

  private setMarker(big: boolean, color: string): void {
    if (big !== this.markBig) {
      this.marker.classList.toggle('big', big);
      this.markBig = big;
    }
    this.marker.style.setProperty('--hm-color', color);
  }

  updatePanel(s: HudState, defs: Record<WeaponId, WeaponDef>): void {
    const st = s.def.stats;
    if (s.active !== this.lastActive) {
      this.nameEl.textContent = s.def.name.toUpperCase();
      this.nameEl.style.color = s.def.paintColor;
      this.slotsEl.innerHTML = LOADOUT.map((id, i) => `<span class="${id === s.active ? 'on' : ''}">${i + 1} ${defs[id].name}</span>`).join('');
    }
    if (s.active !== this.lastActive || s.ammo !== this.lastAmmo || s.infiniteAmmo !== this.lastInfinite) {
      this.ammoEl.innerHTML = `${s.infiniteAmmo ? '∞' : s.ammo}<small> / ${st.hopperSize}</small>`;
      this.lastAmmo = s.ammo;
      this.lastInfinite = s.infiniteAmmo;
    }
    const spread = Math.round(s.spreadDeg * 100);
    const ball = Math.round(st.ballRadius * 100) * 1000 + Math.round(st.hitRadiusBonus * 100);
    if (s.active !== this.lastActive || s.sprayIndex !== this.lastIndex || spread !== this.lastSpread || ball !== this.lastBall) {
      const bonus = st.hitRadiusBonus > 0 ? ` +${st.hitRadiusBonus.toFixed(2)}` : '';
      this.debugEl.textContent = `spray idx ${s.sprayIndex} · cone ${(spread / 100).toFixed(2)}° · ball r ${st.ballRadius.toFixed(2)}${bonus}`;
      this.lastIndex = s.sprayIndex;
      this.lastSpread = spread;
      this.lastBall = ball;
    }
    this.lastActive = s.active;
  }

  /** Animate the hitmarker and the notice; call once per frame. */
  updateFeedback(frameDt: number): void {
    if (this.markTimer > 0) {
      this.markTimer = Math.max(0, this.markTimer - frameDt);
      const k = this.markTimer / this.markTime; // 1 → 0
      const a = Math.min(1, k * 2.2);
      const scale = this.markBig ? 1 + 0.45 * k * k : 1 + 0.3 * k * k;
      this.marker.style.opacity = a.toFixed(3);
      this.marker.style.transform = `scale(${scale.toFixed(3)})`;
    }
    if (this.noticeTimer > 0) {
      this.noticeTimer = Math.max(0, this.noticeTimer - frameDt);
      const age = NOTICE_TIME - this.noticeTimer;
      const a = Math.min(1, this.noticeTimer / 0.35);
      const pop = age < 0.12 ? 1.25 - (age / 0.12) * 0.25 : 1;
      this.notice.style.opacity = a.toFixed(3);
      this.notice.style.transform = `translateX(-50%) scale(${pop.toFixed(3)})`;
    }
  }

  private fit(): void {
    const r = this.target.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    const st = this.canvas.style;
    st.left = `${r.left}px`;
    st.top = `${r.top}px`;
    st.width = `${r.width}px`;
    st.height = `${r.height}px`;
    if (w !== this.width || h !== this.height) {
      this.canvas.width = this.width = w;
      this.canvas.height = this.height = h;
    }
  }

  drawOverlay(s: OverlayState, camera: THREE.PerspectiveCamera): void {
    const active = s.showPattern || (s.showImpacts && this.impacts.length > 0);
    if (active !== this.overlayOn) {
      this.overlayOn = active;
      this.canvas.style.display = active ? '' : 'none';
      if (!active && this.width > 0) {
        // free the full-screen backing store while the debug views are off
        this.canvas.width = this.canvas.height = this.width = this.height = 0;
      }
    }
    if (!active) return;
    this.fit();
    const g = this.g;
    const w = this.width;
    const h = this.height;
    g.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    // pixels per unit of tan(angle) at screen center
    const focal = h / 2 / Math.tan((camera.getEffectiveFOV() * DEG) / 2);
    const scale = h / 900;

    if (s.showPattern) this.drawPattern(s, cx, cy, focal, scale);
    if (s.showImpacts) this.drawImpacts(camera, w, h, scale);
  }

  /**
   * Pattern dots are where each shot lands relative to where you aim, with no
   * compensation. The ring is where the next shot will actually go given the
   * current camera punch, sized by its spread.
   */
  private drawPattern(s: OverlayState, cx: number, cy: number, focal: number, scale: number): void {
    const g = this.g;
    const pat = s.def.pattern;
    const k = s.def.stats.patternScale * DEG;
    const px = (yaw: number) => cx - Math.tan(yaw) * focal;
    const py = (pitch: number) => cy - Math.tan(pitch) * focal;

    g.lineWidth = 1.5 * scale;
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.beginPath();
    pat.forEach((p, i) => {
      const x = px(p.yaw * k);
      const y = py(p.pitch * k);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();

    const next = Math.min(s.sprayIndex, pat.length - 1);
    pat.forEach((p, i) => {
      const x = px(p.yaw * k);
      const y = py(p.pitch * k);
      g.beginPath();
      g.arc(x, y, (i === next ? 4.5 : 3) * scale, 0, Math.PI * 2);
      g.fillStyle = i < next ? 'rgba(255,255,255,0.35)' : i === next ? s.def.paintColor : 'rgba(255,255,255,0.85)';
      g.fill();
      if (i % 5 === 4) {
        g.font = `600 ${Math.round(10 * scale)}px system-ui, sans-serif`;
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.textAlign = 'left';
        g.fillText(String(i + 1), x + 6 * scale, y + 3 * scale);
      }
    });

    if (pat.length > 0) {
      const p = pat[next]!;
      const x = px(p.yaw * k - s.punchYaw);
      const y = py(p.pitch * k - s.punchPitch);
      const r = Math.max(3 * scale, Math.tan(s.spreadDeg * DEG) * focal);
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.lineWidth = 2 * scale;
      g.strokeStyle = s.def.paintColor;
      g.stroke();
    }
  }

  private drawImpacts(camera: THREE.Camera, w: number, h: number, scale: number): void {
    const g = this.g;
    const n = this.impacts.length;
    g.lineWidth = 2 * scale;
    for (let i = 0; i < n; i++) {
      // oldest first, fading in toward the newest
      const imp = this.impacts[(this.impactCursor + i) % n]!;
      tmpV.copy(imp.pos).project(camera);
      if (tmpV.z < -1 || tmpV.z > 1) continue;
      const x = (tmpV.x * 0.5 + 0.5) * w;
      const y = (-tmpV.y * 0.5 + 0.5) * h;
      const s = 4 * scale;
      g.globalAlpha = 0.3 + 0.7 * ((i + 1) / n);
      g.strokeStyle = '#1b1530';
      g.lineWidth = 4 * scale;
      g.beginPath();
      g.moveTo(x - s, y - s);
      g.lineTo(x + s, y + s);
      g.moveTo(x + s, y - s);
      g.lineTo(x - s, y + s);
      g.stroke();
      g.strokeStyle = imp.color;
      g.lineWidth = 2 * scale;
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  dispose(): void {
    this.panel.remove();
    this.marker.remove();
    this.notice.remove();
    this.canvas.remove();
    document.getElementById(STYLE_ID)?.remove();
  }
}
