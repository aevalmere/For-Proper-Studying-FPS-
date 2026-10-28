// Shader and buffer prewarm. The first time a material/mesh combination is drawn,
// three.js compiles and links its program and reads back the link status (a
// synchronous round trip to the GPU process), and ANGLE may compile the native
// shader lazily on that first draw. Measured at 4x CPU throttle in the bench, that
// was a 50-400 ms hitch the first time something appeared: the target range, a
// marker's viewmodel on its first switch, the "SPLATTED!" label.
//
// prewarm() pays those costs once at load, behind the click-to-play overlay: it
// draws every mesh in the scene one time, including hidden ones, off-screen ones,
// and instanced meshes that have no instances yet.

import * as THREE from 'three';

export function prewarm(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): number {
  const restore: (() => void)[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      o.visible = true;
      restore.push(() => (o.visible = false));
    }
    if (o.frustumCulled) {
      o.frustumCulled = false;
      restore.push(() => (o.frustumCulled = true));
    }
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh && inst.count === 0) {
      // one instance (identity matrix from the constructor) so it actually draws
      inst.count = 1;
      restore.push(() => (inst.count = 0));
    }
  });
  const t0 = performance.now();
  try {
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
  } finally {
    for (let i = restore.length - 1; i >= 0; i--) restore[i]!();
  }
  return performance.now() - t0;
}
