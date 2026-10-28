// Shooting HUD: a DOM panel (marker, ammo, spray/spread readouts) and a 2D canvas
// overlay for the spray-pattern debug view, recent impacts, and hit feedback.
// The crosshair itself belongs to the client core.

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
`;

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
  /** spread the next shot would get, deg */
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
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

export class ShootingHud {
  private readonly panel: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly ammoEl: HTMLDivElement;
  private readonly slotsEl: HTMLDivElement;
  private readonly debugEl: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly target: HTMLCanvasElement;
  private readonly impacts: Impact[] = [];
  private impactCursor = 0;
  private hitTimer = 0;
  private splatTimer = 0;
  private splatColor = '#ffffff';
  private last = { name: '', ammo: '', slots: '', debug: '' };
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

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'splat-shoot-overlay';
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

  onTargetHit(): void {
    this.hitTimer = 0.18;
  }

  onSplatted(color: string): void {
    this.splatTimer = 1.1;
    this.splatColor = color;
  }

  updatePanel(s: HudState, defs: Record<WeaponId, WeaponDef>): void {
    const name = s.def.name.toUpperCase();
    const ammo = s.infiniteAmmo ? `∞<small> / ${s.def.stats.hopperSize}</small>` : `${s.ammo}<small> / ${s.def.stats.hopperSize}</small>`;
    const slots = LOADOUT.map((id, i) => `<span class="${id === s.active ? 'on' : ''}">${i + 1} ${defs[id].name}</span>`).join('');
    const debug = `spray idx ${s.sprayIndex} · spread ${s.spreadDeg.toFixed(2)}°`;
    if (name !== this.last.name) this.nameEl.textContent = this.last.name = name;
    if (ammo !== this.last.ammo) this.ammoEl.innerHTML = this.last.ammo = ammo;
    if (slots !== this.last.slots) this.slotsEl.innerHTML = this.last.slots = slots;
    if (debug !== this.last.debug) this.debugEl.textContent = this.last.debug = debug;
    this.nameEl.style.color = s.def.paintColor;
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

  drawOverlay(s: OverlayState, camera: THREE.PerspectiveCamera, frameDt: number): void {
    this.hitTimer = Math.max(0, this.hitTimer - frameDt);
    this.splatTimer = Math.max(0, this.splatTimer - frameDt);
    const active = s.showPattern || (s.showImpacts && this.impacts.length > 0) || this.hitTimer > 0 || this.splatTimer > 0;
    if (!active) {
      if (this.width > 0) {
        this.g.clearRect(0, 0, this.width, this.height);
        this.width = this.height = 0;
        this.canvas.width = this.canvas.height = 0;
      }
      return;
    }
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

    if (this.hitTimer > 0) {
      const a = this.hitTimer / 0.18;
      const gap = 7 * scale;
      const len = 7 * scale;
      g.lineCap = 'round';
      for (const [lw, color] of [[4, `rgba(20,16,40,${0.6 * a})`], [2, `rgba(255,255,255,${a})`]] as const) {
        g.lineWidth = lw * scale;
        g.strokeStyle = color;
        g.beginPath();
        for (const [dx, dy] of DIAGONALS) {
          g.moveTo(cx + dx * gap, cy + dy * gap);
          g.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
        }
        g.stroke();
      }
    }

    if (this.splatTimer > 0) {
      const a = Math.min(1, this.splatTimer / 0.3);
      g.globalAlpha = a;
      g.font = `800 ${Math.round(26 * scale)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 6 * scale;
      g.strokeStyle = '#1b1530';
      const y = cy + 54 * scale;
      g.strokeText('SPLATTED!', cx, y);
      g.fillStyle = this.splatColor;
      g.fillText('SPLATTED!', cx, y);
      g.globalAlpha = 1;
    }
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
    this.canvas.remove();
    document.getElementById(STYLE_ID)?.remove();
  }
}
