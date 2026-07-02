import { TUNING } from '../game/difficulty';
import type { PhaseId } from '../game/phases';

/**
 * Audio (§11 + menu/music extension).
 *
 * - A 92 BPM internal clock drives onBeat() so all music-reactive visuals
 *   read from the same hook a real track could replace.
 * - SFX are soft sine/triangle blips — no harsh squares.
 * - MUSIC is fully synthesized in WebAudio, two scenes:
 *     menu — serene, classical: slow arpeggiated chords, music-box plucks,
 *            soft detuned pads, long echo.
 *     game — psychedelic: pentatonic 8th-note arps over a breathing lowpass,
 *            sub-bass on the beat grid.
 *   It adapts to the game: every Bloom re-keys the scale from the new
 *   palette's base hue (pattern change = key change), note density and
 *   filter movement grow with the surrealism tier, Lulls thin it out.
 * The beat clock runs on performance time so visuals pulse even with sound
 * off; the synth scheduler runs on AudioContext time with lookahead.
 */

export type SfxName =
  | 'jump' | 'dash' | 'land' | 'skim' | 'mote'
  | 'grab' | 'hazard' | 'bloom' | 'death' | 'newbest' | 'tier';

export type MusicScene = 'menu' | 'game';

type BeatCb = (beatIndex: number) => void;

const PENTA = [0, 3, 5, 7, 10, 12, 15];
/** aeolian-ish progression roots, in semitones from the key root */
const PROGRESSION = [0, 8, 5, 3];
const CHORD = [0, 3, 7, 12];

class AudioSys {
  enabled = true;       // sfx
  musicEnabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private beatCbs: BeatCb[] = [];
  private beatIndex = 0;
  private nextBeatAt = 0;
  private phase: PhaseId = 'GLACIA';

  // --- music state ---
  private scene: MusicScene = 'menu';
  private rootMidi = 57;    // A3; re-keyed each Bloom from the palette hue
  private density = 0;      // 0..4 from tier
  private lull = false;
  private stepIdx = 0;
  private nextStepAt = 0;

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

      // music bus: gain → breathing lowpass → feedback echo → master
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.5;
      this.musicFilter = this.ctx.createBiquadFilter();
      this.musicFilter.type = 'lowpass';
      this.musicFilter.frequency.value = 1400;
      this.musicFilter.Q.value = 0.8;
      const delay = this.ctx.createDelay(1.0);
      delay.delayTime.value = (60 / TUNING.BEAT_BPM) * 0.75; // dotted-8th echo
      const fb = this.ctx.createGain();
      fb.gain.value = 0.34;
      const wet = this.ctx.createGain();
      wet.gain.value = 0.4;
      this.musicBus.connect(this.musicFilter);
      this.musicFilter.connect(this.master);
      this.musicFilter.connect(delay);
      delay.connect(fb).connect(delay);
      delay.connect(wet).connect(this.master);
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

  setScene(scene: MusicScene): void {
    if (this.scene === scene) return;
    this.scene = scene;
    this.stepIdx = 0; // restart the pattern on the next bar
  }

  /** re-key the music from the current Bloom's DNA — pattern change = key change */
  setMusicKey(baseHueDeg: number, tier: number, lull: boolean): void {
    this.rootMidi = 55 + (Math.round(baseHueDeg / 30) % 12); // G3..F#4
    this.density = Math.min(4, tier);
    this.lull = lull;
  }

  onBeat(cb: BeatCb): void {
    this.beatCbs.push(cb);
  }

  /** drive from the game loop; fires beats + schedules the synth */
  update(nowMs: number): void {
    const interval = 60000 / TUNING.BEAT_BPM;
    if (this.nextBeatAt === 0) this.nextBeatAt = nowMs + interval;
    while (nowMs >= this.nextBeatAt) {
      this.nextBeatAt += interval;
      this.beatIndex++;
      for (const cb of this.beatCbs) cb(this.beatIndex);
    }
    this.scheduleMusic();
  }

  /* ------------------------------------------------------------ */
  /*  generative music                                              */
  /* ------------------------------------------------------------ */

  private scheduleMusic(): void {
    if (!this.ctx || !this.musicBus || !this.musicEnabled || this.ctx.state !== 'running') return;
    const ct = this.ctx.currentTime;
    const stepDur = 60 / TUNING.BEAT_BPM / 2; // 8th notes
    if (this.nextStepAt < ct - 0.5) this.nextStepAt = ct + 0.06; // resync
    while (this.nextStepAt < ct + 0.35) {
      this.scheduleStep(this.stepIdx++, this.nextStepAt, stepDur);
      this.nextStepAt += stepDur;
    }
  }

  private midiHz(m: number): number {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  private scheduleStep(step: number, t: number, stepDur: number): void {
    const bar = Math.floor(step / 8);          // 8 eighth-notes per bar
    const inBar = step % 8;
    const chordRoot = this.rootMidi + PROGRESSION[bar % PROGRESSION.length];
    // deterministic-but-winding melodic index
    const mseq = (step * 5 + bar * 3 + this.rootMidi) % 7;

    if (this.scene === 'menu') {
      // serene: quarter-note music-box arpeggio + a pad each bar
      if (inBar % 2 === 0) {
        const tone = CHORD[(step >> 1) % CHORD.length];
        this.pluck(this.midiHz(chordRoot + 12 + tone), t, 0.16, 1.6);
      }
      if (inBar === 0) {
        this.pad(this.midiHz(chordRoot), t, stepDur * 8);
        if (bar % 2 === 1) this.pluck(this.midiHz(chordRoot + 24 + PENTA[mseq % 5]), t, 0.08, 2.2);
      }
      this.moveFilter(t, 1100 + 300 * Math.sin(step * 0.11));
      return;
    }

    // game: psychedelic — density-gated pentatonic arp + sub-bass pulse
    const gate = this.lull ? [0, 4] : GATES[this.density];
    if (gate.includes(inBar)) {
      const note = chordRoot + 12 + PENTA[mseq % PENTA.length];
      this.pluck(this.midiHz(note), t, 0.14 + 0.015 * this.density, 0.5);
      if (this.density >= 3 && inBar % 2 === 1) {
        this.pluck(this.midiHz(note + 7), t + stepDur * 0.5, 0.07, 0.35);
      }
    }
    if (inBar === 0 || (this.density >= 2 && inBar === 4)) {
      this.bass(this.midiHz(chordRoot - 12), t, this.lull ? 0.12 : 0.2);
    }
    if (inBar === 0 && bar % 4 === 0 && !this.lull) {
      this.pad(this.midiHz(chordRoot + 7), t, stepDur * 10);
    }
    // breathing lowpass — wider and faster the deeper you go
    const sweep = 700 + (900 + 350 * this.density) * (0.5 + 0.5 * Math.sin(step * (0.13 + 0.02 * this.density)));
    this.moveFilter(t, this.lull ? 900 : sweep);
  }

  private moveFilter(t: number, hz: number): void {
    this.musicFilter?.frequency.setTargetAtTime(hz, t, 0.12);
  }

  private pluck(freq: number, t: number, vel: number, dur: number): void {
    if (!this.ctx || !this.musicBus) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    osc.connect(g).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private pad(freq: number, t: number, dur: number): void {
    if (!this.ctx || !this.musicBus) return;
    for (const det of [-4, 3]) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.setValueAtTime(det, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.musicBus);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }

  private bass(freq: number, t: number, vel: number): void {
    if (!this.ctx || !this.musicBus) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.4);
    osc.connect(g).connect(this.musicBus);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  /* ------------------------------------------------------------ */
  /*  sfx                                                           */
  /* ------------------------------------------------------------ */

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
      case 'grab':
        this.tone(240, 320, 0.07, 'sine', 0.4);
        this.tone(520, 520, 0.06, 'triangle', 0.2, 0.05);
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
      case 'tier':
        for (let i = 0; i < 4; i++) {
          const f = 330 * Math.pow(2, [0, 5, 9, 14][i] / 12);
          this.tone(f, f * 1.01, 0.3, 'sine', 0.28, i * 0.11);
        }
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

/** which 8th-note slots play the arp, per density tier 0..4 */
const GATES: number[][] = [
  [0, 3, 4],
  [0, 2, 3, 6],
  [0, 2, 3, 4, 6],
  [0, 1, 2, 3, 4, 6],
  [0, 1, 2, 3, 4, 5, 6, 7],
];

export const audio = new AudioSys();
