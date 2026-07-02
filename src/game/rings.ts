import { TUNING } from './difficulty';
import type { PhaseDef } from './phases';

/** FNV-1a hash of a string → uint32, for seeding runs from a seed string. */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** xorshift32 PRNG, deterministic per seed. next() in [0, 1). */
export class XorShift {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0x100000000;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

/**
 * Kaleidoscope mirror fold: maps any angle into [0, w] with alternating
 * reflection (true mirror symmetry, period 2w). Must match the GLSL fold.
 */
export function foldAngle(x: number, w: number): number {
  const p = 2 * w;
  let t = x % p;
  if (t < 0) t += p;
  return t > w ? p - t : t;
}

/** Arc authored in the master wedge, in wedge-fraction units [0, 1]. */
export interface Arc {
  s: number;
  e: number;
  hazard: boolean;
}

/** Orbiting razor petal: a moving hazard arc inside the ring band. */
export interface Petal {
  base: number;
  amp: number;
  speed: number;
  phase: number;
  halfSpan: number;
  /** current center, updated each frame */
  pos: number;
}

export interface Mote {
  frac: number;
  taken: boolean;
}

export interface Ring {
  depth: number;
  /** base angular velocity, rad/s, sign alternates by depth parity */
  omega: number;
  /** current rotation, rad */
  phi: number;
  arcs: Arc[];
  petals: Petal[];
  motes: Mote[];
}

export const SAMPLE_NONE = 0;
export const SAMPLE_PLATFORM = 1;
export const SAMPLE_HAZARD = 2;

/**
 * The world: a sliding window of 7 rings around the player's depth.
 * All generation is seeded so a run is replayable from its seed.
 */
export class RingField {
  readonly seed: number;
  rings = new Map<number, Ring>();
  /** flips each Bloom */
  dirFlip = 1;
  private t = 0;
  private centerDepth = 0;

  constructor(seed: number) {
    this.seed = seed;
  }

  ensureWindow(center: number, phase: PhaseDef, intensity: number): void {
    this.centerDepth = center;
    const lo = center - TUNING.RING_WINDOW;
    const hi = center + TUNING.RING_WINDOW;
    for (const k of this.rings.keys()) {
      if (k < lo || k > hi) this.rings.delete(k);
    }
    for (let k = lo; k <= hi; k++) {
      if (k >= 0 && !this.rings.has(k)) {
        this.rings.set(k, this.generate(k, phase, intensity));
      }
    }
  }

  get minDepth(): number {
    return this.centerDepth - TUNING.RING_WINDOW;
  }

  private generate(k: number, phase: PhaseDef, intensity: number): Ring {
    const rng = new XorShift((this.seed ^ Math.imul(k + 0x7f4a7c15, 2654435761)) >>> 0);
    const sign = (k % 2 === 0 ? 1 : -1);
    const mag = Math.min(
      TUNING.RING_SPEED_CAP,
      TUNING.BASE_RING_SPEED + TUNING.RING_SPEED_PER_DEPTH * k
    );
    const omega = sign * mag;
    const phi = rng.next() * Math.PI * 2;

    // --- platforms: 1..3 arcs filling `coverage` of the wedge ---
    const rawCov = TUNING.PLATFORM_COVERAGE_START - TUNING.COVERAGE_DECAY_PER_DEPTH * k;
    let coverage = Math.max(TUNING.PLATFORM_COVERAGE_MIN, rawCov) + phase.coverageAdd;
    coverage = Math.min(0.92, Math.max(0.3, coverage / Math.sqrt(intensity)));
    // the starting ring is a safe haven
    if (k === 0) coverage = 0.98;

    const maxArcs = Math.min(3, 1 + Math.floor(k / 8));
    const nArcs = k === 0 ? 1 : 1 + Math.floor(rng.next() * maxArcs);
    const arcs: Arc[] = [];
    // random positive weights for platform pieces and gaps, alternating
    const pw: number[] = [];
    const gw: number[] = [];
    for (let i = 0; i < nArcs; i++) {
      pw.push(0.35 + rng.next());
      gw.push(0.35 + rng.next());
    }
    const pSum = pw.reduce((a, b) => a + b, 0);
    const gSum = gw.reduce((a, b) => a + b, 0);
    let cursor = rng.next(); // random offset; fold wraps it seamlessly
    for (let i = 0; i < nArcs; i++) {
      const w = (pw[i] / pSum) * coverage;
      arcs.push({ s: cursor, e: cursor + w, hazard: false });
      cursor += w + (gw[i] / gSum) * (1 - coverage);
    }
    // normalize arcs into [0,1) space (they may exceed 1; split them)
    const normArcs: Arc[] = [];
    for (const a of arcs) {
      if (a.e <= 1) normArcs.push(a);
      else if (a.s >= 1) normArcs.push({ s: a.s - 1, e: a.e - 1, hazard: a.hazard });
      else {
        normArcs.push({ s: a.s, e: 1, hazard: a.hazard });
        normArcs.push({ s: 0, e: a.e - 1, hazard: a.hazard });
      }
    }

    // --- hazards: crystal spikes claim an edge slice of a platform arc ---
    const hazardChance = Math.min(
      TUNING.HAZARD_CHANCE_MAX,
      TUNING.HAZARD_CHANCE_START + TUNING.HAZARD_CHANCE_PER_DEPTH * k
    ) * phase.hazardMul * intensity;
    if (k >= 3 && rng.next() < hazardChance) {
      const idx = Math.floor(rng.next() * normArcs.length);
      const a = normArcs[idx];
      const width = a.e - a.s;
      const hw = Math.max(0.05, width * rng.range(0.2, 0.32));
      if (width > hw * 2.2) {
        const atStart = rng.next() < 0.5;
        if (atStart) {
          normArcs.push({ s: a.s, e: a.s + hw, hazard: true });
          a.s += hw;
        } else {
          normArcs.push({ s: a.e - hw, e: a.e, hazard: true });
          a.e -= hw;
        }
      }
    }

    // --- razor petals: orbiting hazards, deeper only ---
    const petals: Petal[] = [];
    if (k >= TUNING.PETAL_MIN_DEPTH && rng.next() < hazardChance * 0.8) {
      petals.push({
        base: rng.next(),
        amp: rng.range(0.15, 0.3),
        speed: rng.range(0.4, 1.0),
        phase: rng.next() * Math.PI * 2,
        halfSpan: rng.range(0.03, 0.05),
        pos: 0,
      });
    }

    // --- prisma motes: 0–2 per wedge, floating above the ring ---
    const motes: Mote[] = [];
    if (k >= 1) {
      const roll = rng.next();
      const n = roll < 0.45 ? 0 : roll < 0.85 ? 1 : 2;
      for (let i = 0; i < n; i++) {
        motes.push({ frac: rng.next(), taken: false });
      }
    }

    return { depth: k, omega, phi, arcs: normArcs, petals, motes };
  }

  update(dt: number, speedMul: number): void {
    this.t += dt;
    for (const ring of this.rings.values()) {
      ring.phi += ring.omega * this.dirFlip * speedMul * dt;
      for (const p of ring.petals) {
        p.pos = p.base + p.amp * Math.sin(p.speed * this.t + p.phase);
        // wrap into [0,1); fold handles reflection at edges visually
        p.pos -= Math.floor(p.pos);
      }
    }
  }

  /**
   * Sample the ring pattern at a world angle. Folds exactly like the
   * shaders do: mirror-fold into the wedge, then ring-rotation fold.
   */
  sample(k: number, worldTheta: number, wedge: number): number {
    const ring = this.rings.get(k);
    if (!ring) return SAMPLE_NONE;
    const a = foldAngle(worldTheta, wedge);
    const f = foldAngle(a - ring.phi, wedge) / wedge;
    const h = TUNING.PLAYER_HALF_ANG / wedge;

    // hazards first (spikes kill even where platform overlaps)
    for (const arc of ring.arcs) {
      if (arc.hazard && f > arc.s + h * 0.4 && f < arc.e - h * 0.4) return SAMPLE_HAZARD;
    }
    for (const p of ring.petals) {
      const d = fracDist(f, p.pos);
      if (d < p.halfSpan + h * 0.4) return SAMPLE_HAZARD;
    }
    for (const arc of ring.arcs) {
      if (!arc.hazard && f > arc.s - h && f < arc.e + h) return SAMPLE_PLATFORM;
    }
    return SAMPLE_NONE;
  }

  /**
   * Ledge grab (climber forgiveness): when a fall just misses a platform,
   * find the nearest non-hazard arc edge within GRAB_RANGE_ANG and return
   * the world-angle delta that pulls the climber onto it. Uses the same
   * double-fold as sample(); the fold slope is probed numerically so the
   * correction is applied in the right world direction.
   */
  grabEdge(k: number, worldTheta: number, wedge: number): number | null {
    const ring = this.rings.get(k);
    if (!ring) return null;
    const fOf = (th: number) => foldAngle(foldAngle(th, wedge) - ring.phi, wedge) / wedge;
    const f = fOf(worldTheta);
    const range = TUNING.GRAB_RANGE_ANG / wedge;
    const inset = TUNING.GRAB_INSET_FRAC + TUNING.PLAYER_HALF_ANG / wedge;

    let bestDist = Infinity;
    let bestTarget = 0;
    for (const arc of ring.arcs) {
      if (arc.hazard) continue;
      if (arc.e - arc.s < inset * 2.5) continue; // too small to pull onto
      if (f < arc.s && arc.s - f <= range && arc.s - f < bestDist) {
        bestDist = arc.s - f;
        bestTarget = arc.s + inset;
      } else if (f > arc.e && f - arc.e <= range && f - arc.e < bestDist) {
        bestDist = f - arc.e;
        bestTarget = arc.e - inset;
      }
    }
    if (!isFinite(bestDist)) return null;

    // probe the fold slope: df/dθ is ±1/wedge piecewise
    const h = 1e-3;
    const slope = (fOf(worldTheta + h) - f) / h;
    if (Math.abs(slope) < 1e-6) return null; // sitting on a fold crease
    const dTheta = (bestTarget - f) / slope;
    if (Math.abs(dTheta) > TUNING.GRAB_RANGE_ANG * 2.5) return null;
    // verify the destination really is standable (fold may kink in between)
    if (this.sample(k, worldTheta + dTheta, wedge) !== SAMPLE_PLATFORM) return null;
    return dTheta;
  }

  /**
   * Collect motes near the player. Motes float half a spacing above
   * (inward of) their ring plane. Returns number collected.
   */
  collectMotes(playerDepth: number, worldTheta: number, wedge: number): number {
    let n = 0;
    for (const ring of this.rings.values()) {
      if (ring.motes.length === 0) continue;
      const moteDepth = (ring.depth + 0.55) * TUNING.RING_SPACING;
      if (Math.abs(playerDepth - moteDepth) > TUNING.MOTE_RADIAL_TOL) continue;
      const f = foldAngle(worldTheta, wedge) / wedge;
      for (const m of ring.motes) {
        if (m.taken) continue;
        if (fracDist(f, m.frac) < TUNING.MOTE_ANG_TOL) {
          m.taken = true;
          n++;
        }
      }
    }
    return n;
  }
}

/**
 * Distance between two wedge-fractions under mirror reflection at the
 * wedge boundaries (f=0 and f=1 are mirror lines).
 */
export function fracDist(a: number, b: number): number {
  return Math.min(Math.abs(a - b), a + b, 2 - a - b);
}
