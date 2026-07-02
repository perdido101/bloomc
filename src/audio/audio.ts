import { TUNING } from '../game/difficulty';
import type { PhaseId } from '../game/phases';

/**
 * Audio stubs (§11). A 92 BPM internal clock drives onBeat() so all
 * music-reactive visuals read from the same hook a real track will later
 * replace. SFX are soft WebAudio sine/triangle placeholder blips — no harsh
 * squares. The beat clock runs on performance time so visuals pulse even
 * before the AudioContext is unlocked (or with sound off).
 */

export type SfxName =
  | 'jump' | 'dash' | 'land' | 'skim' | 'mote'
  | 'hazard' | 'bloom' | 'death' | 'newbest';

type BeatCb = (beatIndex: number) => void;

class AudioSys {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private beatCbs: BeatCb[] = [];
  private beatIndex = 0;
  private nextBeatAt = 0;
  private phase: PhaseId = 'GLACIA';

  /** call from a user gesture to unlock WebAudio */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  setPhase(id: PhaseId): void {
    this.phase = id;
  }

  onBeat(cb: BeatCb): void {
    this.beatCbs.push(cb);
  }

  /** drive from the game loop; fires beat callbacks on the 92 BPM grid */
  update(nowMs: number): void {
    const interval = 60000 / TUNING.BEAT_BPM;
    if (this.nextBeatAt === 0) this.nextBeatAt = nowMs + interval;
    while (nowMs >= this.nextBeatAt) {
      this.nextBeatAt += interval;
      this.beatIndex++;
      for (const cb of this.beatCbs) cb(this.beatIndex);
    }
  }

  private tone(
    f0: number,
    f1: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    delay = 0
  ): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  playSfx(name: SfxName): void {
    if (!this.ctx || !this.enabled) return;
    // slight per-phase color: INFERNA a touch brighter, GLACIA softer
    const up = this.phase === 'INFERNA' ? 1.12 : this.phase === 'GLACIA' ? 0.94 : 1;
    switch (name) {
      case 'jump':
        this.tone(320 * up, 540 * up, 0.13, 'sine', 0.5);
        break;
      case 'dash':
        this.tone(760 * up, 190, 0.16, 'triangle', 0.55);
        this.tone(1400, 300, 0.1, 'sine', 0.2);
        break;
      case 'land':
        this.tone(190, 120, 0.09, 'sine', 0.4);
        break;
      case 'skim':
        this.tone(660 * up, 660 * up, 0.07, 'triangle', 0.4);
        this.tone(990 * up, 990 * up, 0.09, 'sine', 0.3, 0.04);
        break;
      case 'mote':
        this.tone(880, 880, 0.12, 'sine', 0.35);
        this.tone(1320, 1320, 0.18, 'sine', 0.22, 0.03);
        break;
      case 'hazard':
        this.tone(300, 90, 0.3, 'triangle', 0.5);
        break;
      case 'bloom':
        this.tone(220, 440, 1.4, 'sine', 0.3);
        this.tone(330, 660, 1.4, 'sine', 0.2, 0.1);
        this.tone(440, 880, 1.2, 'triangle', 0.12, 0.2);
        break;
      case 'death':
        this.tone(420, 60, 0.9, 'triangle', 0.5);
        this.tone(210, 40, 1.1, 'sine', 0.4, 0.05);
        break;
      case 'newbest':
        for (let i = 0; i < 5; i++) {
          const f = 440 * Math.pow(2, [0, 4, 7, 12, 16][i] / 12);
          this.tone(f, f, 0.25, 'triangle', 0.3, i * 0.09);
        }
        break;
    }
  }
}

export const audio = new AudioSys();
