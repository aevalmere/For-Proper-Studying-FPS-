import { describe, expect, it } from 'vitest';
import { ARENA, ARENA_DECOR, compileBrush, dot, type BrushShape, type RampDir, vec3 } from '@splat/shared';
import { brushFaces, faceShade } from './brushGeometry.ts';

function expectFacesMatchCollision(shape: BrushShape): void {
  const planes = compileBrush(shape).planes;
  for (const f of brushFaces(shape)) {
    const plane = planes.find((p) => dot(p.n, f.normal) > 0.9999);
    expect(plane, `face normal ${JSON.stringify(f.normal)} has a collision plane`).toBeDefined();
    for (const v of f.verts) expect(dot(plane!.n, v)).toBeCloseTo(plane!.d, 6);
    // winding: (v1 - v0) x (v2 - v0) points along the outward normal
    const [a, b, c] = f.verts as [typeof f.normal, typeof f.normal, typeof f.normal];
    const u = vec3(b.x - a.x, b.y - a.y, b.z - a.z);
    const w = vec3(c.x - a.x, c.y - a.y, c.z - a.z);
    const cross = vec3(u.y * w.z - u.z * w.y, u.z * w.x - u.x * w.z, u.x * w.y - u.y * w.x);
    expect(dot(cross, f.normal)).toBeGreaterThan(0);
  }
}

describe('brushFaces', () => {
  it('builds 6 faces for a box that lie on its collision planes', () => {
    const shape: BrushShape = { kind: 'box', min: vec3(-10, 0, -20), max: vec3(30, 40, 50) };
    expect(brushFaces(shape)).toHaveLength(6);
    expectFacesMatchCollision(shape);
  });

  for (const up of ['+x', '-x', '+z', '-z'] as RampDir[]) {
    it(`builds a wedge for a ramp climbing ${up} that matches compileBrush`, () => {
      const shape: BrushShape = { kind: 'ramp', min: vec3(100, 0, -300), max: vec3(260, 96, -120), up };
      const faces = brushFaces(shape);
      expect(faces).toHaveLength(5);
      expectFacesMatchCollision(shape);
      // the sloped face's top edge sits at max.y on the `up` side
      const slope = faces[0]!;
      const axis = up[1] as 'x' | 'z';
      const highEdge = up[0] === '+' ? shape.max[axis] : shape.min[axis];
      for (const v of slope.verts) {
        if (v.y === shape.max.y) expect(v[axis]).toBe(highEdge);
      }
    });
  }

  it('matches collision for every brush and marking in the arena', () => {
    for (const b of [...ARENA.brushes, ...ARENA_DECOR.markings]) expectFacesMatchCollision(b.shape);
  });
});

describe('faceShade', () => {
  it('lights tops brightest and bottoms darkest, sides in between and distinct', () => {
    const top = faceShade(vec3(0, 1, 0));
    const bottom = faceShade(vec3(0, -1, 0));
    const sides = [vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 0, 1), vec3(0, 0, -1)].map(faceShade);
    expect(top).toBe(1);
    for (const s of sides) {
      expect(s).toBeLessThan(top);
      expect(s).toBeGreaterThan(bottom);
    }
    expect(new Set(sides).size).toBe(4);
  });
});
