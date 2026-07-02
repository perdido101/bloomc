import { TUNING } from './difficulty';

export interface RunRecord {
  score: number;
  depth: number;
  blooms: number;
  combo: number;
  seed: string;
  date: string;
}

const STORE_KEY = 'vortika_scores_v1';

export class Scoring {
  score = 0;
  combo = 1;
  bestCombo = 1;
  deepestRing = 0;
  blooms = 0;
  motes = 0;
  /** true for one frame after a skim (HUD/audio feedback) */
  private maxLanded = 0;

  reset(): void {
    this.score = 0;
    this.combo = 1;
    this.bestCombo = 1;
    this.deepestRing = 0;
    this.blooms = 0;
    this.motes = 0;
    this.maxLanded = 0;
  }

  /** returns rings gained (for feedback) */
  onLand(ring: number): number {
    if (ring > this.maxLanded) {
      const gained = ring - this.maxLanded;
      this.maxLanded = ring;
      this.deepestRing = ring;
      this.score += gained * TUNING.DEPTH_SCORE;
      return gained;
    }
    return 0;
  }

  /** returns true if this leave was a skim (combo went up) */
  onLeave(standDur: number): boolean {
    if (standDur <= TUNING.SKIM_WINDOW_S) {
      this.combo = Math.min(TUNING.COMBO_MAX, this.combo + 1);
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      return true;
    }
    return false;
  }

  /** call each frame while the player stands on a ring */
  onStanding(standTime: number): void {
    if (standTime > TUNING.COMBO_RESET_S) this.combo = 1;
  }

  onMote(count: number): number {
    const pts = count * TUNING.MOTE_SCORE * this.combo;
    this.score += pts;
    this.motes += count;
    return pts;
  }

  /** flat bonus (tier-up events) */
  addBonus(pts: number): void {
    this.score += pts;
  }

  onBloomSurvived(bloomsDone: number): number {
    this.blooms = bloomsDone;
    const pts = TUNING.BLOOM_BONUS * bloomsDone;
    this.score += pts;
    return pts;
  }

  record(seed: string): RunRecord {
    return {
      score: this.score,
      depth: this.deepestRing,
      blooms: this.blooms,
      combo: this.bestCombo,
      seed,
      date: new Date().toISOString().slice(0, 10),
    };
  }
}

export function loadHighScores(): RunRecord[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** persist a run; returns true if it's a new #1 best */
export function saveHighScore(rec: RunRecord): boolean {
  const scores = loadHighScores();
  const prevBest = scores.length ? scores[0].score : 0;
  scores.push(rec);
  scores.sort((a, b) => b.score - a.score);
  scores.length = Math.min(scores.length, 10);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(scores));
  } catch {
    /* storage full/blocked: ignore */
  }
  return rec.score > prevBest && rec.score > 0;
}

export function bestScore(): number {
  const s = loadHighScores();
  return s.length ? s[0].score : 0;
}
