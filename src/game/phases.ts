import { TUNING } from './difficulty';
import { XorShift, hashSeed } from './rings';

/**
 * Addendum 1: Infinite Pattern DNA. The fixed phase table is gone — every
 * Bloom generates a PhaseDNA from the run's seeded *visual* RNG stream
 * (separate from the layout stream, so visual rerolls never change platform
 * layouts for a given seed). A constraint solver (sanitize) enforces
 * readability and fairness; a visual-load budget per escalation tier keeps
 * late-run chaos earned, not accidental.
 */

export type Vec3 = [number, number, number];
export type Harmony = 'analogous' | 'complementary' | 'triadic' | 'splitComp' | 'fullSpectrum';
export type LuminanceProfile = 'darkCore' | 'brightCore' | 'dualPole';
export type NoiseType = 'fbm' | 'ridged' | 'curl' | 'voronoiFlow' | 'domainWarp2x';
export type TexBlendMode = 'mix' | 'screen' | 'overlay' | 'difference';
export type PlatformStyle = 'crystal' | 'petal' | 'wave' | 'filament';
export type HazardStyle = 'spike' | 'thorn' | 'razorPetal' | 'ember';
export type PhaseId = 'GLACIA' | 'NEBULA' | 'INFERNA' | 'VERDANT';
export type RuleBreakerType = 'mirrorStrobe' | 'fisheyeInvert' | 'diffBlend';

export const TEX_IDS: PhaseId[] = ['GLACIA', 'NEBULA', 'INFERNA', 'VERDANT'];

export interface PaletteGenome {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  d: Vec3;
  harmony: Harmony;
  baseHue: number;        // 0–360
  hueDriftSpeed: number;  // deg/s — the whole palette rotates hue live
  luminanceProfile: LuminanceProfile;
}

export interface PhaseDNA {
  palette: PaletteGenome;
  // symmetry
  mirrorN: number;
  mirrorTwist: number;    // rad per mirror copy → spiral galaxies
  nestedKaleido: boolean; // tier 3+: background is a second kaleidoscope
  // motion
  ringSpeedMult: number;
  rotationDrift: number;  // whole-view rotation speed (signed)
  wobble: { amp: number; freq: number }; // radial breathing, frac of spacing
  spiralFlow: number;     // 0–1 platforms migrate within their band (cosmetic)
  // pattern / texture
  noiseType: NoiseType;
  noiseScale: number;
  warpStrength: number;
  texBlendMode: TexBlendMode;
  texDriftSpeed: number;
  flowFeedback: number;
  texId: PhaseId;         // which source texture pair (§9 system unchanged)
  // shape language
  platformStyle: PlatformStyle;
  hazardStyle: HazardStyle;
  // gameplay
  gapScale: number;
  hazardDensity: number;
  bloomPeriodS: number;
  layoutStyle: 'even-gaps' | 'cluster' | 'staircase-drift';
  lull: boolean;
  // bookkeeping
  tier: number;
  index: number;
  visualLoad: number;
}

/* ------------------------------------------------------------------ */
/*  Palette genome generation (cosine gradient palettes, IQ form)       */
/* ------------------------------------------------------------------ */

const HARMONIES: Harmony[] = ['analogous', 'complementary', 'triadic', 'splitComp'];

export function cosPalette(g: PaletteGenome, t: number, out: Vec3): void {
  for (let i = 0; i < 3; i++) {
    out[i] = g.a[i] + g.b[i] * Math.cos(Math.PI * 2 * (g.c[i] * t + g.d[i]));
  }
}

function luminance(r: number, gg: number, b: number): number {
  return 0.2126 * r + 0.7152 * gg + 0.0722 * b;
}

/**
 * Enforce luminance bounds: the LUT must hit ≥0.9 somewhere (highlights
 * sing under bloom) and ≤0.12 somewhere (depth). Affine-rescale a/b —
 * enforced exactly, not hoped for.
 */
function enforceLuminance(g: PaletteGenome): void {
  const tmp: Vec3 = [0, 0, 0];
  let lmin = Infinity;
  let lmax = -Infinity;
  for (let i = 0; i < 64; i++) {
    cosPalette(g, i / 63, tmp);
    const l = luminance(
      Math.min(1, Math.max(0, tmp[0])),
      Math.min(1, Math.max(0, tmp[1])),
      Math.min(1, Math.max(0, tmp[2]))
    );
    lmin = Math.min(lmin, l);
    lmax = Math.max(lmax, l);
  }
  const span = Math.max(0.05, lmax - lmin);
  const scale = Math.min(2.5, (0.95 - 0.08) / span);
  const offset = 0.08 - lmin * scale;
  for (let i = 0; i < 3; i++) {
    g.a[i] = g.a[i] * scale + offset;
    g.b[i] = g.b[i] * scale;
  }
}

export function generateGenome(rng: XorShift, tier: number, lull: boolean): PaletteGenome {
  let harmony: Harmony =
    tier >= 2 && rng.next() < 0.15
      ? 'fullSpectrum'
      : HARMONIES[Math.floor(rng.next() * HARMONIES.length)];
  const profiles: LuminanceProfile[] = ['darkCore', 'brightCore', 'dualPole'];
  let luminanceProfile = profiles[Math.floor(rng.next() * profiles.length)];
  if (lull) {
    // lulls bias serene: narrow analogous hues, dark core
    harmony = 'analogous';
    luminanceProfile = 'darkCore';
  }

  // frequency (c) sets hue span per harmony; phase (d) staggers channels
  const j = () => 0.9 + rng.next() * 0.2; // gentle jitter
  let c: Vec3;
  let d: Vec3;
  switch (harmony) {
    case 'analogous':
      c = [0.28 * j(), 0.30 * j(), 0.26 * j()];
      d = [0.0, 0.06 + rng.next() * 0.05, 0.14 + rng.next() * 0.06];
      break;
    case 'complementary':
      c = [0.5 * j(), 0.5 * j(), 0.5 * j()];
      d = [0.0, 0.22 + rng.next() * 0.08, 0.48 + rng.next() * 0.06];
      break;
    case 'triadic':
      c = [0.66 * j(), 0.66 * j(), 0.66 * j()];
      d = [0.0, 0.33, 0.67];
      break;
    case 'splitComp':
      c = [0.55 * j(), 0.62 * j(), 0.58 * j()];
      d = [0.0, 0.38 + rng.next() * 0.06, 0.55 + rng.next() * 0.06];
      break;
    case 'fullSpectrum':
      c = [1.0, 1.0, 1.0];
      d = [0.0, 0.33, 0.67];
      break;
  }

  let a: Vec3;
  let b: Vec3;
  switch (luminanceProfile) {
    case 'darkCore':
      a = [0.38, 0.36, 0.40];
      b = [0.46, 0.44, 0.48];
      break;
    case 'brightCore':
      a = [0.58, 0.56, 0.60];
      b = [0.42, 0.40, 0.44];
      break;
    case 'dualPole':
      a = [0.5, 0.5, 0.5];
      b = [0.5, 0.5, 0.5];
      break;
  }

  const g: PaletteGenome = {
    a, b, c, d,
    harmony,
    baseHue: rng.next() * 360, // uniform: over many Blooms, the whole wheel
    hueDriftSpeed: (0.2 + rng.next() * 1.8) * (lull ? 0.5 : 1),
    luminanceProfile,
  };
  enforceLuminance(g);
  return g;
}

/* ------------------------------------------------------------------ */
/*  PhaseDNA generation + constraint solver                             */
/* ------------------------------------------------------------------ */

const NOISE_TYPES: NoiseType[] = ['fbm', 'ridged', 'curl', 'voronoiFlow', 'domainWarp2x'];
const BLEND_MODES: TexBlendMode[] = ['mix', 'screen', 'overlay', 'difference'];
const PLATFORM_STYLES: PlatformStyle[] = ['crystal', 'petal', 'wave', 'filament'];
const HAZARD_STYLES: HazardStyle[] = ['spike', 'thorn', 'razorPetal', 'ember'];
const MIRROR_SET = [5, 6, 7, 8, 9, 10, 12, 14, 16];

/** visual-load budget per tier — chaos must be earned */
const LOAD_BUDGET = [3.0, 3.8, 4.6, 5.4, 6.4];

export function visualLoad(dna: PhaseDNA): number {
  return (
    (dna.mirrorN / 16) * 1.6 +
    (dna.wobble.amp / 0.04) * 0.9 +
    (dna.warpStrength / 1.8) * 1.4 +
    (dna.flowFeedback / 0.35) * 1.1 +
    (Math.max(0, dna.ringSpeedMult - 0.8) / 1.4) * 1.0 +
    (dna.mirrorTwist / 0.15) * 0.8 +
    (dna.nestedKaleido ? 0.7 : 0)
  );
}

function pick<T>(rng: XorShift, arr: readonly T[]): T {
  return arr[Math.floor(rng.next() * arr.length)];
}

export function bloomPeriod(index: number): number {
  return Math.max(18, 45 * Math.pow(0.9, index));
}

export function tierOf(bloomsDone: number): number {
  if (bloomsDone >= 8) return 4;
  if (bloomsDone >= 6) return 3;
  if (bloomsDone >= 4) return 2;
  if (bloomsDone >= 2) return 1;
  return 0;
}

export const TIER_NAMES = [
  'THE SURFACE BLOOM',
  'THE TWISTING VEIL',
  'THE SPECTRAL FLOOD',
  'THE NESTED DEEP',
  'DEEP VORTEX',
];

export function generateDNA(
  seed: number,
  index: number,
  prev: PhaseDNA | null,
  reduceFlash: boolean
): PhaseDNA {
  const rng = new XorShift(hashSeed(`visual:${seed}:${index}`));
  const tier = tierOf(index);
  const lull = index > 0 && index % 3 === 0; // every 3rd Bloom is a breather

  // never repeat the previous Bloom's noiseType or platformStyle
  let noiseType = pick(rng, NOISE_TYPES);
  if (prev && noiseType === prev.noiseType) noiseType = pick(rng, NOISE_TYPES);
  let platformStyle = pick(rng, PLATFORM_STYLES);
  if (prev && platformStyle === prev.platformStyle) platformStyle = pick(rng, PLATFORM_STYLES);

  const dna: PhaseDNA = {
    palette: generateGenome(rng, tier, lull),
    mirrorN: pick(rng, MIRROR_SET),
    mirrorTwist: tier >= 1 ? rng.next() * 0.15 : 0,
    nestedKaleido: tier >= 3 && rng.next() < 0.5,
    ringSpeedMult: 0.8 + rng.next() * 1.4,
    rotationDrift: (rng.next() < 0.5 ? -1 : 1) * (0.008 + rng.next() * 0.02),
    wobble: { amp: tier >= 1 ? rng.next() * 0.04 : 0, freq: 0.4 + rng.next() * 1.2 },
    spiralFlow: rng.next() * Math.min(1, 0.3 + tier * 0.2),
    noiseType,
    noiseScale: 1.5 + rng.next() * 4.5,
    warpStrength: rng.next() * 1.8 * (0.4 + tier * 0.15),
    texBlendMode: tier >= 1 ? pick(rng, BLEND_MODES) : 'mix',
    texDriftSpeed: 0.5 + rng.next() * 1.5,
    flowFeedback: tier >= 2 ? rng.next() * 0.35 : 0,
    texId: pick(rng, TEX_IDS),
    platformStyle,
    hazardStyle: pick(rng, HAZARD_STYLES),
    gapScale: 0.95 + rng.next() * 0.25 + tier * 0.02,
    hazardDensity: 0.85 + rng.next() * 0.45 + tier * 0.06,
    bloomPeriodS: bloomPeriod(index),
    layoutStyle: rollLayout(rng, tier),
    lull,
    tier,
    index,
    visualLoad: 0,
  };

  if (lull) {
    dna.ringSpeedMult *= 0.75;
    dna.gapScale = Math.min(dna.gapScale, 0.95); // wide platforms
    dna.hazardDensity *= 0.5;
    dna.bloomPeriodS *= 0.6;
    dna.flowFeedback *= 0.5;
    dna.warpStrength *= 0.7;
  }

  sanitize(dna, tier, reduceFlash);
  return dna;
}

function rollLayout(rng: XorShift, tier: number): PhaseDNA['layoutStyle'] {
  const wEven = Math.max(0.25, 0.7 - tier * 0.12);
  const wCluster = 0.15 + tier * 0.07;
  const r = rng.next() * (wEven + wCluster + (1 - wEven - wCluster < 0 ? 0.2 : 0.15 + tier * 0.05));
  if (r < wEven) return 'even-gaps';
  if (r < wEven + wCluster) return 'cluster';
  return 'staircase-drift';
}

/** constraint solver: readability & fairness are enforced, not hoped for */
export function sanitize(dna: PhaseDNA, tier: number, reduceFlash: boolean): void {
  // symmetry limits
  if (tier < 3) dna.mirrorN = Math.min(dna.mirrorN, 12);
  if (dna.mirrorN > 12 && tier < 3) dna.mirrorN = 12;
  if (dna.mirrorTwist > 0.08 && dna.mirrorN > 10) dna.mirrorTwist = 0.08;
  dna.mirrorTwist = Math.min(0.15, dna.mirrorTwist);
  if (tier < 3) dna.nestedKaleido = false;
  if (tier < 3 && dna.noiseType === 'domainWarp2x') dna.noiseType = 'curl';

  // both maxed = mush
  if (dna.warpStrength > 1.2) dna.flowFeedback = Math.min(dna.flowFeedback, 0.15);
  // compensate motion load
  if (dna.wobble.amp > 0.02) dna.ringSpeedMult *= 0.85;
  dna.ringSpeedMult = Math.min(2.2, Math.max(0.6, dna.ringSpeedMult));

  if (reduceFlash) {
    dna.flowFeedback = Math.min(dna.flowFeedback, 0.1);
    if (dna.texBlendMode === 'difference') dna.texBlendMode = 'screen';
  }

  // visual load budget: clamp the biggest offenders until under budget
  const budget = LOAD_BUDGET[tier];
  let load = visualLoad(dna);
  let guard = 8;
  while (load > budget && guard-- > 0) {
    if (dna.flowFeedback > 0.05) dna.flowFeedback *= 0.7;
    else if (dna.warpStrength > 0.4) dna.warpStrength *= 0.8;
    else if (dna.wobble.amp > 0.008) dna.wobble.amp *= 0.7;
    else if (dna.mirrorTwist > 0.03) dna.mirrorTwist *= 0.7;
    else if (dna.ringSpeedMult > 0.9) dna.ringSpeedMult *= 0.9;
    else if (dna.nestedKaleido) dna.nestedKaleido = false;
    else dna.mirrorN = Math.max(5, dna.mirrorN - 2);
    load = visualLoad(dna);
  }
  dna.visualLoad = Math.round(load * 100) / 100;
}

/* ------------------------------------------------------------------ */
/*  Escalation & pacing                                                 */
/* ------------------------------------------------------------------ */

export interface BloomEvents {
  onCountdown?: () => void;
  onBloomStart?: (from: PhaseDNA, to: PhaseDNA) => void;
  onBloomMid?: (to: PhaseDNA) => void;
  onBloomEnd?: (bloomsSurvived: number) => void;
  onTierUp?: (tier: number, name: string) => void;
  onRuleBreaker?: (type: RuleBreakerType) => void;
}

export interface RuleBreaker {
  type: RuleBreakerType;
  t: number;    // seconds elapsed
  dur: number;  // ≤ 10
}

export class PhaseManager {
  runTime = 0;
  bloomsDone = 0;
  transitionT = -1;
  countdown = -1;
  dirFlip = 1;
  current!: PhaseDNA;
  next!: PhaseDNA;
  ruleBreaker: RuleBreaker | null = null;
  /** deepest ring, fed by the game each frame */
  depth = 0;
  reduceFlash = false;
  /** dev override: force every Bloom to this DNA (?dna= param) */
  forcedDNA: PhaseDNA | null = null;

  private seed = 0;
  private nextBloomAt = 0;
  private midFired = false;
  private countdownFired = false;
  private lastTier = 0;
  private events: BloomEvents;

  constructor(events: BloomEvents = {}) {
    this.events = events;
  }

  reset(seed: number): void {
    this.seed = seed;
    this.runTime = 0;
    this.bloomsDone = 0;
    this.transitionT = -1;
    this.countdown = -1;
    this.dirFlip = 1;
    this.midFired = false;
    this.countdownFired = false;
    this.lastTier = 0;
    this.ruleBreaker = null;
    this.depth = 0;
    this.current = this.roll(0, null);
    this.next = this.roll(1, this.current);
    this.nextBloomAt = this.current.bloomPeriodS;
    this.logDNA(this.current);
  }

  private roll(index: number, prev: PhaseDNA | null): PhaseDNA {
    if (this.forcedDNA) {
      const clone: PhaseDNA = JSON.parse(JSON.stringify(this.forcedDNA));
      clone.index = index;
      return clone;
    }
    return generateDNA(this.seed, index, prev, this.reduceFlash);
  }

  private logDNA(dna: PhaseDNA): void {
    console.log(`[bloom ${dna.index}] tier ${dna.tier}${dna.lull ? ' LULL' : ''} load ${dna.visualLoad} :: ${JSON.stringify(dna)}`);
  }

  get tier(): number {
    return tierOf(this.bloomsDone);
  }

  /** raw escalation scalar — visuals may keep climbing gently */
  get intensityVisual(): number {
    return 1 + this.depth * 0.006;
  }

  /** gameplay intensity, soft-capped by tanh at 3.2× */
  get intensityGame(): number {
    const i = this.intensityVisual;
    return 1 + Math.tanh((i - 1) / 2.2) * 2.2;
  }

  get inTransition(): boolean {
    return this.transitionT >= 0;
  }

  get mix(): number {
    return this.inTransition ? this.transitionT : 0;
  }

  /** DNA governing collision (switches at transition midpoint) */
  get active(): PhaseDNA {
    return this.inTransition && this.transitionT >= 0.5 ? this.next : this.current;
  }

  get transitionSpeedBoost(): number {
    if (!this.inTransition) return 1;
    return 1 + 0.8 * Math.sin(Math.PI * this.transitionT);
  }

  /** effective ring speed multiplier — the "faster and faster" */
  get speedMul(): number {
    const g = this.intensityGame;
    const dnaMul = this.current.ringSpeedMult +
      (this.next.ringSpeedMult - this.current.ringSpeedMult) * this.mix;
    return dnaMul * (0.85 + 0.15 * g * g) * this.transitionSpeedBoost;
  }

  /** player compensation: speed should feel thrilling, not cheap */
  get jumpBoost(): number {
    return 1 + 0.04 * this.tier;
  }

  get coyoteMs(): number {
    return Math.min(130, TUNING.COYOTE_MS + 10 * this.tier);
  }

  /** dev/test helper: skip to just before the next Bloom */
  warp(): void {
    if (this.transitionT < 0) this.runTime = Math.max(this.runTime, this.nextBloomAt - 0.5);
  }

  update(dt: number): void {
    this.runTime += dt;

    // rule-breaker lifecycle (tier 4, one at a time, ≤10s)
    if (this.ruleBreaker) {
      this.ruleBreaker.t += dt;
      if (this.ruleBreaker.t >= this.ruleBreaker.dur) this.ruleBreaker = null;
    }

    if (this.transitionT < 0) {
      const until = this.nextBloomAt - this.runTime;
      if (until <= TUNING.BLOOM_COUNTDOWN_S && until > 0) {
        this.countdown = until;
        if (!this.countdownFired) {
          this.countdownFired = true;
          this.events.onCountdown?.();
        }
      } else {
        this.countdown = -1;
      }
      if (this.runTime >= this.nextBloomAt) {
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
        this.current = this.next;
        this.next = this.roll(this.bloomsDone + 1, this.current);
        this.nextBloomAt = this.runTime + this.current.bloomPeriodS;
        this.logDNA(this.current);
        this.events.onBloomEnd?.(this.bloomsDone);

        // tier-up events — players should crave the next tier
        const t = this.tier;
        if (t > this.lastTier) {
          this.lastTier = t;
          this.events.onTierUp?.(t, TIER_NAMES[t]);
        }

        // DEEP VORTEX: every 2nd Bloom rolls one rule-breaker
        if (t >= 4 && this.bloomsDone % 2 === 0 && !this.ruleBreaker) {
          const rng = new XorShift(hashSeed(`rb:${this.seed}:${this.bloomsDone}`));
          const pool: RuleBreakerType[] = this.reduceFlash
            ? ['fisheyeInvert', 'diffBlend'] // no strobes with reduce-flash
            : ['mirrorStrobe', 'fisheyeInvert', 'diffBlend'];
          const type = pool[Math.floor(rng.next() * pool.length)];
          const dur = type === 'fisheyeInvert' ? 1.5 : type === 'mirrorStrobe' ? 8 : 10;
          this.ruleBreaker = { type, t: 0, dur };
          this.events.onRuleBreaker?.(type);
        }
      }
    }
  }
}
