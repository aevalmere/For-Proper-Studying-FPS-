import { describe, expect, it } from 'vitest';
import { verticalFovFromCs } from '../render/fov.ts';
import { angleToPixels, easeGap } from './hud.ts';

describe('dynamic crosshair', () => {
  it('maps half the vertical FOV to half the viewport height', () => {
    const fov = verticalFovFromCs(90);
    expect(angleToPixels(fov / 2, fov, 768)).toBeCloseTo(384, 6);
    expect(angleToPixels(0, fov, 768)).toBe(0);
  });

  it('sizes a 1 degree cone sensibly at 1366x768, CS FOV 90', () => {
    // vertical FOV 73.7 deg: focal length 512 px, so 1 deg is ~8.9 px
    const px = angleToPixels(1, verticalFovFromCs(90), 768);
    expect(px).toBeGreaterThan(8.5);
    expect(px).toBeLessThan(9.5);
  });

  it('eases toward the target without overshoot, opening faster than closing', () => {
    let open = 0;
    let close = 40;
    for (let i = 0; i < 6; i++) {
      open = easeGap(open, 40, 1 / 60);
      close = easeGap(close, 0, 1 / 60);
      expect(open).toBeLessThanOrEqual(40);
      expect(close).toBeGreaterThanOrEqual(0);
    }
    // after 0.1 s it has covered more of the way opening than closing
    expect(open / 40).toBeGreaterThan(1 - close / 40);
    expect(easeGap(10, 10, 1 / 60)).toBe(10);
    expect(easeGap(5, 20, 0)).toBe(5);
  });

  it('settles within a quarter second when you stop moving', () => {
    let g = 40;
    for (let i = 0; i < 15; i++) g = easeGap(g, 0, 1 / 60);
    expect(g).toBeLessThan(2.5);
  });
});
