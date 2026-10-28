// Live tuning folders for the dev panel. Every number/boolean field on `target`
// gets a control (built from whatever fields exist, so config structs can grow
// or shrink freely); edits mutate `target` in place, persist to localStorage, and
// can be copied out as JSON to paste back into a preset in packages/shared.
//
// Values that differ from the selected preset are highlighted, and hovering a
// control shows the preset value. "reset to default" restores the selected
// preset (or the code defaults when there are no presets).

import type GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import type { TunableMeta } from '@splat/shared';

export interface TunableOptions<T> {
  /** localStorage key; omit to disable persistence */
  storageKey?: string;
  /** named presets selectable from a dropdown; the first one is the initial selection */
  presets?: Record<string, T>;
  /** called after any change made through the panel (slider, preset, reset) */
  onChange?: () => void;
}

function loadSaved(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function loadString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    // storage blocked (private window etc.): tuning still works for this session
  }
}

function guessMeta(v: number): TunableMeta {
  if (v === 0) return { min: 0, max: 1, step: 0.01 };
  const mag = Math.abs(v);
  const step = Number.isInteger(v) && mag >= 10 ? 1 : mag >= 100 ? 1 : mag >= 10 ? 0.1 : mag >= 1 ? 0.01 : 0.001;
  return { min: Math.min(0, v * 4), max: Math.max(0, v * 4), step };
}

export function addTunables<T extends object>(
  parent: GUI,
  title: string,
  target: T,
  meta: Partial<Record<keyof T, TunableMeta>>,
  opts: TunableOptions<T> = {},
): GUI {
  const rec = target as Record<string, unknown>;
  const codeDefaults = { ...rec };
  const presets = opts.presets as Record<string, Record<string, unknown>> | undefined;
  const presetNames = presets ? Object.keys(presets) : [];
  const presetKey = opts.storageKey ? `${opts.storageKey}.preset` : null;

  const state = { preset: presetNames[0] ?? '' };
  const savedPreset = presetKey ? loadString(presetKey) : null;
  if (savedPreset && presetNames.includes(savedPreset)) state.preset = savedPreset;
  const baseline = (): Record<string, unknown> => (presets ? (presets[state.preset] ?? codeDefaults) : codeDefaults);

  if (opts.storageKey) {
    const saved = loadSaved(opts.storageKey);
    if (saved) {
      for (const k of Object.keys(rec)) {
        if (k in saved && typeof saved[k] === typeof rec[k]) rec[k] = saved[k];
      }
    } else if (presets && savedPreset) {
      Object.assign(target, presets[state.preset]);
    }
  }

  const folder = parent.addFolder(title);
  const controllers: Controller[] = [];

  const refresh = () => {
    const base = baseline();
    for (const c of controllers) {
      c.updateDisplay();
      const k = c.property;
      const modified = k in base && base[k] !== rec[k];
      c.domElement.classList.toggle('tuning-modified', modified);
      c.domElement.title = k in base ? `${state.preset || 'default'}: ${String(base[k])}` : '';
    }
  };
  const changed = () => {
    if (opts.storageKey) save(opts.storageKey, target);
    refresh();
    opts.onChange?.();
  };

  if (presets) {
    folder
      .add(state, 'preset', presetNames)
      .name('preset')
      .onChange((name: string) => {
        Object.assign(target, presets[name]);
        if (presetKey) save(presetKey, name);
        changed();
      });
  }

  for (const key of Object.keys(rec)) {
    const v = rec[key];
    const m = (meta as Record<string, TunableMeta | undefined>)[key];
    let c: Controller | null = null;
    if (typeof v === 'number') {
      const r = m ?? guessMeta(typeof codeDefaults[key] === 'number' ? (codeDefaults[key] as number) : v);
      c = folder.add(rec, key, r.min, r.max, r.step);
    } else if (typeof v === 'boolean') {
      c = folder.add(rec, key);
    }
    if (c) {
      c.name(m?.label ?? key).onChange(changed);
      controllers.push(c);
    }
  }

  const actions = {
    copyJson: () => {
      const json = JSON.stringify(target, null, 2);
      navigator.clipboard?.writeText(json).catch(() => {});
      console.log(`[tuning] ${title}${state.preset ? ` (from ${state.preset})` : ''}\n${json}`);
    },
    reset: () => {
      Object.assign(target, baseline());
      changed();
    },
  };
  folder.add(actions, 'copyJson').name('copy JSON');
  folder.add(actions, 'reset').name('reset to default');
  refresh();
  return folder;
}
