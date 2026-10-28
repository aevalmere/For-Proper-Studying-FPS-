import { describe, expect, it } from 'vitest';
import { SETTINGS_REVISION, defaultSettings, mergeSettings, migrateSettings } from './settings.ts';

describe('settings', () => {
  it('opposite movement keys cancel out by default', () => {
    expect(defaultSettings('high').opposingKeys).toBe('cancel');
  });

  it('merges only saved keys of the right type and enum value', () => {
    const d = defaultSettings('high');
    const s = mergeSettings(d, { sensitivity: 2.5, fov: 'wide', wheel: 'weapon', opposingKeys: 'nope', bogus: 1 });
    expect(s.sensitivity).toBe(2.5);
    expect(s.fov).toBe(d.fov);
    expect(s.wheel).toBe('weapon');
    expect(s.opposingKeys).toBe(d.opposingKeys);
    expect('bogus' in s).toBe(false);
  });

  it('revision 0 settings pick up the cancel default; current ones keep their choice', () => {
    const old = mergeSettings(defaultSettings('high'), { opposingKeys: 'lastWins' });
    expect(migrateSettings(old, 0).opposingKeys).toBe('cancel');
    const current = mergeSettings(defaultSettings('high'), { opposingKeys: 'lastWins' });
    expect(migrateSettings(current, SETTINGS_REVISION).opposingKeys).toBe('lastWins');
  });
});
