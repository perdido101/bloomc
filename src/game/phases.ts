import { TUNING } from './difficulty';

export type PhaseId = 'GLACIA' | 'NEBULA' | 'INFERNA' | 'VERDANT';

export interface PhaseDef {
  id: PhaseId;
  /** palette LUT gradient stops, dark → bright */
  stops: string[];
  mirrorN: number;
  speedMul: number;
  hazardMul: number;
  /** added to platform coverage; positive = friendlier */
  coverageAdd: number;
  feel: string;
}

export const PHASES: PhaseDef[] = [
  {
    id: 'GLACIA',
    stops: ['#0b1440', '#27c8f0', '#eaffff', '#c9b8ff'],
    mirrorN: 8,
    speedMul: 0.85,
    hazardMul: 0.7,
    coverageAdd: 0.04,
    feel: 'serene, slow',
  },
  {
    id: 'NEBULA',
    stops: ['#241a52', '#d633c8', '#3f6cff', '#ffdcf2'],
    mirrorN: 6,
    speedMul: 1.0,
    hazardMul: 0.9,
    coverageAdd: 0.0,
    feel: 'dreamy, drifting',
  },
  {
    id: 'INFERNA',
    stops: ['#200004', '#d40f33', '#ff7a1a', '#ffe9b0'],
    mirrorN: 12,
    speedMul: 1.25,
    hazardMul: 1.3,
    coverageAdd: -0.05,
    feel: 'intense, fast',
  },
  {
    id: 'VERDANT',
    stops: ['#032c2c', '#0fae6e', '#b8e62e', '#f4ffe8'],
    mirrorN: 10,
    speedMul: 1.1,
    hazardMul: 1.05,
    coverageAdd: -0.02,
    feel: 'alien, pulsing',
  },
];

export interface BloomEvents {
  /** countdown glyph appears (5s before the bloom) */
  onCountdown?: () => void;
  /** transition begins (visual crossfade starts) */
  onBloomStart?: (from: PhaseDef, to: PhaseDef) => void;
  /** transition midpoint: collision mirror-count switches, rotations flip */
  onBloomMid?: (to: PhaseDef) => void;
  /** transition ends: bloom survived */
  onBloomEnd?: (bloomsSurvived: number) => void;
}

/**
 * Tracks run time, drives the phase cycle and Bloom transitions.
 * A bloom fires every BLOOM_PERIOD_S; the transition lasts BLOOM_TRANSITION_S
 * during which gameplay continues.
 */
export class PhaseManager {
  runTime = 0;
  /** completed blooms (also indexes the phase cycle) */
  bloomsDone = 0;
  /** -1 idle, else 0..1 progress through the transition */
  transitionT = -1;
  /** seconds until next bloom if within countdown window, else -1 */
  countdown = -1;
  /** flips each bloom: ring rotation direction + global view rotation */
  dirFlip = 1;
  private midFired = false;
  private countdownFired = false;
  private events: BloomEvents;

  constructor(events: BloomEvents = {}) {
    this.events = events;
  }

  reset(): void {
    this.runTime = 0;
    this.bloomsDone = 0;
    this.transitionT = -1;
    this.countdown = -1;
    this.dirFlip = 1;
    this.midFired = false;
    this.countdownFired = false;
  }

  get current(): PhaseDef {
    return PHASES[this.bloomsDone % PHASES.length];
  }

  get next(): PhaseDef {
    return PHASES[(this.bloomsDone + 1) % PHASES.length];
  }

  get cycle(): number {
    return Math.floor(this.bloomsDone / PHASES.length);
  }

  /** global +8% intensity per full 4-phase cycle */
  get intensity(): number {
    return Math.pow(TUNING.CYCLE_INTENSITY_GAIN, this.cycle);
  }

  get inTransition(): boolean {
    return this.transitionT >= 0;
  }

  /** wedge width used for collision (switches at transition midpoint) */
  get collisionMirrorN(): number {
    if (this.inTransition && this.transitionT >= 0.5) return this.next.mirrorN;
    return this.current.mirrorN;
  }

  /** 0..1 palette/mirror crossfade amount */
  get mix(): number {
    return this.inTransition ? this.transitionT : 0;
  }

  /** extra rotation speed during the transition (world accelerates) */
  get transitionSpeedBoost(): number {
    if (!this.inTransition) return 1;
    return 1 + 0.8 * Math.sin(Math.PI * this.transitionT);
  }

  update(dt: number): void {
    this.runTime += dt;
    const period = TUNING.BLOOM_PERIOD_S;
    const bloomAt = period * (this.bloomsDone + 1);

    if (this.transitionT < 0) {
      const until = bloomAt - this.runTime;
      if (until <= TUNING.BLOOM_COUNTDOWN_S && until > 0) {
        this.countdown = until;
        if (!this.countdownFired) {
          this.countdownFired = true;
          this.events.onCountdown?.();
        }
      } else {
        this.countdown = -1;
      }
      if (this.runTime >= bloomAt) {
        this.transitionT = 0;
        this.midFired = false;
        this.events.onBloomStart?.(this.current, this.next);
      }
    } else {
      this.transitionT += dt / TUNING.BLOOM_TRANSITION_S;
      if (this.transitionT >= 0.5 && !this.midFired) {
        this.midFired = true;
        this.dirFlip = -this.dirFlip;
        this.events.onBloomMid?.(this.next);
      }
      if (this.transitionT >= 1) {
        this.transitionT = -1;
        this.countdownFired = false;
        this.bloomsDone++;
        this.events.onBloomEnd?.(this.bloomsDone);
      }
    }
  }
}
