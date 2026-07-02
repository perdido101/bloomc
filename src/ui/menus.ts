import { bestScore, loadHighScores, type RunRecord } from '../game/scoring';

/**
 * DOM overlay menus: title (attract mode runs behind it), game over with
 * count-up + NEW BEST moment, pause veil, settings toggles.
 */

export interface Settings {
  reduceFlash: boolean;
  sound: boolean;
}

const SETTINGS_KEY = 'vortika_settings_v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { reduceFlash: false, sound: true, ...JSON.parse(raw) };
  } catch { /* defaults */ }
  return { reduceFlash: false, sound: true };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export class Menus {
  settings = loadSettings();
  onStart: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onPause: (() => void) | null = null;
  onSettingsChange: ((s: Settings) => void) | null = null;

  private title = el<HTMLDivElement>('title');
  private gameover = el<HTMLDivElement>('gameover');
  private pauseVeil = el<HTMLDivElement>('pauseVeil');
  private pauseBtn = el<HTMLButtonElement>('pauseBtn');
  private boot = el<HTMLDivElement>('bootMsg');
  private countUpRaf = 0;

  constructor() {
    this.title.addEventListener('pointerup', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'LABEL') return;
      this.onStart?.();
    });
    this.gameover.addEventListener('pointerup', (e) => {
      if ((e.target as HTMLElement).tagName === 'A') return;
      this.onRestart?.();
    });
    this.pauseVeil.addEventListener('pointerup', (e) => {
      const t = (e.target as HTMLElement).tagName;
      if (t === 'INPUT' || t === 'LABEL') return;
      this.onResume?.();
    });
    this.pauseBtn.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      this.onPause?.();
    });
    // keep the two settings rows in sync
    this.bindToggle('optFlash', 'optFlash2', 'reduceFlash');
    this.bindToggle('optSound', 'optSound2', 'sound');
    this.syncToggles();
  }

  private bindToggle(idA: string, idB: string, key: keyof Settings): void {
    for (const id of [idA, idB]) {
      el<HTMLInputElement>(id).addEventListener('change', (e) => {
        this.settings[key] = (e.target as HTMLInputElement).checked;
        saveSettings(this.settings);
        this.syncToggles();
        this.onSettingsChange?.(this.settings);
      });
    }
  }

  private syncToggles(): void {
    el<HTMLInputElement>('optFlash').checked = this.settings.reduceFlash;
    el<HTMLInputElement>('optFlash2').checked = this.settings.reduceFlash;
    el<HTMLInputElement>('optSound').checked = this.settings.sound;
    el<HTMLInputElement>('optSound2').checked = this.settings.sound;
  }

  hideBoot(): void {
    this.boot.style.display = 'none';
  }

  /** tier-up whisper: "TIER III — THE NESTED DEEP" in glowing type */
  showTierNote(tier: number, name: string, colorCss: string): void {
    const el = document.getElementById('tierNote') as HTMLDivElement;
    const numerals = ['0', 'I', 'II', 'III', 'IV', 'V'];
    el.textContent = `TIER ${numerals[tier] ?? tier} — ${name}`;
    el.style.color = colorCss;
    el.classList.remove('show');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('show');
  }

  /** gallery mode: hide all chrome for clean auditions */
  galleryMode(): void {
    this.hideAll();
    this.boot.style.display = 'none';
  }

  showTitle(): void {
    this.hideAll();
    const best = bestScore();
    const scores = loadHighScores().slice(0, 5);
    const rows = scores.map((s, i) => `${i + 1}. <b>${s.score}</b> · ring ${s.depth} · ${s.blooms}✿`).join('<br/>');
    el<HTMLDivElement>('scoreStrip').innerHTML = best > 0 ? `BEST <b>${best}</b><br/>${rows}` : 'descend into the vortex';
    this.title.classList.add('show');
  }

  showRun(): void {
    this.hideAll();
    this.pauseBtn.classList.add('show');
  }

  showGameOver(rec: RunRecord, isBest: boolean, onCountTick?: () => void): void {
    this.hideAll();
    this.gameover.classList.add('show');
    el<HTMLDivElement>('newBest').classList.toggle('show', isBest);
    el<HTMLDivElement>('goStats').innerHTML =
      `deepest ring <b>${rec.depth}</b> · blooms survived <b>${rec.blooms}</b> · best combo <b>×${rec.combo}</b>`;
    const url = new URL(location.href);
    url.searchParams.set('seed', rec.seed);
    el<HTMLDivElement>('goSeed').innerHTML =
      `seed <a href="${url.pathname}?seed=${rec.seed}">${rec.seed}</a>`;

    // score counts up with rune-glow ticks
    const scoreEl = el<HTMLDivElement>('goScore');
    cancelAnimationFrame(this.countUpRaf);
    const start = performance.now();
    const dur = Math.min(1800, 400 + rec.score * 2);
    let lastShown = -1;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = Math.round(rec.score * eased);
      if (v !== lastShown) {
        lastShown = v;
        scoreEl.textContent = String(v);
        if (v % 50 < 10) onCountTick?.();
      }
      if (t < 1) this.countUpRaf = requestAnimationFrame(tick);
    };
    this.countUpRaf = requestAnimationFrame(tick);
  }

  showPause(): void {
    this.pauseVeil.classList.add('show');
    this.pauseBtn.classList.remove('show');
  }

  hidePause(): void {
    this.pauseVeil.classList.remove('show');
    this.pauseBtn.classList.add('show');
  }

  get isPauseShown(): boolean {
    return this.pauseVeil.classList.contains('show');
  }

  hideAll(): void {
    this.title.classList.remove('show');
    this.gameover.classList.remove('show');
    this.pauseVeil.classList.remove('show');
    this.pauseBtn.classList.remove('show');
  }
}
