// Turns key/button events into one UserCmd per tick. No DOM here so it can be
// unit tested; input.ts feeds it from browser events.
//
// Latching: a press that starts and ends between two ticks still shows up in the
// next sampled cmd, so a tap or a wheel notch shorter than 15.6 ms is never lost.

import { Buttons, type UserCmd } from '@splat/shared';
import type { OpposingKeys } from '../settings.ts';

export type Action = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'crouch' | 'walk' | 'fire';

const BUTTON_BITS: [Action, number][] = [
  ['jump', Buttons.JUMP],
  ['crouch', Buttons.CROUCH],
  ['walk', Buttons.WALK],
  ['fire', Buttons.FIRE],
];

export class CmdBuilder {
  opposingKeys: OpposingKeys = 'cancel';
  weapon = 0;

  /** sources (key codes, mouse buttons) currently holding each action */
  private readonly held = new Map<Action, Set<string>>();
  /** actions pressed since the last sample */
  private readonly latched = new Set<Action>();
  /** press order, for last-pressed-wins */
  private readonly pressOrder = new Map<Action, number>();
  private pressCounter = 0;
  private wheelJumpQueued = false;
  private wheelJumpLastTick = false;

  constructor(readonly weaponCount = 3) {}

  press(action: Action, source: string): void {
    let set = this.held.get(action);
    if (!set) this.held.set(action, (set = new Set()));
    if (set.has(source)) return;
    set.add(source);
    this.latched.add(action);
    this.pressOrder.set(action, ++this.pressCounter);
  }

  release(action: Action, source: string): void {
    this.held.get(action)?.delete(source);
  }

  /** Drop every held key (focus lost, pointer unlocked). Latched taps still fire once. */
  releaseAll(): void {
    for (const set of this.held.values()) set.clear();
  }

  isHeld(action: Action): boolean {
    return (this.held.get(action)?.size ?? 0) > 0;
  }

  /**
   * One wheel notch = one jump press. The press lasts one tick and is followed by
   * at least one released tick, so rapid scrolling produces fresh jump edges
   * instead of a held button (which would not re-jump without auto-bhop).
   */
  queueWheelJump(): void {
    this.wheelJumpQueued = true;
  }

  selectWeapon(slot: number): void {
    if (slot >= 0 && slot < this.weaponCount) this.weapon = slot;
  }

  cycleWeapon(dir: 1 | -1): void {
    this.weapon = (this.weapon + dir + this.weaponCount) % this.weaponCount;
  }

  /** Fill `out` for the next tick and clear the latches. */
  sample(out: UserCmd, seq: number, yaw: number, pitch: number): UserCmd {
    out.seq = seq;
    out.yaw = yaw;
    out.pitch = pitch;
    out.forward = this.axis('forward', 'back');
    out.side = this.axis('right', 'left');

    let buttons = 0;
    for (const [action, bit] of BUTTON_BITS) if (this.active(action)) buttons |= bit;

    let wheelJump = false;
    if (this.wheelJumpQueued && !this.wheelJumpLastTick) {
      wheelJump = true;
      this.wheelJumpQueued = false;
    }
    this.wheelJumpLastTick = wheelJump;
    if (wheelJump) buttons |= Buttons.JUMP;

    out.buttons = buttons;
    out.weapon = this.weapon;
    this.latched.clear();
    return out;
  }

  private active(action: Action): boolean {
    return this.isHeld(action) || this.latched.has(action);
  }

  private axis(pos: Action, neg: Action): number {
    const p = this.active(pos);
    const n = this.active(neg);
    if (p && n) {
      if (this.opposingKeys === 'cancel') return 0;
      return (this.pressOrder.get(pos) ?? 0) > (this.pressOrder.get(neg) ?? 0) ? 1 : -1;
    }
    return p ? 1 : n ? -1 : 0;
  }
}
