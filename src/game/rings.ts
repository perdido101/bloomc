import { TUNING } from './difficulty';

/** gameplay knobs handed down from the active PhaseDNA */
export interface WorldGen {
  gapScale: number;
  hazardDensity: number;
  tier: number;
  layoutStyle: 'even-gaps' | 'cluster' | 'staircase-drift';
  /** current collision wedge width, radians (doors are sized in world angle) */
  wedge: number;
}

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

const TWO_PI = Math.PI * 2;

/**
 * Mirror fold with per-copy angular twist (spiral galaxies). Copy m of the
 * kaleidoscope is rotated by twist·m before folding. Must match the GLSL
 * twistFold in the mirror shader — collision and visuals share this math.
 */
export function twistFold(x: number, w: number, twist: number): number {
  if (twist === 0) return foldAngle(x, w);
  let thn = x % TWO_PI;
  if (thn < 0) thn += TWO_PI;
  const m = Math.floor(thn / w);
  return foldAngle(thn - twist * m, w);
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

  ensureWindow(center: number, gen: WorldGen, intensity: number): void {
    this.centerDepth = center;
    const lo = center - TUNING.RING_WINDOW;
    const hi = center + TUNING.RING_WINDOW;
    for (const k of this.rings.keys()) {
      if (k < lo || k > hi) this.rings.delete(k);
    }
    for (let k = lo; k <= hi; k++) {
      if (k >= 0 && !this.rings.has(k)) {
        this.rings.set(k, this.generate(k, gen, intensity));
      }
    }
  }

  get minDepth(): number {
    return this.centerDepth - TUNING.RING_WINDOW;
  }

  private generate(k: number, gen: WorldGen, intensity: number): Ring {
    const rng = new XorShift((this.seed ^ Math.imul(k + 0x7f4a7c15, 2654435761)) >>> 0);
    const sign = (k % 2 === 0 ? 1 : -1);
    const mag = Math.min(
      TUNING.RING_SPEED_CAP,
      TUNING.BASE_RING_SPEED + TUNING.RING_SPEED_PER_DEPTH * k
    );
    const omega = sign * mag;
    const phi = rng.next() * Math.PI * 2;

    // --- the maze: rings are near-solid floors with 1-2 doorways per
    // wedge (mirrored N times). Doors are both the way inward AND holes
    // under your feet. Solid parts block jumps from below. ---
    const wedge = gen.wedge > 0 ? gen.wedge : Math.PI / 4;
    let doorRad = Math.max(
      TUNING.DOOR_WIDTH_MIN_RAD,
      TUNING.DOOR_WIDTH_RAD - TUNING.DOOR_SHRINK_PER_DEPTH * k
    ) / (gen.gapScale * Math.pow(intensity, 0.25));
    if (k < 3) doorRad *= 1.35; // generous opening rings
    // a door must always be passable (min world angle) but never eat the
    // floor: cap it as a fraction of the wedge
    const minPass = 0.16; // rad — comfortably wider than the player
    const wf = Math.min(k < 3 ? 0.28 : 0.22, Math.max(minPass / wedge, doorRad / wedge));

    let doorCount: number;
    if (k < 3) doorCount = 2;
    else if (gen.layoutStyle === 'cluster' || gen.layoutStyle === 'staircase-drift') doorCount = 1;
    else doorCount = rng.next() < 0.6 ? 2 : 1;
    if (doorCount === 2 && wf > 0.2) doorCount = 1; // keep most of the floor

    // IMPORTANT: the ring-rotation fold displays an alternating window of
    // the authored pattern — only frac 0.5 is visible at EVERY rotation.
    // So each ring gets a "keystone" door centered at 0.5 (an opening
    // always exists somewhere — no soft-locks); any second door lives
    // elsewhere and comes and goes with the rotation for variety.
    const doors: number[] = [0.5 + (rng.next() - 0.5) * 0.05];
    if (doorCount === 2 && gen.layoutStyle !== 'staircase-drift') {
      doors.push(rng.next() < 0.5 ? rng.range(0.1, 0.32) : rng.range(0.68, 0.9));
    }

    // solid arcs = the complement of the doors in [0,1)
    const cuts = doors
      .map((d) => ({ s: d - wf / 2, e: d + wf / 2 }))
      .flatMap((c) => {
        if (c.s < 0) return [{ s: c.s + 1, e: 1 }, { s: 0, e: c.e }];
        if (c.e > 1) return [{ s: c.s, e: 1 }, { s: 0, e: c.e - 1 }];
        return [c];
      })
      .sort((a, b) => a.s - b.s);
    const normArcs: Arc[] = [];
    let cursor = 0;
    for (const c of cuts) {
      if (c.s > cursor + 0.01) normArcs.push({ s: cursor, e: c.s, hazard: false });
      cursor = Math.max(cursor, c.e);
    }
    if (cursor < 0.99) normArcs.push({ s: cursor, e: 1, hazard: false });

    // --- hazards: crystal spikes claim an edge slice of a platform arc ---
    const hazardChance = Math.min(
      TUNING.HAZARD_CHANCE_MAX,
      TUNING.HAZARD_CHANCE_START + TUNING.HAZARD_CHANCE_PER_DEPTH * k
    ) * gen.hazardDensity * (0.7 + 0.3 * intensity);
    if (k >= 4 && rng.next() < hazardChance && normArcs.length > 0) {
      // a spike bed guarding one side of a doorway
      const idx = Math.floor(rng.next() * normArcs.length);
      const a = normArcs[idx];
      const width = a.e - a.s;
      const hw = Math.min(width * 0.3, Math.max(0.04, wf * 0.6));
      if (width > hw * 2.5) {
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
  sample(k: number, worldTheta: number, wedge: number, twist = 0): number {
    const ring = this.rings.get(k);
    if (!ring) return SAMPLE_NONE;
    const a = twistFold(worldTheta, wedge, twist);
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

  /** a world angle standing on solid floor of ring k (for spawning) */
  findSolid(k: number, wedge: number, twist = 0): number {
    for (const margin of [0.12, 0.05, 0]) {
      for (let i = 0; i < 128; i++) {
        const th = (i / 128) * TWO_PI + 0.013;
        if (
          this.sample(k, th, wedge, twist) === SAMPLE_PLATFORM &&
          (margin === 0 ||
            (this.sample(k, th + margin, wedge, twist) === SAMPLE_PLATFORM &&
              this.sample(k, th - margin, wedge, twist) === SAMPLE_PLATFORM))
        ) {
          return th;
        }
      }
    }
    return 0;
  }

  /**
   * Ledge grab (climber forgiveness): when a fall just misses a platform,
   * find the nearest non-hazard arc edge within GRAB_RANGE_ANG and return
   * the world-angle delta that pulls the climber onto it. Uses the same
   * double-fold as sample(); the fold slope is probed numerically so the
   * correction is applied in the right world direction.
   */
  grabEdge(k: number, worldTheta: number, wedge: number, twist = 0): number | null {
    const ring = this.rings.get(k);
    if (!ring) return null;
    const fOf = (th: number) => foldAngle(twistFold(th, wedge, twist) - ring.phi, wedge) / wedge;
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
    if (this.sample(k, worldTheta + dTheta, wedge, twist) !== SAMPLE_PLATFORM) return null;
    return dTheta;
  }

  /**
   * Collect motes near the player. Motes float half a spacing above
   * (inward of) their ring plane. Returns number collected.
   */
  collectMotes(playerDepth: number, worldTheta: number, wedge: number, twist = 0): number {
    let n = 0;
    for (const ring of this.rings.values()) {
      if (ring.motes.length === 0) continue;
      const moteDepth = (ring.depth + 0.55) * TUNING.RING_SPACING;
      if (Math.abs(playerDepth - moteDepth) > TUNING.MOTE_RADIAL_TOL) continue;
      const f = twistFold(worldTheta, wedge, twist) / wedge;
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
