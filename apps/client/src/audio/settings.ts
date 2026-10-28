// Mixer settings for the dev panel's "Audio" folder (persisted under `splat.audio`).

import type { TunableMeta } from '@splat/shared';

export interface AudioSettings {
  /** overall volume, 0..1 (applied squared, so the slider feels even) */
  masterVolume: number;
  /** game sound effects, 0..1 (applied squared) */
  sfxVolume: number;
  /** footsteps while running; walking with Shift stays quiet either way */
  footsteps: boolean;
  /** most sounds playing at once; a new sound steals the oldest of equal or lower priority */
  maxVoices: number;
  /** semitones the hit sound rises per consecutive hit */
  hitPitchStep: number;
}

export const AUDIO_DEFAULTS: AudioSettings = {
  masterVolume: 0.8,
  sfxVolume: 0.85,
  footsteps: false,
  maxVoices: 14,
  hitPitchStep: 1,
};

export const AUDIO_META: Partial<Record<keyof AudioSettings, TunableMeta>> = {
  masterVolume: { min: 0, max: 1, step: 0.01, label: 'master volume' },
  sfxVolume: { min: 0, max: 1, step: 0.01, label: 'sfx volume' },
  footsteps: { min: 0, max: 1, step: 1, label: 'footsteps' },
  maxVoices: { min: 4, max: 32, step: 1, label: 'max voices' },
  hitPitchStep: { min: 0, max: 3, step: 0.1, label: 'hit pitch rise (semitones)' },
};

/** Voice pool size; `maxVoices` can't exceed it. */
export const VOICE_POOL = 32;
