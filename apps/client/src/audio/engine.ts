// WebAudio playback for the synthesized sound set.
//
// Graph:  voice (gain -> stereo pan) x N -> sfx bus -> master bus -> limiter -> out
//
// - The AudioContext is created on the first user gesture (pointer or key), which
//   is what browsers require before audio may start; later gestures resume it if
//   the browser suspended it (e.g. after the tab was hidden).
// - Voices are a fixed pool of gain + pan nodes wired once; a play only creates the
//   one-shot AudioBufferSourceNode WebAudio requires. When the pool is full a new
//   sound steals the oldest voice of equal or lower priority, and each sound has a
//   minimum interval and an instance cap, so a full Splatter spray or an 8-pellet
//   Spritzer volley stays a handful of voices on a Chromebook.
// - World sounds are positioned cheaply: inverse-distance volume and a stereo pan
//   from the listener's right vector (no HRTF panner).

import type { Vec3 } from '@splat/shared';
import { type AudioSettings, VOICE_POOL } from './settings.ts';
import { SOUNDS, SOUND_IDS, synthesizeAll, type SoundId } from './sounds.ts';
import { SYNTH_RATE } from './synth.ts';

export interface PlayOptions {
  /** multiplies the sound's own gain */
  gain?: number;
  /** playback rate (pitch); the sound's random jitter is applied on top */
  rate?: number;
  /** -1 left .. 1 right */
  pan?: number;
}

interface Voice {
  gain: GainNode;
  pan: StereoPannerNode | null;
  source: AudioBufferSourceNode | null;
  sound: SoundId | null;
  priority: number;
  start: number;
  end: number;
}

/** Inverse-distance reference: full volume within this many units. */
const REF_DISTANCE = 160;
/** World sounds farther than this are not played at all. */
const MAX_DISTANCE = 4000;
/** How hard positional sounds pan (1 = fully to one ear). */
const PAN_WIDTH = 0.85;
/** Fade applied to a stolen voice before reuse, s (avoids clicks). */
const STEAL_FADE = 0.004;

type AudioContextCtor = typeof AudioContext;

function audioContextClass(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

export class AudioEngine {
  readonly settings: AudioSettings;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private readonly samples: Record<SoundId, Float32Array>;
  private buffers: Record<SoundId, AudioBuffer> | null = null;
  private readonly voices: Voice[] = [];
  private readonly lastPlay = {} as Record<SoundId, number>;
  private readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly listenerRight: Vec3 = { x: 1, y: 0, z: 0 };
  private failed = false;

  constructor(settings: AudioSettings) {
    this.settings = settings;
    this.samples = synthesizeAll();
    for (const id of SOUND_IDS) this.lastPlay[id] = -Infinity;
    for (const g of GESTURES) window.addEventListener(g, this.unlock, { capture: true, passive: true });
  }

  /** true once the context exists and is running */
  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** the context's state, or 'none' before the first gesture */
  get state(): string {
    return this.ctx?.state ?? (this.failed ? 'unavailable' : 'none');
  }

  private readonly unlock = (): void => {
    if (!this.ctx && !this.failed) this.create();
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      this.ctx.resume().catch(() => {
        // the browser refused this gesture; the next one tries again
      });
    }
  };

  private create(): void {
    const Ctor = audioContextClass();
    if (!Ctor) {
      this.failed = true;
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      console.warn('[audio] no AudioContext; playing silent', err);
      this.failed = true;
      return;
    }
    this.ctx = ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(limiter);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.applyVolumes();

    const buffers = {} as Record<SoundId, AudioBuffer>;
    for (const id of SOUND_IDS) {
      const data = this.samples[id];
      const buf = ctx.createBuffer(1, data.length, SYNTH_RATE);
      buf.getChannelData(0).set(data);
      buffers[id] = buf;
    }
    this.buffers = buffers;

    const canPan = typeof ctx.createStereoPanner === 'function';
    for (let i = 0; i < VOICE_POOL; i++) {
      const gain = ctx.createGain();
      const pan = canPan ? ctx.createStereoPanner() : null;
      if (pan) {
        gain.connect(pan);
        pan.connect(this.sfx);
      } else {
        gain.connect(this.sfx);
      }
      this.voices.push({ gain, pan, source: null, sound: null, priority: 0, start: 0, end: 0 });
    }
  }

  /** Push the volume settings into the mixer (call after the panel changes them). */
  applyVolumes(): void {
    if (!this.ctx || !this.master || !this.sfx) return;
    const t = this.ctx.currentTime;
    const m = Math.max(0, Math.min(1, this.settings.masterVolume));
    const s = Math.max(0, Math.min(1, this.settings.sfxVolume));
    this.master.gain.setTargetAtTime(m * m, t, 0.02);
    this.sfx.gain.setTargetAtTime(s * s, t, 0.02);
  }

  /** Listener for positional sounds: ear position and the view's right vector. */
  setListener(pos: Vec3, right: Vec3): void {
    this.listenerPos.x = pos.x;
    this.listenerPos.y = pos.y;
    this.listenerPos.z = pos.z;
    this.listenerRight.x = right.x;
    this.listenerRight.y = right.y;
    this.listenerRight.z = right.z;
  }

  /** Play a non-positional sound. Returns false if it was skipped (not started, rate-limited, no free voice). */
  play(id: SoundId, opts?: PlayOptions): boolean {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.buffers) return false;
    const def = SOUNDS[id];
    const now = ctx.currentTime;
    if (now - this.lastPlay[id] < def.minIntervalMs / 1000) return false;

    const limit = Math.max(1, Math.min(VOICE_POOL, Math.round(this.settings.maxVoices)));
    let free: Voice | null = null;
    let oldestSame: Voice | null = null;
    let sameCount = 0;
    let victim: Voice | null = null;
    for (let i = 0; i < limit; i++) {
      const v = this.voices[i]!;
      if (v.end <= now) {
        free ??= v;
        continue;
      }
      if (v.sound === id) {
        sameCount++;
        if (!oldestSame || v.start < oldestSame.start) oldestSame = v;
      }
      if (v.priority <= def.priority && (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.start < victim.start))) {
        victim = v;
      }
    }
    // too many copies of this sound: replace its oldest copy; else a free voice; else steal
    const voice = sameCount >= def.maxInstances ? oldestSame : (free ?? victim);
    if (!voice) return false;

    let when = now;
    const g = voice.gain.gain;
    g.cancelScheduledValues(now);
    if (voice.source && voice.end > now) {
      // fade out what this voice was playing, then start the new sound
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + STEAL_FADE);
      try {
        voice.source.stop(now + STEAL_FADE);
      } catch {
        // already stopped
      }
      when = now + STEAL_FADE;
    }

    const rate = Math.max(0.25, (opts?.rate ?? 1) * (1 + (Math.random() * 2 - 1) * def.rateJitter));
    const buffer = this.buffers[id];
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(voice.gain);
    g.setValueAtTime(def.gain * (opts?.gain ?? 1), when);
    if (voice.pan) voice.pan.pan.setValueAtTime(Math.max(-1, Math.min(1, opts?.pan ?? 0)), when);
    src.start(when);

    voice.source = src;
    voice.sound = id;
    voice.priority = def.priority;
    voice.start = when;
    voice.end = when + buffer.duration / rate;
    this.lastPlay[id] = now;
    return true;
  }

  /** Play a sound at a world position: quieter with distance, panned toward its side. */
  playAt(id: SoundId, pos: Vec3, gain = 1, rate = 1): boolean {
    if (!this.running) return false;
    const dx = pos.x - this.listenerPos.x;
    const dy = pos.y - this.listenerPos.y;
    const dz = pos.z - this.listenerPos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > MAX_DISTANCE) return false;
    const atten = REF_DISTANCE / Math.max(REF_DISTANCE, d);
    const r = this.listenerRight;
    const pan = d > 1 ? ((dx * r.x + dy * r.y + dz * r.z) / d) * PAN_WIDTH : 0;
    return this.play(id, { gain: gain * atten, rate, pan });
  }

  dispose(): void {
    for (const g of GESTURES) window.removeEventListener(g, this.unlock, { capture: true });
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.buffers = null;
    this.voices.length = 0;
  }
}
