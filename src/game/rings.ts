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
  /** low wall: can be jumped over instead of steering through the door */
  low: boolean;
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

    // --- hazards: spike guards INSIDE a doorway (narrow the safe opening) ---
    const hazardChance = Math.min(
      TUNING.HAZARD_CHANCE_MAX,
      TUNING.HAZARD_CHANCE_START + TUNING.HAZARD_CHANCE_PER_DEPTH * k
    ) * gen.hazardDensity * (0.7 + 0.3 * intensity);
    if (k >= 6 && rng.next() < hazardChance) {
      const d = doors[Math.floor(rng.next() * doors.length)];
      const gw = wf * rng.range(0.22, 0.34);
      const side = rng.next() < 0.5 ? -1 : 1;
      const edge = d + (side * wf) / 2;
      normArcs.push(
        side < 0
          ? { s: edge, e: edge + gw, hazard: true }
          : { s: edge - gw, e: edge, hazard: true }
      );
    }

    // low walls: jumpable — the runner's hurdles
    const low = k >= 4 && rng.next() < TUNING.LOW_RING_CHANCE;

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

    // --- prisma motes: ride the ring just ahead of its doorways — a coin
    // trail that literally points you at the opening ---
    const motes: Mote[] = [];
    if (k >= 1) {
      for (const d of doors) {
        if (rng.next() < 0.65) motes.push({ frac: d, taken: false });
      }
      if (rng.next() < 0.2) motes.push({ frac: rng.next(), taken: false });
    }

    return { depth: k, omega, phi, arcs: normArcs, petals, motes, low };
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

  /**
   * Collect motes near the player. Motes float half a spacing above
   * (inward of) their ring plane. Returns number collected.
   */
  collectMotes(playerDepth: number, worldTheta: number, wedge: number, twist = 0): number {
    let n = 0;
    for (const ring of this.rings.values()) {
      if (ring.motes.length === 0) continue;
      const moteDepth = (ring.depth - 0.45) * TUNING.RING_SPACING;
      if (Math.abs(playerDepth - moteDepth) > TUNING.MOTE_RADIAL_TOL) continue;
      // pattern space: motes rotate WITH their ring, marking its doors
      const f = foldAngle(twistFold(worldTheta, wedge, twist) - ring.phi, wedge) / wedge;
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

  /**
   * Signed world-angle delta from worldTheta to the nearest open doorway
   * center of ring k (0 if already inside one, null if none nearby).
   * Drives the aim assist.
   */
  doorDelta(k: number, worldTheta: number, wedge: number, twist = 0): number | null {
    const ring = this.rings.get(k);
    if (!ring) return null;
    const fOf = (th: number) =>
      foldAngle(twistFold(th, wedge, twist) - ring.phi, wedge) / wedge;
    const f = fOf(worldTheta);
    if (this.sample(k, worldTheta, wedge, twist) === SAMPLE_NONE) return 0;

    // gap centers = midpoints of the complement of all arcs
    let best = Infinity;
    let target = 0;
    const gaps = gapsOf(ring.arcs);
    for (const g of gaps) {
      const c = (g.s + g.e) / 2;
      // reflected images of c under the fold
      for (const t of [c, -c, 2 - c]) {
        const d = Math.abs(t - f);
        if (d < best) {
          best = d;
          target = t;
        }
      }
    }
    if (!isFinite(best)) return null;
    const h = 1e-3;
    const slope = (fOf(worldTheta + h) - f) / h;
    if (Math.abs(slope) < 1e-6) return null;
    const dTheta = (target - f) / slope;
    // the fold is only piecewise-linear: verify the landing spot really is
    // open, else skip this frame (the assist recomputes continuously)
    if (this.sample(k, worldTheta + dTheta, wedge, twist) !== SAMPLE_NONE) return null;
    return dTheta;
  }

  /** distance (world rad) to the nearest wall edge while inside a doorway */
  doorEdgeDist(k: number, worldTheta: number, wedge: number, twist = 0): number | null {
    const ring = this.rings.get(k);
    if (!ring) return null;
    const f = foldAngle(twistFold(worldTheta, wedge, twist) - ring.phi, wedge) / wedge;
    let best = Infinity;
    for (const a of ring.arcs) {
      best = Math.min(best, Math.abs(f - a.s), Math.abs(f - a.e));
    }
    return isFinite(best) ? best * wedge : null;
  }
}

/**
 * Distance between two wedge-fractions under mirror reflection at the
 * wedge boundaries (f=0 and f=1 are mirror lines).
 */
export function fracDist(a: number, b: number): number {
  return Math.min(Math.abs(a - b), a + b, 2 - a - b);
}

/** complement of the (sorted-on-demand) arcs in [0,1) — the doorways */
function gapsOf(arcs: Arc[]): Array<{ s: number; e: number }> {
  const sorted = [...arcs].sort((x, y) => x.s - y.s);
  const gaps: Array<{ s: number; e: number }> = [];
  let cursor = 0;
  for (const a of sorted) {
    if (a.s > cursor + 0.005) gaps.push({ s: cursor, e: a.s });
    cursor = Math.max(cursor, a.e);
  }
  if (cursor < 0.995) gaps.push({ s: cursor, e: 1 });
  return gaps;
}
