// Player-facing client settings (not sim tuning). Persisted under `splat.settings`.

export type Quality = 'low' | 'high';
/** what the mouse wheel does: jump (scroll bhop) or cycle weapons */
export type WheelMode = 'jump' | 'weapon';
/** both keys of an axis held: last pressed wins (snappy counter-strafe) or they cancel */
export type OpposingKeys = 'lastWins' | 'cancel';

export interface ClientSettings {
  /** CS-style: degrees per mouse count = sensitivity * 0.022 */
  sensitivity: number;
  invertY: boolean;
  /** request unadjusted (raw) mouse movement when locking the pointer */
  rawInput: boolean;
  /** CS-style horizontal FOV in degrees, measured at 4:3 */
  fov: number;
  quality: Quality;
  /**
   * 3D resolution as a fraction of the window (0.5..1); the canvas is drawn smaller
   * and stretched to fit. Fill rate is what limits Chromebook GPUs.
   */
  renderScale: number;
  /** lower the resolution below renderScale while frames miss their budget, restore it when they don't */
  adaptiveResolution: boolean;
  /** create the canvas with `desynchronized` (lower latency, may tear); needs a reload */
  lowLatency: boolean;
  wheel: WheelMode;
  opposingKeys: OpposingKeys;
  /** Ctrl also crouches, only while fullscreen with the keyboard locked (else Ctrl+W closes the tab) */
  ctrlCrouch: boolean;
  crosshairSize: number;
  crosshairGap: number;
  crosshairThickness: number;
  crosshairColor: string;
  crosshairOutline: boolean;
  crosshairDot: boolean;
  /** crosshair gap opens with the next shot's spread (stand still to tighten it) */
  dynamicCrosshair: boolean;
  /** 0..1 strength of the world-space floor/wall grid */
  gridStrength: number;
  showFps: boolean;
  showDebug: boolean;
  /** frame-time graph with render scale and draw calls (F2) */
  perfGraph: boolean;
  /** index into the map's teleport list: where R (respawn) puts you */
  spawnAt: number;
}

export const SETTINGS_KEY = 'splat.settings';
/**
 * Bump when a changed default must reach browsers that saved the old value, and add
 * the step to `migrateSettings`. 1: opposing keys cancel out (Valorant movement).
 */
export const SETTINGS_REVISION = 1;
export const SETTINGS_REVISION_KEY = `${SETTINGS_KEY}.rev`;

export const SETTINGS_OPTIONS = {
  quality: ['low', 'high'] as Quality[],
  wheel: ['jump', 'weapon'] as WheelMode[],
  opposingKeys: ['lastWins', 'cancel'] as OpposingKeys[],
};

export const SETTINGS_RANGES: Partial<Record<keyof ClientSettings, { min: number; max: number; step: number }>> = {
  sensitivity: { min: 0.1, max: 10, step: 0.01 },
  fov: { min: 70, max: 120, step: 1 },
  crosshairSize: { min: 0, max: 24, step: 1 },
  crosshairGap: { min: 0, max: 16, step: 1 },
  crosshairThickness: { min: 1, max: 6, step: 1 },
  gridStrength: { min: 0, max: 1, step: 0.05 },
  renderScale: { min: 0.5, max: 1, step: 0.05 },
};

/** Render scale a new 'low' profile starts at: 0.75 draws 56% of the pixels. */
export const LOW_RENDER_SCALE = 0.75;

interface DeviceHints {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
}

/** Low on anything that looks like a Chromebook-class or mobile device. */
export function defaultQuality(nav: DeviceHints = typeof navigator === 'undefined' ? {} : navigator): Quality {
  const cores = nav.hardwareConcurrency ?? 4;
  const mem = nav.deviceMemory ?? 8;
  const ua = nav.userAgent ?? '';
  if (cores <= 4 || mem <= 4 || /CrOS|Android|iPhone|iPad|Mobile/i.test(ua)) return 'low';
  return 'high';
}

export function defaultSettings(quality: Quality = defaultQuality()): ClientSettings {
  return {
    sensitivity: 1.5,
    invertY: false,
    rawInput: true,
    fov: 90,
    quality,
    renderScale: quality === 'low' ? LOW_RENDER_SCALE : 1,
    adaptiveResolution: quality === 'low',
    lowLatency: false,
    wheel: 'jump',
    opposingKeys: 'cancel',
    ctrlCrouch: true,
    crosshairSize: 6,
    crosshairGap: 3,
    crosshairThickness: 2,
    crosshairColor: '#00ffff',
    crosshairOutline: true,
    crosshairDot: false,
    dynamicCrosshair: true,
    gridStrength: 0.6,
    showFps: true,
    showDebug: true,
    perfGraph: false,
    spawnAt: 0,
  };
}

/** Copy saved values over defaults, keeping only keys whose type (and enum value) is valid. */
export function mergeSettings(defaults: ClientSettings, saved: unknown): ClientSettings {
  const out = { ...defaults };
  if (!saved || typeof saved !== 'object') return out;
  const src = saved as Record<string, unknown>;
  const dst = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof ClientSettings)[]) {
    const v = src[key];
    if (typeof v !== typeof defaults[key]) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    const options = (SETTINGS_OPTIONS as Record<string, readonly string[]>)[key];
    if (options && !options.includes(v as string)) continue;
    dst[key] = v;
  }
  return out;
}

/** Bring settings saved under `savedRevision` up to SETTINGS_REVISION, in place. */
export function migrateSettings(s: ClientSettings, savedRevision: number): ClientSettings {
  if (savedRevision < 1) s.opposingKeys = 'cancel';
  return s;
}

export function loadSettings(): ClientSettings {
  const defaults = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const s = mergeSettings(defaults, raw ? JSON.parse(raw) : null);
    const savedRevision = Number(localStorage.getItem(SETTINGS_REVISION_KEY)) || 0;
    if (raw && savedRevision < SETTINGS_REVISION) saveSettings(migrateSettings(s, savedRevision));
    return s;
  } catch {
    return defaults;
  }
}

export function saveSettings(s: ClientSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    localStorage.setItem(SETTINGS_REVISION_KEY, String(SETTINGS_REVISION));
  } catch {
    // storage blocked: settings still apply for this session
  }
}
