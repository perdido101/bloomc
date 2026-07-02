import { TUNING } from './difficulty';

export interface RunRecord {
  score: number;
  /** distance run, whole world units ("meters") */
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
  /** distance run, world units */
  distance = 0;
  blooms = 0;
  coins = 0;

  private distCarry = 0;

  reset(): void {
    this.score = 0;
    this.combo = 1;
    this.bestCombo = 1;
    this.distance = 0;
    this.blooms = 0;
    this.coins = 0;
    this.distCarry = 0;
  }

  /** every world unit run scores — the metronome of the game */
  addDistance(units: number): void {
    this.distance += units;
    this.distCarry += units * TUNING.DIST_SCORE;
    const whole = Math.floor(this.distCarry);
    if (whole > 0) {
      this.distCarry -= whole;
      this.score += whole;
    }
  }

  /** cleanly passed an obstacle event — builds the combo */
  onPass(closeCall: boolean): number {
    this.combo = Math.min(TUNING.COMBO_MAX, this.combo + 1);
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    if (!closeCall) return 0;
    const pts = TUNING.CLOSE_CALL_SCORE * this.combo;
    this.score += pts;
    return pts;
  }

  onCoin(count: number): number {
    const pts = count * TUNING.COIN_SCORE * this.combo;
    this.score += pts;
    this.coins += count;
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
      depth: Math.round(this.distance),
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
