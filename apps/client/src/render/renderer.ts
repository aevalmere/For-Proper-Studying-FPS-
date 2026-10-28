// WebGL renderer, scene, camera and lights, plus the quality and FOV knobs.

import * as THREE from 'three';
import type { Vec3 } from '@splat/shared';
import type { ClientSettings, Quality } from '../settings.ts';
import { verticalFovFromCs } from './fov.ts';

export interface RenderRig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** antialias the context was created with; changing it needs a reload */
  readonly antialias: boolean;
  applyQuality(q: Quality): void;
  /** CS-style horizontal FOV at 4:3 */
  setFov(fov43: number): void;
  /**
   * 3D resolution as a fraction of the window (0.5..1). The canvas keeps its CSS
   * size and the browser stretches the smaller drawing buffer to fill it.
   */
  setRenderScale(scale: number): void;
  /** the render scale in effect */
  readonly renderScale: number;
  /** canvas CSS size, cached on resize so per-frame code never reads layout */
  readonly viewport: { width: number; height: number };
  resize(): void;
}

const SKY = 0xa3c4e4;

export function createRenderRig(container: HTMLElement, settings: ClientSettings, bounds: { min: Vec3; max: Vec3 }): RenderRig {
  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas';
  container.appendChild(canvas);

  const antialias = settings.quality === 'high';
  let context: WebGL2RenderingContext | undefined;
  if (settings.lowLatency) {
    // `desynchronized` lets Chrome skip the compositor queue (one frame less
    // latency on ChromeOS/Windows) at the cost of possible tearing.
    context =
      canvas.getContext('webgl2', {
        antialias,
        alpha: false,
        depth: true,
        stencil: false,
        powerPreference: 'high-performance',
        desynchronized: true,
      }) ?? undefined;
  }
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias, powerPreference: 'high-performance', stencil: false });
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 3000, 9000);

  const camera = new THREE.PerspectiveCamera(verticalFovFromCs(settings.fov), 1, 2, 12000);
  camera.rotation.order = 'YXZ';
  scene.add(camera); // so systems can parent view models to it

  // Lighting: sky/ground fill plus one sun. Lambert, no shadows unless 'high'.
  const center = new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, 0, (bounds.min.z + bounds.max.z) / 2);
  const hemi = new THREE.HemisphereLight(0xeaf2ff, 0x5c6168, 2.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3df, 2.0);
  sun.position.copy(center).add(new THREE.Vector3(0.45, 1, 0.3).normalize().multiplyScalar(4000));
  sun.target.position.copy(center);
  scene.add(sun, sun.target);
  const radius = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2;
  const sc = sun.shadow.camera;
  sc.left = -radius;
  sc.right = radius;
  sc.top = radius;
  sc.bottom = -radius;
  sc.near = 100;
  sc.far = 8000;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 1.5;

  let fov43 = settings.fov;
  let quality = settings.quality;
  let renderScale = clampScale(settings.renderScale);
  const viewport = { width: 1, height: 1 };

  const applyPixelRatio = () => {
    const base = quality === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const pr = base * renderScale;
    if (renderer.getPixelRatio() !== pr) renderer.setPixelRatio(pr);
  };

  const resize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    viewport.width = w;
    viewport.height = h;
    applyPixelRatio();
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.fov = verticalFovFromCs(fov43);
    camera.updateProjectionMatrix();
  };

  const applyQuality = (q: Quality) => {
    const high = q === 'high';
    quality = q;
    if (renderer.shadowMap.enabled !== high) {
      renderer.shadowMap.enabled = high;
      sun.castShadow = high;
      // shadow on/off changes shader programs
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    resize();
  };

  applyQuality(settings.quality);
  window.addEventListener('resize', resize);

  return {
    renderer,
    scene,
    camera,
    antialias,
    applyQuality,
    setFov(f: number) {
      fov43 = f;
      resize();
    },
    setRenderScale(scale: number) {
      const next = clampScale(scale);
      if (next === renderScale) return;
      renderScale = next;
      applyPixelRatio();
    },
    get renderScale() {
      return renderScale;
    },
    viewport,
    resize,
  };
}

function clampScale(s: number): number {
  return Number.isFinite(s) ? Math.min(1, Math.max(0.25, s)) : 1;
}
