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
 * The flight grid: 3 lanes × 2 heights = 6 cells per ring.
 * cell index = (lane + 1) + tier * 3  (lane −1|0|1, tier 0 low | 1 high)
 */
export const CELLS = 6;

export function cellIndex(lane: number, tier: number): number {
  return lane + 1 + tier * 3;
}

export function cellX(cell: number): number {
  return ((cell % 3) - 1) * TUNING.LANE_X;
}

export function cellY(cell: number): number {
  return cell < 3 ? TUNING.TIER_Y0 : TUNING.TIER_Y1;
}

/** one move = a lane step OR a height flip */
export function cellDist(a: number, b: number): number {
  return Math.abs((a % 3) - (b % 3)) + Math.abs(Math.floor(a / 3) - Math.floor(b / 3));
}

export interface Coin {
  z: number;
  cell: number;
  taken: boolean;
}

/** a kaleidoscope ring: a mandala plane with GAPS (open cells) in it */
export interface TrackEvent {
  z: number;
  /** open[cell] = true → that cell is a gap you can fly through */
  open: boolean[];
  /** the guaranteed comfortable gap through this ring */
  pathCell: number;
}

/**
 * The endless flight: kaleidoscope rings along z, each with gaps in its
 * pattern. Fairness is constructed, not tested for: every ring keeps an
 * open path cell that never moves more than one move (a lane step or a
 * height flip) between rings — so flying the path never needs more than
 * one swipe per ring. All generation is seeded per ring index → runs
 * replay from their seed.
 */
export class TrackField {
  readonly seed: number;
  events: TrackEvent[] = [];
  coins: Coin[] = [];

  private nextIndex = 0;
  private nextZ: number = TUNING.RUNWAY_Z;
  private pathCell = 1; // start center-low

  constructor(seed: number) {
    this.seed = seed;
  }

  /** generate rings until the horizon covers upToZ */
  ensure(upToZ: number, gen: WorldGen, intensity: number): void {
    while (this.nextZ < upToZ) {
      this.generate(this.nextIndex++, gen, intensity);
    }
  }

  /** drop everything the cat has left behind */
  prune(behindZ: number): void {
    if (this.events.length && this.events[0].z < behindZ) {
      this.events = this.events.filter((e) => e.z >= behindZ);
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

    // --- walk the path gap: one move max per ring ---
    const prev = this.pathCell;
    const lane = (prev % 3) - 1;
    const tier = Math.floor(prev / 3);
    let path = prev;
    const r = rng.next();
    if (gen.layoutStyle === 'staircase-drift') {
      // drift: keep marching one way until the edge, then bounce or flip
      const dir = lane >= 1 ? -1 : lane <= -1 ? 1 : rng.next() < 0.5 ? -1 : 1;
      if (r < 0.6) path = cellIndex(lane + dir, tier);
      else if (r < 0.8) path = cellIndex(lane, 1 - tier);
    } else {
      if (r < 0.38) path = prev;
      else if (r < 0.72) {
        const step = rng.next() < 0.5 ? -1 : 1;
        path = cellIndex(Math.max(-1, Math.min(1, lane + step)), tier);
      } else {
        path = cellIndex(lane, 1 - tier);
      }
    }

    // --- how many gaps this ring keeps (fewer = harder) ---
    const ramp = Math.min(1, i / 26);
    let openCount =
      4 - Math.min(2.6, (gen.tier * 0.5 + (intensity - 1) * 0.6 + i * 0.02) * ramp)
      - (gen.hazardDensity - 1) * 0.8
      + (1 - Math.min(1.3, Math.max(0.7, gen.gapScale))) * 1.5;
    if (i < 3) openCount = 4;
    if (gen.layoutStyle === 'cluster') openCount -= 0.5;
    const n = Math.max(1, Math.min(4, Math.round(openCount + (rng.next() - 0.5))));

    const open = new Array<boolean>(CELLS).fill(false);
    open[path] = true;
    // extra gaps cluster NEAR the path so choices stay readable
    let extras = n - 1;
    let guard = 12;
    while (extras > 0 && guard-- > 0) {
      const c = Math.floor(rng.next() * CELLS);
      if (!open[c] && cellDist(c, path) <= 2) {
        open[c] = true;
        extras--;
      }
    }

    const ev: TrackEvent = { z, open, pathCell: path };
    this.events.push(ev);
    this.pathCell = path;

    // --- coins: a guiding trail toward this ring's path gap ---
    const crng = this.rng(i, 0x51ed270b);
    if (crng.next() < TUNING.COIN_ROW_CHANCE) {
      const count = 3 + Math.floor(crng.next() * 3);
      const spacing = 1.6;
      const z0 = z - 4 - count * spacing;
      if (z0 > TUNING.RUNWAY_Z * 0.5 && (this.events.length < 2 ||
          z0 > this.events[this.events.length - 2].z + 2)) {
        for (let c = 0; c < count; c++) {
          this.coins.push({ z: z0 + c * spacing, cell: path, taken: false });
        }
      }
    }

    // --- next ring distance: shrinking, hard-floored at the minimum ---
    const gap = Math.max(
      TUNING.EVENT_GAP_MIN,
      (TUNING.EVENT_GAP0 - TUNING.EVENT_GAP_SHRINK * i) *
        Math.max(0.85, Math.min(1.3, gen.gapScale)) *
        (0.92 + rng.next() * 0.16)
    );
    this.nextZ = z + gap;
  }

  /** rings whose plane lies in (z0, z1] — the frame's crossings */
  crossings(z0: number, z1: number): TrackEvent[] {
    const out: TrackEvent[] = [];
    for (const e of this.events) {
      if (e.z > z0 && e.z <= z1) out.push(e);
    }
    return out;
  }

  /** collect coins near (z, x, y) */
  collectCoins(z0: number, z1: number, x: number, y: number): number {
    let n = 0;
    for (const c of this.coins) {
      if (c.taken) continue;
      if (c.z < z0 - TUNING.COIN_DZ || c.z > z1 + TUNING.COIN_DZ) continue;
      if (Math.abs(x - cellX(c.cell)) > TUNING.COIN_HALF_X) continue;
      if (Math.abs(y - cellY(c.cell)) > TUNING.COIN_HALF_Y) continue;
      c.taken = true;
      n++;
    }
    return n;
  }
}
