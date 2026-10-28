// Browser input: keyboard, mouse buttons, wheel, and pointer lock.
//
// Uses the raw Pointer Lock API rather than three's PointerLockControls because
// the sim needs explicit yaw/pitch, and so it can ask for unadjusted (raw,
// unaccelerated) movement. Falls back to a plain lock where raw isn't supported,
// and to drag-to-look where pointer lock isn't available at all.

import type { ClientSettings } from '../settings.ts';
import { CmdBuilder, type Action } from './cmdBuilder.ts';

export interface InputCallbacks {
  respawn(): void;
  togglePanel(): void;
  /** F2: the frame-time graph */
  togglePerf(): void;
  activeChange(active: boolean): void;
  message(text: string): void;
}

export type RawState = 'on' | 'off' | 'unknown';

const KEY_ACTIONS: Record<string, Action> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'jump',
  KeyC: 'crouch',
  ShiftLeft: 'walk',
  ShiftRight: 'walk',
};

type LockFn = (options?: { unadjustedMovement?: boolean }) => Promise<void> | void;
type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

export class Input {
  readonly cmd: CmdBuilder;
  /** game input is live (pointer locked, or drag-look fallback engaged) */
  active = false;
  raw: RawState = 'unknown';
  /** no pointer lock available: look by dragging */
  dragFallback = false;
  keyboardLocked = false;

  private dx = 0;
  private dy = 0;
  private dragging = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly target: HTMLElement,
    private readonly settings: ClientSettings,
    private readonly cb: InputCallbacks,
    weaponCount: number,
  ) {
    this.cmd = new CmdBuilder(weaponCount);
    this.cmd.opposingKeys = settings.opposingKeys;
    this.dragFallback = typeof target.requestPointerLock !== 'function';

    const opts = { signal: this.abort.signal };
    window.addEventListener('keydown', this.onKeyDown, { ...opts, capture: true });
    window.addEventListener('keyup', this.onKeyUp, { ...opts, capture: true });
    document.addEventListener('mousemove', this.onMouseMove, opts);
    document.addEventListener('mousedown', this.onMouseDown, opts);
    document.addEventListener('mouseup', this.onMouseUp, opts);
    window.addEventListener('wheel', this.onWheel, { ...opts, passive: false });
    target.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    document.addEventListener('pointerlockchange', this.onLockChange, opts);
    document.addEventListener('pointerlockerror', this.onLockError, opts);
    document.addEventListener('fullscreenchange', this.onFullscreenChange, opts);
    // Nothing may stay held once we stop seeing key/button-up events: focus moving to
    // another window, the tab hiding (it can happen without a blur), or losing the
    // pointer lock (setActive). Look deltas from before the switch are dropped too.
    window.addEventListener('blur', this.dropHeld, opts);
    document.addEventListener('visibilitychange', () => document.hidden && this.dropHeld(), opts);
  }

  private readonly dropHeld = (): void => {
    this.cmd.releaseAll();
    this.dx = this.dy = 0;
    this.dragging = false;
  };

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.target;
  }

  /** Mouse counts accumulated since the last call. */
  consumeLook(out: { dx: number; dy: number }): void {
    out.dx = this.dx;
    out.dy = this.dy;
    this.dx = 0;
    this.dy = 0;
  }

  /** Call from a user gesture (click). */
  async requestLock(): Promise<void> {
    if (this.dragFallback) {
      this.setActive(true);
      return;
    }
    const lock = this.target.requestPointerLock.bind(this.target) as LockFn;
    this.cb.message('');
    if (this.settings.rawInput) {
      try {
        const p = lock({ unadjustedMovement: true });
        if (p && typeof p.then === 'function') {
          await p;
          this.raw = 'on';
        } else {
          this.raw = 'unknown'; // browser ignored the option (older Firefox)
        }
        return;
      } catch (err) {
        if ((err as DOMException)?.name !== 'NotSupportedError') {
          this.lockFailed(err);
          return;
        }
        // raw input not supported on this OS/browser: plain lock below
      }
    }
    try {
      const p = lock();
      if (p && typeof p.then === 'function') await p;
      this.raw = 'off';
    } catch (err) {
      this.lockFailed(err);
    }
  }

  release(): void {
    if (this.pointerLocked) document.exitPointerLock();
    else if (this.dragFallback) this.setActive(false);
  }

  /** Fullscreen + Keyboard Lock (Chromium): lets Ctrl crouch without Ctrl+W closing the tab. */
  async enterFullscreen(): Promise<void> {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      const kb = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
      if (kb?.lock) {
        await kb.lock();
        this.keyboardLocked = true;
      }
    } catch {
      // fullscreen or keyboard lock refused: carry on windowed
    }
    await this.requestLock();
  }

  dispose(): void {
    this.abort.abort();
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      this.cmd.releaseAll();
      this.dx = this.dy = 0;
      this.dragging = false;
    }
    this.cb.activeChange(active);
  }

  private lockFailed(err: unknown): void {
    const name = (err as DOMException)?.name ?? '';
    console.warn('[input] pointer lock failed', err);
    this.cb.message(
      name === 'SecurityError' || name === 'NotAllowedError'
        ? 'The browser blocked mouse lock for a moment after Esc. Click again in a second.'
        : 'Mouse lock failed. Click to try again.',
    );
  }

  private actionFor(code: string): Action | undefined {
    if (code === 'ControlLeft' && this.settings.ctrlCrouch && this.keyboardLocked && document.fullscreenElement) return 'crouch';
    return KEY_ACTIONS[code];
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    const code = e.code;
    if (code === 'F2') {
      e.preventDefault();
      if (!e.repeat) this.cb.togglePerf();
      return;
    }
    if (code === 'F1' || code === 'Backquote') {
      e.preventDefault();
      if (!e.repeat) this.cb.togglePanel();
      return;
    }
    if (code === 'KeyR') {
      if (!e.repeat) this.cb.respawn();
      if (this.active) e.preventDefault();
      return;
    }
    if (!this.active) return;
    if (code === 'Escape') {
      // with Keyboard Lock active the browser only exits on a long press; make a tap release the mouse
      this.release();
      return;
    }
    const action = this.actionFor(code);
    if (action) {
      e.preventDefault();
      if (!e.repeat) this.cmd.press(action, code);
      return;
    }
    if (code.startsWith('Digit')) {
      const slot = Number(code.slice(5)) - 1;
      if (slot >= 0 && slot < this.cmd.weaponCount) {
        e.preventDefault();
        this.cmd.selectWeapon(slot);
      }
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const code = e.code;
    if (code === 'ControlLeft') this.cmd.release('crouch', code);
    const action = KEY_ACTIONS[code];
    if (action) this.cmd.release(action, code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (this.pointerLocked || (this.dragFallback && this.active && this.dragging)) {
      this.dx += e.movementX;
      this.dy += e.movementY;
    }
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.active) return;
    if (this.dragFallback) this.dragging = true;
    if (e.button === 0) this.cmd.press('fire', 'Mouse0');
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.cmd.release('fire', 'Mouse0');
    if (e.buttons === 0) this.dragging = false;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.active || e.deltaY === 0) return;
    e.preventDefault();
    if (this.settings.wheel === 'jump') this.cmd.queueWheelJump();
    else this.cmd.cycleWeapon(e.deltaY > 0 ? 1 : -1);
  };

  private readonly onLockChange = (): void => {
    this.setActive(this.pointerLocked);
  };

  private readonly onLockError = (): void => {
    this.lockFailed(new DOMException('pointer lock error', 'NotAllowedError'));
  };

  private readonly onFullscreenChange = (): void => {
    if (!document.fullscreenElement) {
      this.keyboardLocked = false;
      this.cmd.release('crouch', 'ControlLeft');
    }
  };
}
