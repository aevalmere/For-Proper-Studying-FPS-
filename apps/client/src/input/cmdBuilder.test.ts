import { describe, expect, it } from 'vitest';
import { Buttons, emptyCmd } from '@splat/shared';
import { CmdBuilder } from './cmdBuilder.ts';

const cmd = emptyCmd();
const sample = (b: CmdBuilder) => ({ ...b.sample(cmd, 0, 0, 0) });

describe('CmdBuilder', () => {
  it('maps held keys to axes and buttons', () => {
    const b = new CmdBuilder();
    b.press('forward', 'KeyW');
    b.press('right', 'KeyD');
    b.press('walk', 'ShiftLeft');
    const c = sample(b);
    expect(c.forward).toBe(1);
    expect(c.side).toBe(1);
    expect(c.buttons).toBe(Buttons.WALK);
  });

  it('latches a tap shorter than a tick into the next cmd only', () => {
    const b = new CmdBuilder();
    b.press('jump', 'Space');
    b.release('jump', 'Space');
    b.press('left', 'KeyA');
    b.release('left', 'KeyA');
    const first = sample(b);
    expect(first.buttons & Buttons.JUMP).toBeTruthy();
    expect(first.side).toBe(-1);
    const second = sample(b);
    expect(second.buttons).toBe(0);
    expect(second.side).toBe(0);
  });

  it('last pressed wins on opposite keys, and falls back when it is released', () => {
    const b = new CmdBuilder();
    b.press('right', 'KeyD');
    expect(sample(b).side).toBe(1);
    b.press('left', 'KeyA');
    expect(sample(b).side).toBe(-1);
    b.release('left', 'KeyA');
    expect(sample(b).side).toBe(1);
  });

  it('cancels opposite keys in cancel mode', () => {
    const b = new CmdBuilder();
    b.opposingKeys = 'cancel';
    b.press('forward', 'KeyW');
    b.press('back', 'KeyS');
    expect(sample(b).forward).toBe(0);
  });

  it('a tapped counter-strafe key wins for one tick while the other is held', () => {
    const b = new CmdBuilder();
    b.press('right', 'KeyD');
    sample(b);
    b.press('left', 'KeyA');
    b.release('left', 'KeyA');
    expect(sample(b).side).toBe(-1);
    expect(sample(b).side).toBe(1);
  });

  it('keeps an action held while any of its sources is down', () => {
    const b = new CmdBuilder();
    b.press('crouch', 'KeyC');
    b.press('crouch', 'ControlLeft');
    b.release('crouch', 'KeyC');
    expect(sample(b).buttons & Buttons.CROUCH).toBeTruthy();
    b.release('crouch', 'ControlLeft');
    expect(sample(b).buttons & Buttons.CROUCH).toBeFalsy();
  });

  it('turns each wheel notch into a one-tick jump with a released tick between', () => {
    const b = new CmdBuilder();
    const jumps: boolean[] = [];
    for (let t = 0; t < 6; t++) {
      b.queueWheelJump(); // a notch every tick
      jumps.push((sample(b).buttons & Buttons.JUMP) !== 0);
    }
    expect(jumps).toEqual([true, false, true, false, true, false]);
    // queued notches don't pile up into a long hold
    expect((sample(b).buttons & Buttons.JUMP) !== 0).toBe(true);
    expect((sample(b).buttons & Buttons.JUMP) !== 0).toBe(false);
  });

  it('releaseAll drops held keys', () => {
    const b = new CmdBuilder();
    b.press('forward', 'KeyW');
    sample(b);
    b.releaseAll();
    expect(sample(b).forward).toBe(0);
  });

  it('selects and cycles weapons within the loadout', () => {
    const b = new CmdBuilder(3);
    b.selectWeapon(2);
    expect(sample(b).weapon).toBe(2);
    b.cycleWeapon(1);
    expect(sample(b).weapon).toBe(0);
    b.cycleWeapon(-1);
    expect(sample(b).weapon).toBe(2);
    b.selectWeapon(7);
    expect(sample(b).weapon).toBe(2);
  });
});
