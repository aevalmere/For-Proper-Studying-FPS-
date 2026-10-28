// Map brushes -> a few merged meshes: one for solid geometry, one for painted
// markings (depth-offset so the coplanar paint wins), one for labels. Colors are
// baked per face (see faceShade) and a world-space grid is added in the shader so
// players can read their speed off the floor.

import * as THREE from 'three';
import type { MapBrush, MapDecor, MapDef } from '@splat/shared';
import { brushFaces, faceShade } from './brushGeometry.ts';
import { buildLabelMesh } from './labels.ts';

export interface GridUniforms {
  uGridStrength: { value: number };
}

const GRID_PARS = /* glsl */ `
uniform float uGridStrength;
varying vec3 vGridPos;
varying vec3 vGridNormal;

// 1 on a grid line, 0 between; fades out once cells get a few pixels small (no moire)
float gridLine(vec2 p, float spacing, float widthPx) {
  vec2 c = p / spacing;
  vec2 w = max(fwidth(c), vec2(1e-6));
  vec2 d = abs(fract(c - 0.5) - 0.5) / w;
  float line = 1.0 - min(min(d.x, d.y) / widthPx, 1.0);
  float cellPx = 1.0 / max(w.x, w.y);
  return line * smoothstep(4.0, 12.0, cellPx);
}

float gridShade() {
  vec3 an = abs(vGridNormal);
  vec2 p = (an.y >= an.x && an.y >= an.z) ? vGridPos.xz : ((an.x >= an.z) ? vGridPos.zy : vGridPos.xy);
  float minor = gridLine(p, 64.0, 1.0);
  float major = gridLine(p, 256.0, 1.5);
  return 1.0 - uGridStrength * max(minor * 0.2, major * 0.38);
}
`;

export function createWorldMaterial(grid: GridUniforms, paint = false): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  if (paint) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -2;
  }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGridStrength = grid.uGridStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridPos;\nvarying vec3 vGridNormal;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGridPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvGridNormal = normal;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GRID_PARS}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= gridShade();');
  };
  return mat;
}

/** Merge brushes into one non-indexed geometry with per-face shaded vertex colors. */
export function buildBrushGeometry(brushes: readonly MapBrush[]): THREE.BufferGeometry {
  const faces = brushes.map((b) =>
    // bottoms resting on or under the floor are never seen
    brushFaces(b.shape).filter((f) => !(f.normal.y < -0.5 && f.verts[0]!.y <= 0.001)),
  );
  let tris = 0;
  for (const list of faces) for (const f of list) tris += f.verts.length - 2;

  const pos = new Float32Array(tris * 9);
  const nrm = new Float32Array(tris * 9);
  const col = new Float32Array(tris * 9);
  const color = new THREE.Color();
  let o = 0;
  brushes.forEach((b, i) => {
    color.setHex(b.color); // sRGB hex -> linear working space
    for (const f of faces[i]!) {
      const s = faceShade(f.normal);
      const r = color.r * s, g = color.g * s, bl = color.b * s;
      for (let k = 1; k + 1 < f.verts.length; k++) {
        for (const v of [f.verts[0]!, f.verts[k]!, f.verts[k + 1]!]) {
          pos[o] = v.x;
          pos[o + 1] = v.y;
          pos[o + 2] = v.z;
          nrm[o] = f.normal.x;
          nrm[o + 1] = f.normal.y;
          nrm[o + 2] = f.normal.z;
          col[o] = r;
          col[o + 1] = g;
          col[o + 2] = bl;
          o += 3;
        }
      }
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

export interface MapView {
  group: THREE.Group;
  grid: GridUniforms;
  drawCalls: number;
}

export function buildMapView(map: MapDef, decor: MapDecor | null, anisotropy: number): MapView {
  const grid: GridUniforms = { uGridStrength: { value: 0.6 } };
  const group = new THREE.Group();
  group.name = 'map';

  const solid = new THREE.Mesh(buildBrushGeometry(map.brushes), createWorldMaterial(grid));
  solid.name = 'map-solid';
  solid.castShadow = true;
  solid.receiveShadow = true;
  solid.matrixAutoUpdate = false;
  group.add(solid);

  if (decor && decor.markings.length) {
    const paint = new THREE.Mesh(buildBrushGeometry(decor.markings), createWorldMaterial(grid, true));
    paint.name = 'map-paint';
    paint.receiveShadow = true;
    paint.renderOrder = 1;
    paint.matrixAutoUpdate = false;
    group.add(paint);
  }

  const labels = decor ? buildLabelMesh(decor.labels, anisotropy) : null;
  if (labels) {
    labels.renderOrder = 2;
    labels.matrixAutoUpdate = false;
    group.add(labels);
  }

  return { group, grid, drawCalls: group.children.length };
}

/** Axis-aligned bounds of all brushes. */
export function mapBounds(map: MapDef): { min: THREE.Vector3; max: THREE.Vector3 } {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const b of map.brushes) {
    min.min(new THREE.Vector3(b.shape.min.x, b.shape.min.y, b.shape.min.z));
    max.max(new THREE.Vector3(b.shape.max.x, b.shape.max.y, b.shape.max.z));
  }
  return { min, max };
}
