// Plain-object vectors so state serializes cleanly for the network later.
// Functions write into `out` and return it to avoid allocations in the 64 Hz loop.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s */
export function madd(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/** Horizontal speed: what the speedometer shows. */
export function lengthXZ(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}

export function normalize(out: Vec3, a: Vec3): Vec3 {
  const len = length(a);
  return len > 0 ? scale(out, a, 1 / len) : set(out, 0, 0, 0);
}

// View-angle convention (shared by sim, client camera, and projectiles):
// radians, Y-up; yaw 0 looks down -Z and positive yaw turns left
// (same as a Three.js camera rotated with Euler order 'YXZ'); positive pitch looks up.

export function viewForward(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** Horizontal forward, ignoring pitch. */
export function yawForward(out: Vec3, yaw: number): Vec3 {
  return set(out, -Math.sin(yaw), 0, -Math.cos(yaw));
}

/** Horizontal right vector for a yaw. */
export function yawRight(out: Vec3, yaw: number): Vec3 {
  return set(out, Math.cos(yaw), 0, -Math.sin(yaw));
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
