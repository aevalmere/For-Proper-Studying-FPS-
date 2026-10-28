// Dev panel: Movement tuning, persisted client Settings, and sandbox helpers.
// Other systems add their own folders to ctx.gui after this is built.

import type GUI from 'lil-gui';
import { MOVEMENT_CONFIG_META, MOVEMENT_PRESETS, type MapTeleport, type MovementConfig } from '@splat/shared';
import { defaultSettings, SETTINGS_OPTIONS, SETTINGS_RANGES, saveSettings, type ClientSettings } from '../settings.ts';
import { addTunables } from './tuning.ts';

export interface PanelHooks {
  /** apply a changed setting to the running game */
  settingChanged(key: keyof ClientSettings): void;
  respawn(): void;
  fullscreen(): void;
  /** antialias the current context was created with */
  antialias: boolean;
  lowLatency: boolean;
}

export interface DevPanel {
  /** re-read every Settings control (after code changed a setting) */
  refresh(): void;
}

export function buildDevPanel(
  gui: GUI,
  movement: MovementConfig,
  s: ClientSettings,
  teleports: readonly MapTeleport[],
  hooks: PanelHooks,
): DevPanel {
  addTunables(gui, 'Movement', movement, MOVEMENT_CONFIG_META, {
    storageKey: 'splat.movement',
    presets: MOVEMENT_PRESETS,
  });

  const settings = gui.addFolder('Settings');
  const note = { text: '' };
  const changed = (key: keyof ClientSettings) => () => {
    saveSettings(s);
    hooks.settingChanged(key);
    reloadNote();
  };
  const num = (f: GUI, key: keyof ClientSettings, label: string) => {
    const r = SETTINGS_RANGES[key]!;
    return f.add(s, key, r.min, r.max, r.step).name(label).onChange(changed(key));
  };
  const bool = (f: GUI, key: keyof ClientSettings, label: string) => f.add(s, key).name(label).onChange(changed(key));

  const mouse = settings.addFolder('Mouse and keys');
  num(mouse, 'sensitivity', 'sensitivity (CS)');
  bool(mouse, 'invertY', 'invert Y');
  bool(mouse, 'rawInput', 'raw input (next lock)');
  mouse.add(s, 'wheel', { 'jump (scroll bhop)': 'jump', 'cycle weapon': 'weapon' }).name('mouse wheel').onChange(changed('wheel'));
  mouse
    .add(s, 'opposingKeys', { 'last pressed wins': 'lastWins', 'cancel out': 'cancel' })
    .name('A+D / W+S held')
    .onChange(changed('opposingKeys'));
  bool(mouse, 'ctrlCrouch', 'Ctrl crouch (fullscreen)');

  const view = settings.addFolder('View');
  num(view, 'fov', 'FOV (CS, 4:3)');
  view.add(s, 'quality', SETTINGS_OPTIONS.quality).name('quality').onChange(changed('quality'));
  num(view, 'renderScale', 'render scale');
  bool(view, 'adaptiveResolution', 'auto-lower resolution');
  bool(view, 'lowLatency', 'low-latency canvas');
  num(view, 'gridStrength', 'grid');
  const noteCtl = view.add(note, 'text').name('note').disable();

  const ch = settings.addFolder('Crosshair');
  num(ch, 'crosshairSize', 'length');
  num(ch, 'crosshairGap', 'gap');
  num(ch, 'crosshairThickness', 'thickness');
  ch.addColor(s, 'crosshairColor').name('color').onChange(changed('crosshairColor'));
  bool(ch, 'crosshairOutline', 'outline');
  bool(ch, 'crosshairDot', 'center dot');
  bool(ch, 'dynamicCrosshair', 'dynamic (shows spread)');

  const hud = settings.addFolder('HUD');
  bool(hud, 'showFps', 'FPS');
  bool(hud, 'showDebug', 'debug line');
  bool(hud, 'perfGraph', 'frame graph (F2)');

  settings
    .add(
      {
        reset: () => {
          const keep = s.quality;
          Object.assign(s, defaultSettings(keep));
          settings.controllersRecursive().forEach((c) => c.updateDisplay());
          saveSettings(s);
          for (const k of Object.keys(s) as (keyof ClientSettings)[]) hooks.settingChanged(k);
          reloadNote();
        },
      },
      'reset',
    )
    .name('reset settings');

  function reloadNote(): void {
    const aaWanted = s.quality === 'high';
    const pending: string[] = [];
    if (aaWanted !== hooks.antialias) pending.push('antialias');
    if (s.lowLatency !== hooks.lowLatency) pending.push('low-latency');
    note.text = pending.length ? `reload to apply ${pending.join(' + ')}` : '';
    noteCtl.updateDisplay();
    noteCtl.show(pending.length > 0);
  }
  reloadNote();
  settings.close();

  const sandbox = gui.addFolder('Sandbox');
  const tpOptions: Record<string, number> = {};
  teleports.forEach((t, i) => (tpOptions[t.name] = i));
  sandbox.add(s, 'spawnAt', tpOptions).name('respawn at').onChange(() => {
    saveSettings(s);
    hooks.respawn();
  });
  sandbox.add({ respawn: hooks.respawn }, 'respawn').name('respawn (R)');
  sandbox.add({ fullscreen: hooks.fullscreen }, 'fullscreen').name('fullscreen + keyboard lock');

  return {
    refresh: () => settings.controllersRecursive().forEach((c) => c.updateDisplay()),
  };
}
