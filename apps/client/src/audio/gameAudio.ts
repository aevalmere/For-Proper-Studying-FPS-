// Game sound cues on top of the AudioEngine: what to play for a shot, a hit, a
// splat, a jump or a landing. Called from the shooting system's tick, so every
// cue lines up with the sim event that caused it.

import type GUI from 'lil-gui';
import type * as THREE from 'three';
import { lengthXZ, type PlayerState, type Vec3, type WeaponId } from '@splat/shared';
import { addTunables } from '../dev/tuning.ts';
import { AudioEngine } from './engine.ts';
import { AUDIO_DEFAULTS, AUDIO_META, type AudioSettings } from './settings.ts';
import type { SoundId } from './sounds.ts';

const FIRE_SOUND: Record<WeaponId, SoundId> = {
  splatter: 'fireSplatter',
  lobber: 'fireLobber',
  spritzer: 'fireSpritzer',
};

/** The hit streak (rising pitch) resets after this long without a hit, s. */
const STREAK_RESET = 0.9;
/** Pitch stops rising after this many consecutive hits. */
const STREAK_CAP = 12;
/** Landings slower than this (step-downs) are silent, u/s. */
const LAND_MIN = 120;
/** Landing speed for the loudest, deepest thud, u/s. */
const LAND_FULL = 650;
/** Footsteps only above this fraction of max speed (Shift-walking is quiet). */
const RUN_FRACTION = 0.6;
/** Distance between footsteps, u. */
const STRIDE = 76;

const camRight = { x: 1, y: 0, z: 0 };
const camPos = { x: 0, y: 0, z: 0 };

export class GameAudio {
  readonly engine: AudioEngine;
  readonly settings: AudioSettings = { ...AUDIO_DEFAULTS };
  readonly folder: GUI;
  private streak = 0;
  private sinceHit = Infinity;
  private stride = 0;
  private altStep = false;

  constructor(gui: GUI) {
    this.engine = new AudioEngine(this.settings);
    this.folder = addTunables(gui, 'Audio', this.settings, AUDIO_META, {
      storageKey: 'splat.audio',
      onChange: () => this.engine.applyVolumes(),
    });
  }

  /** Once per tick, before any cues for that tick. */
  tick(dt: number): void {
    this.sinceHit += dt;
  }

  fire(weapon: WeaponId): void {
    this.engine.play(FIRE_SOUND[weapon]);
  }

  dryFire(): void {
    this.engine.play('dryFire');
  }

  /** The local player's balls hit a target this tick (call once per tick, not per ball). */
  targetHit(): void {
    this.streak = this.sinceHit < STREAK_RESET ? Math.min(STREAK_CAP, this.streak + 1) : 0;
    this.sinceHit = 0;
    this.engine.play('hit', { rate: Math.pow(2, (this.streak * this.settings.hitPitchStep) / 12) });
  }

  /** A hit of ours filled a target's paint meter. */
  splatted(): void {
    this.engine.play('splat');
  }

  /** A ball splatted on the world at `pos`. */
  worldSplat(pos: Vec3): void {
    this.engine.playAt('worldSplat', pos);
  }

  /** Jump, landing and footstep cues from the local player's tick flags. */
  movement(p: PlayerState, maxSpeed: number, dt: number): void {
    if (p.jumped) this.engine.play('jump');
    if (p.landSpeed > LAND_MIN) {
      const k = Math.min(1, (p.landSpeed - LAND_MIN) / (LAND_FULL - LAND_MIN));
      this.engine.play('land', { gain: 0.3 + 0.7 * k, rate: 1.12 - 0.25 * k });
      this.stride = 0;
    }
    if (!this.settings.footsteps || !p.onGround) return;
    const speed = lengthXZ(p.vel);
    if (speed < maxSpeed * RUN_FRACTION) {
      // the first step after breaking into a run comes quickly
      this.stride = Math.min(this.stride, STRIDE * 0.5);
      return;
    }
    this.stride += speed * dt;
    if (this.stride >= STRIDE) {
      this.stride -= STRIDE;
      this.engine.play(this.altStep ? 'step2' : 'step1', { gain: 0.6 + 0.4 * Math.min(1, speed / maxSpeed) });
      this.altStep = !this.altStep;
    }
  }

  /** Once per frame: positional sounds are heard from the camera. */
  updateListener(camera: THREE.Camera): void {
    const e = camera.matrixWorld.elements;
    camPos.x = e[12]!;
    camPos.y = e[13]!;
    camPos.z = e[14]!;
    camRight.x = e[0]!;
    camRight.y = e[1]!;
    camRight.z = e[2]!;
    this.engine.setListener(camPos, camRight);
  }

  dispose(): void {
    this.engine.dispose();
    this.folder.destroy();
  }
}
