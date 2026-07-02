import { bestScore, loadHighScores, type RunRecord } from '../game/scoring';

/**
 * DOM overlay: main menu (DESCEND / HOW TO PLAY / LEADERBOARD / SETTINGS)
 * over the attract-mode kaleidoscope, game over with count-up + NEW BEST,
 * pause veil, tier-up notes. The wordmark itself is drawn in-canvas by the
 * kaleidoscope-unfurl shader; the DOM element only reserves its place.
 */

export interface Settings {
  reduceFlash: boolean;
  sound: boolean;
  music: boolean;
  /** sumi-e look: bright paper background, ink-black wisp and walls */
  ink: boolean;
}

const SETTINGS_KEY = 'bloom_settings_v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { reduceFlash: false, sound: true, music: true, ink: false, ...JSON.parse(raw) };
  } catch { /* defaults */ }
  return { reduceFlash: false, sound: true, music: true, ink: false };
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
  /** any button press (unlocks WebAudio) */
  onUiTap: (() => void) | null = null;

  private splash = el<HTMLDivElement>('splash');
  private title = el<HTMLDivElement>('title');
  private howto = el<HTMLDivElement>('howto');
  private board = el<HTMLDivElement>('board');
  private settingsPanel = el<HTMLDivElement>('settingsPanel');
  private gameover = el<HTMLDivElement>('gameover');
  private pauseVeil = el<HTMLDivElement>('pauseVeil');
  private pauseBtn = el<HTMLButtonElement>('pauseBtn');
  private boot = el<HTMLDivElement>('bootMsg');
  private countUpRaf = 0;

  constructor() {
    const tap = (id: string, fn: () => void) => {
      el<HTMLButtonElement>(id).addEventListener('pointerup', (e) => {
        e.stopPropagation();
        this.onUiTap?.();
        fn();
      });
    };
    this.splash.addEventListener('pointerup', () => {
      this.onUiTap?.();
      this.showTitle();
    });
    tap('btnPlay', () => this.onStart?.());
    tap('btnHow', () => this.showPanel(this.howto));
    tap('btnBoard', () => this.showBoard());
    tap('btnSettings', () => this.showPanel(this.settingsPanel));
    tap('btnHowBack', () => this.showTitle());
    tap('btnBoardBack', () => this.showTitle());
    tap('btnSettingsBack', () => this.showTitle());

    this.gameover.addEventListener('pointerup', (e) => {
      if ((e.target as HTMLElement).tagName === 'A') return;
      this.onUiTap?.();
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

    this.bindToggle('optFlash', 'optFlash2', 'reduceFlash');
    this.bindToggle('optSound', 'optSound2', 'sound');
    this.bindToggle('optMusic', 'optMusic2', 'music');
    this.bindToggle('optInk', 'optInk2', 'ink');
    this.syncToggles();
    document.body.classList.toggle('ink', this.settings.ink);
  }

  private bindToggle(idA: string, idB: string, key: keyof Settings): void {
    for (const id of [idA, idB]) {
      el<HTMLInputElement>(id).addEventListener('change', (e) => {
        this.settings[key] = (e.target as HTMLInputElement).checked;
        saveSettings(this.settings);
        this.syncToggles();
        document.body.classList.toggle('ink', this.settings.ink);
        this.onSettingsChange?.(this.settings);
      });
    }
  }

  private syncToggles(): void {
    for (const [a, b, key] of [
      ['optFlash', 'optFlash2', 'reduceFlash'],
      ['optSound', 'optSound2', 'sound'],
      ['optMusic', 'optMusic2', 'music'],
      ['optInk', 'optInk2', 'ink'],
    ] as const) {
      el<HTMLInputElement>(a).checked = this.settings[key];
      el<HTMLInputElement>(b).checked = this.settings[key];
    }
  }

  hideBoot(): void {
    this.boot.style.display = 'none';
  }

  /** tier-up whisper: "TIER III — THE NESTED DEEP" in glowing type */
  showTierNote(tier: number, name: string, colorCss: string): void {
    const note = el<HTMLDivElement>('tierNote');
    const numerals = ['0', 'I', 'II', 'III', 'IV', 'V'];
    note.textContent = `TIER ${numerals[tier] ?? tier} — ${name}`;
    note.style.color = colorCss;
    note.classList.remove('show');
    void note.offsetWidth; // restart the CSS animation
    note.classList.add('show');
  }

  /** gallery mode: hide all chrome for clean auditions */
  galleryMode(): void {
    this.hideAll();
    this.boot.style.display = 'none';
  }

  private showPanel(panel: HTMLDivElement): void {
    this.hideAll();
    panel.classList.add('show');
  }

  showSplash(): void {
    this.showPanel(this.splash);
  }

  get isSplashShown(): boolean {
    return this.splash.classList.contains('show');
  }

  showTitle(): void {
    this.showPanel(this.title);
    const best = bestScore();
    el<HTMLDivElement>('scoreStrip').innerHTML =
      best > 0 ? `BEST <b>${best}</b>` : 'descend into the vortex';
  }

  get isTitleShown(): boolean {
    return this.title.classList.contains('show');
  }

  private showBoard(): void {
    this.showPanel(this.board);
    const scores = loadHighScores();
    const list = el<HTMLDivElement>('boardList');
    if (scores.length === 0) {
      list.innerHTML = 'no descents yet';
      return;
    }
    list.innerHTML = scores
      .slice(0, 10)
      .map(
        (s, i) =>
          `<span class="rank">${i + 1}.</span><b>${s.score}</b>` +
          ` · ring ${s.depth} · ${s.blooms}✿ · ×${s.combo}`
      )
      .join('<br/>');
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
    for (const p of [this.splash, this.title, this.howto, this.board, this.settingsPanel, this.gameover, this.pauseVeil]) {
      p.classList.remove('show');
    }
    this.pauseBtn.classList.remove('show');
  }
}
