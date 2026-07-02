import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { TUNING } from '../game/difficulty';

/**
 * In-world HUD (§10): score as glowing runes orbiting at 92% radius,
 * combo shown as an arc filling around the center, Bloom countdown as a
 * pulsing glyph. No corner text. Digit Text objects are pooled; strings
 * only change when the score changes.
 */

const MAX_DIGITS = 9;

function runeStyle(size: number, color: string): TextStyle {
  return new TextStyle({
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: size,
    fill: color,
    dropShadow: { alpha: 0.9, blur: Math.max(4, size * 0.4), color, distance: 0 },
  });
}

export class Hud {
  root = new Container();
  private digits: Text[] = [];
  private comboArc = new Graphics();
  private comboText: Text;
  private glyph: Text;
  private glyphNum: Text;
  private orbit = Math.PI / 2;
  private cx = 0;
  private cy = 0;
  private radius = 0;
  private scoreCache = -1;
  private digitCount = 1;
  private comboCache = -1;
  private colorCache = '';
  private glyphSpin = 0;

  constructor() {
    for (let i = 0; i < MAX_DIGITS; i++) {
      const t = new Text({ text: '', style: runeStyle(22, '#9fdcff') });
      t.anchor.set(0.5);
      this.digits.push(t);
      this.root.addChild(t);
    }
    this.comboText = new Text({ text: '', style: runeStyle(15, '#9fdcff') });
    this.comboText.anchor.set(0.5);
    this.glyph = new Text({ text: '✦', style: runeStyle(30, '#ffffff') });
    this.glyph.anchor.set(0.5);
    this.glyphNum = new Text({ text: '', style: runeStyle(16, '#ffffff') });
    this.glyphNum.anchor.set(0.5);
    this.root.addChild(this.comboArc, this.comboText, this.glyph, this.glyphNum);
    this.glyph.visible = false;
    this.glyphNum.visible = false;
  }

  /** cx, cy in logical px (renderer coordinate space); size = square side */
  layout(cx: number, cy: number, size: number): void {
    this.cx = cx;
    this.cy = cy;
    this.radius = size * 0.46; // 92% of max radius
    const fs = Math.max(14, size * 0.032);
    for (const d of this.digits) d.style.fontSize = fs;
    this.comboText.style.fontSize = fs * 0.62;
    this.glyph.style.fontSize = fs * 1.3;
    this.glyphNum.style.fontSize = fs * 0.7;
  }

  setColor(css: string): void {
    if (css === this.colorCache) return;
    this.colorCache = css;
    for (const d of this.digits) {
      d.style.fill = css;
      d.style.dropShadow.color = css;
    }
    this.comboText.style.fill = css;
  }

  update(
    dt: number,
    score: number,
    combo: number,
    standTime: number,
    onRing: boolean,
    countdown: number,
    transitionT: number,
    time: number
  ): void {
    this.orbit += dt * 0.1;

    // --- score runes along the orbit ---
    if (score !== this.scoreCache) {
      this.scoreCache = score;
      const str = String(score);
      this.digitCount = str.length;
      for (let i = 0; i < MAX_DIGITS; i++) {
        this.digits[i].text = i < str.length ? str[i] : '';
      }
    }
    const nd = this.digitCount;
    const step = 0.055;
    const base = this.orbit;
    for (let i = 0; i < nd; i++) {
      const a = base + (i - (nd - 1) / 2) * step;
      const d = this.digits[i];
      d.x = this.cx + Math.cos(a) * this.radius;
      d.y = this.cy + Math.sin(a) * this.radius;
      d.rotation = a + Math.PI / 2;
      d.alpha = 0.85 + 0.15 * Math.sin(time * 2 + i);
    }

    // --- combo arc around the center ---
    const comboFrac = (combo - 1) / (TUNING.COMBO_MAX - 1);
    const decay = onRing ? Math.max(0, 1 - standTime / TUNING.COMBO_RESET_S) : 1;
    if (combo !== this.comboCache || combo > 1) {
      this.comboCache = combo;
      const r = this.radius * 0.24;
      const g = this.comboArc;
      g.clear();
      if (combo > 1) {
        g.arc(this.cx, this.cy, r, -Math.PI / 2, -Math.PI / 2 + comboFrac * Math.PI * 2);
        g.stroke({ width: 3, color: this.colorCache || '#ffffff', alpha: 0.55 * decay + 0.15 });
        this.comboText.text = `×${combo}`;
        this.comboText.x = this.cx;
        this.comboText.y = this.cy + r + 16;
        this.comboText.alpha = 0.5 + 0.5 * decay;
      } else {
        this.comboText.text = '';
      }
    }

    // --- bloom countdown glyph, orbiting the eye ---
    const active = countdown > 0 || transitionT >= 0;
    this.glyph.visible = active;
    this.glyphNum.visible = countdown > 0;
    if (active) {
      this.glyphSpin += dt * (transitionT >= 0 ? 6 : 2.2);
      const r = this.radius * 0.13;
      const pulse = 1 + 0.25 * Math.sin(time * 8);
      this.glyph.x = this.cx + Math.cos(this.glyphSpin) * r;
      this.glyph.y = this.cy + Math.sin(this.glyphSpin) * r;
      this.glyph.scale.set(pulse * (transitionT >= 0 ? 1.6 : 1));
      this.glyph.alpha = 0.9;
      if (countdown > 0) {
        this.glyphNum.text = String(Math.ceil(countdown));
        this.glyphNum.x = this.cx;
        this.glyphNum.y = this.cy;
        this.glyphNum.alpha = 0.75 + 0.25 * Math.sin(time * 10);
      }
    }
  }

  reset(): void {
    this.scoreCache = -1;
    this.comboCache = -1;
    this.comboArc.clear();
    this.comboText.text = '';
  }
}
