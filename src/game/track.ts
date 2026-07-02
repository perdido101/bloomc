import { TUNING } from './difficulty';

/** gameplay knobs handed down from the active PhaseDNA */
export interface WorldGen {
  gapScale: number;
  hazardDensity: number;
  tier: number;
  layoutStyle: 'even-gaps' | 'cluster' | 'staircase-drift';
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
 * The three verbs of the cave:
 *   gate — a kaleidoscope crystal wall filling one lane; change lanes.
 *   low  — a laser at shin height; jump it.
 *   high — a laser curtain hanging from the ceiling; roll under it.
 */
export type ObKind = 'gate' | 'low' | 'high';

export interface Obstacle {
  z: number;
  /** lane −1 | 0 | +1 */
  lane: number;
  kind: ObKind;
}

export interface Coin {
  z: number;
  lane: number;
  taken: boolean;
}

type Cell = ObKind | 'clear';

export interface TrackEvent {
  z: number;
  /** cells[lane+1] */
  cells: [Cell, Cell, Cell];
  /** the guaranteed comfortable lane through this event */
  pathLane: number;
}

const LANES = [-1, 0, 1];

/**
 * The endless cave: obstacle *events* along z, three lanes wide.
 * Fairness is constructed, not tested for: every event keeps a path lane
 * that is CLEAR (or, for full-width bars, the whole event is one action),
 * and the path lane never moves more than one lane between events —
 * so running the path never needs more than one swipe per event.
 * All generation is seeded per event index → runs replay from their seed.
 */
export class TrackField {
  readonly seed: number;
  events: TrackEvent[] = [];
  obstacles: Obstacle[] = [];
  coins: Coin[] = [];

  private nextIndex = 0;
  private nextZ: number = TUNING.RUNWAY_Z;
  private pathLane = 0;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** generate events until the horizon covers upToZ */
  ensure(upToZ: number, gen: WorldGen, intensity: number): void {
    while (this.nextZ < upToZ) {
      this.generate(this.nextIndex++, gen, intensity);
    }
  }

  /** drop everything the runner has left behind */
  prune(behindZ: number): void {
    if (this.events.length && this.events[0].z < behindZ) {
      this.events = this.events.filter((e) => e.z >= behindZ);
      this.obstacles = this.obstacles.filter((o) => o.z >= behindZ);
    }
    if (this.coins.length && this.coins[0].z < behindZ) {
      this.coins = this.coins.filter((c) => c.z >= behindZ);
    }
  }

  private rng(i: number, salt: number): XorShift {
    return new XorShift((this.seed ^ Math.imul(i + salt, 2654435761)) >>> 0);
  }

  private generate(i: number, gen: WorldGen, intensity: number): void {
    const rng = this.rng(i, 0x7f4a7c15);
    const z = this.nextZ;

    // --- choose the path lane: a random walk, one step max per event ---
    const prevPath = this.pathLane;
    let step: number;
    if (gen.layoutStyle === 'staircase-drift') {
      // drift: keep marching one way until a wall, then turn
      const dir = prevPath >= 1 ? -1 : prevPath <= -1 ? 1 : rng.next() < 0.5 ? -1 : 1;
      step = rng.next() < 0.75 ? dir : 0;
    } else {
      const r = rng.next();
      step = r < 0.42 ? 0 : r < 0.71 ? 1 : -1;
    }
    const path = Math.max(-1, Math.min(1, prevPath + step));

    const cells: [Cell, Cell, Cell] = ['clear', 'clear', 'clear'];

    // full-width action bars: one verb across all three lanes (jump or
    // roll everyone) — classic runner beat, starts after a warm-up
    const fullBar = i >= 6 && rng.next() < Math.min(0.22, 0.1 + gen.tier * 0.03);
    if (fullBar) {
      const kind: ObKind = rng.next() < 0.55 ? 'low' : 'high';
      cells[0] = cells[1] = cells[2] = kind;
    } else {
      // per-lane obstacles; the path lane always stays clear
      const ramp = Math.min(1, i / 24); // gentle opening
      let pBlock =
        (0.36 + gen.tier * 0.07 + (intensity - 1) * 0.1) * ramp;
      if (i < 4) pBlock = i === 0 ? 0.35 : 0.55; // first events: 1 obstacle-ish
      if (gen.layoutStyle === 'cluster') pBlock += 0.14;
      pBlock = Math.min(0.9, pBlock);

      const laserBias = Math.min(0.75, 0.4 * gen.hazardDensity);
      for (const lane of LANES) {
        if (lane === path) continue;
        if (rng.next() >= pBlock) continue;
        if (i < 3) {
          cells[lane + 1] = 'low'; // opening obstacles are all jumpable
        } else if (rng.next() < laserBias) {
          cells[lane + 1] = rng.next() < 0.6 ? 'low' : 'high';
        } else {
          cells[lane + 1] = 'gate';
        }
      }
    }

    const ev: TrackEvent = { z, cells, pathLane: path };
    this.events.push(ev);
    for (const lane of LANES) {
      const c = cells[lane + 1];
      if (c !== 'clear') this.obstacles.push({ z, lane, kind: c });
    }
    this.pathLane = path;

    // --- coins: a guiding trail down the path lane toward this event ---
    const crng = this.rng(i, 0x51ed270b);
    if (crng.next() < TUNING.COIN_ROW_CHANCE) {
      const n = 3 + Math.floor(crng.next() * 3);
      const spacing = 1.6;
      const z0 = z - 4 - n * spacing;
      if (z0 > TUNING.RUNWAY_Z * 0.5 && (this.events.length < 2 ||
          z0 > this.events[this.events.length - 2].z + 2)) {
        for (let c = 0; c < n; c++) {
          this.coins.push({ z: z0 + c * spacing, lane: path, taken: false });
        }
      }
    }

    // --- next event distance: shrinking, hard-floored at the minimum ---
    const gap = Math.max(
      TUNING.EVENT_GAP_MIN,
      (TUNING.EVENT_GAP0 - TUNING.EVENT_GAP_SHRINK * i) *
        Math.max(0.85, Math.min(1.3, gen.gapScale)) *
        (0.92 + rng.next() * 0.16)
    );
    this.nextZ = z + gap;
  }

  /** obstacles whose plane lies in (z0, z1] — the frame's crossings */
  crossings(z0: number, z1: number): Obstacle[] {
    const out: Obstacle[] = [];
    for (const o of this.obstacles) {
      if (o.z > z0 && o.z <= z1) out.push(o);
    }
    return out;
  }

  /** collect coins near (z, x); airborne runners still hoover them */
  collectCoins(z0: number, z1: number, x: number): number {
    let n = 0;
    for (const c of this.coins) {
      if (c.taken) continue;
      if (c.z < z0 - TUNING.COIN_DZ || c.z > z1 + TUNING.COIN_DZ) continue;
      if (Math.abs(x - c.lane * TUNING.LANE_X) > TUNING.COIN_HALF_X) continue;
      c.taken = true;
      n++;
    }
    return n;
  }
}
