// Map text labels drawn from one canvas atlas into one mesh (one draw call).

import * as THREE from 'three';
import type { MapLabel } from '@splat/shared';

const CELL_W = 256;
const CELL_H = 64;
const COLS = 4;
/** labels float this far off their surface */
const LIFT = 0.5;

type V3 = [number, number, number];

function basis(l: MapLabel): { n: V3; r: V3; u: V3 } {
  switch (l.facing) {
    case '+x':
      return { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] };
    case '-x':
      return { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] };
    case '+z':
      return { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] };
    case '-z':
      return { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] };
    case '+y': {
      const up = l.up ?? '-z';
      const s = up[0] === '+' ? 1 : -1;
      const u: V3 = up[1] === 'x' ? [s, 0, 0] : [0, 0, s];
      // right = up x normal(+y)
      const r: V3 = [-u[2], 0, u[0]];
      return { n: [0, 1, 0], r, u };
    }
  }
}

function drawCell(ctx: CanvasRenderingContext2D, text: string, color: number, cx: number, cy: number): void {
  let px = 46;
  const font = (s: number) => `bold ${s}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.font = font(px);
  const w = ctx.measureText(text).width;
  if (w > CELL_W - 20) {
    px = Math.floor((px * (CELL_W - 20)) / w);
    ctx.font = font(px);
  }
  ctx.lineWidth = Math.max(4, px * 0.18);
  ctx.strokeStyle = 'rgba(20, 22, 26, 0.9)';
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.strokeText(text, cx, cy);
  ctx.fillText(text, cx, cy);
}

export function buildLabelMesh(labels: readonly MapLabel[], anisotropy: number): THREE.Mesh | null {
  if (!labels.length || typeof document === 'undefined') return null;

  // one cell per distinct text+color
  const cells = new Map<string, number>();
  const keyOf = (l: MapLabel) => `${l.color ?? 0xffffff}|${l.text}`;
  for (const l of labels) if (!cells.has(keyOf(l))) cells.set(keyOf(l), cells.size);
  const rows = Math.ceil(cells.size / COLS);

  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLS;
  canvas.height = CELL_H * rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const [key, i] of cells) {
    const bar = key.indexOf('|');
    drawCell(ctx, key.slice(bar + 1), Number(key.slice(0, bar)), (i % COLS) * CELL_W + CELL_W / 2, Math.floor(i / COLS) * CELL_H + CELL_H / 2 + 2);
  }

  const n = labels.length;
  const pos = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const index: number[] = [];
  labels.forEach((l, li) => {
    const { n: nn, r, u } = basis(l);
    const hw = l.size * 2;
    const hh = l.size / 2;
    const c: V3 = [l.pos.x + nn[0] * LIFT, l.pos.y + nn[1] * LIFT, l.pos.z + nn[2] * LIFT];
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const cell = cells.get(keyOf(l))!;
    const u0 = ((cell % COLS) * CELL_W) / canvas.width;
    const u1 = ((cell % COLS) * CELL_W + CELL_W) / canvas.width;
    const row = Math.floor(cell / COLS);
    const vTop = 1 - (row * CELL_H) / canvas.height;
    const vBot = 1 - ((row + 1) * CELL_H) / canvas.height;
    corners.forEach(([sx, sy], k) => {
      const o = (li * 4 + k) * 3;
      for (let a = 0; a < 3; a++) pos[o + a] = c[a]! + r[a]! * hw * sx + u[a]! * hh * sy;
      uv[(li * 4 + k) * 2] = sx < 0 ? u0 : u1;
      uv[(li * 4 + k) * 2 + 1] = sy < 0 ? vBot : vTop;
    });
    const b = li * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    alphaTest: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'map-labels';
  return mesh;
}
