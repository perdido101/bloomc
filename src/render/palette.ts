import { Texture } from 'pixi.js';
import { cosPalette, type PaletteGenome, type Vec3 } from '../game/phases';

/**
 * Full-spectrum procedural palettes (Addendum §B). The LUT texture every
 * shader samples is evaluated on the CPU each frame from a cosine gradient
 * genome (a + b·cos(2π(c·t+d))), hue-rotated by the live drift, and — on
 * Blooms — MORPHED by lerping the entire genome, never cut.
 *
 * Readability invariants live here too: the hazard color is derived each
 * update from the platform color (hue +150–210°, +25% sat, verified ≥3:1
 * contrast, pushed to signal red/white when the palette refuses).
 */

function hueRotate(r: number, g: number, b: number, rad: number, out: Vec3): void {
  // Rodrigues rotation of the color vector around the grey axis (1,1,1)/√3
  const cs = Math.cos(rad);
  const sn = Math.sin(rad);
  const k = 0.57735;
  const dot = k * (r + g + b) * (1 - cs);
  const cx = k * (b - g);
  const cy = k * (r - b);
  const cz = k * (g - r);
  out[0] = r * cs + cx * sn + k * dot;
  out[1] = g * cs + cy * sn + k * dot;
  out[2] = b * cs + cz * sn + k * dot;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function relLum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpHue(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180; // shortest arc
  return a + d * t;
}

export class PaletteLut {
  readonly texture: Texture;
  /** bumps whenever the LUT content actually changes */
  revision = 0;
  /** derived hazard color (0..1 floats), contrast-verified each update */
  readonly hazardColor = new Float32Array([1, 0.2, 0.3]);
  /** platform-luminance reference color */
  readonly platformColor = new Float32Array([0.5, 0.7, 0.9]);
  /** last verified hazard/platform contrast ratio (for acceptance logging) */
  hazardContrast = 0;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private scratch: Vec3 = [0, 0, 0];
  private mixed: PaletteGenome = {
    a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0], d: [0, 0, 0],
    harmony: 'analogous', baseHue: 0, hueDriftSpeed: 1, luminanceProfile: 'darkCore',
  };
  private lastKey = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 1;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(256, 1);
    this.texture = Texture.from(this.canvas);
    this.texture.source.style.addressMode = 'clamp-to-edge';
  }

  /**
   * Evaluate the blended genome into the LUT. hueShiftDeg is the live
   * drift accumulator; mix morphs genA→genB during Bloom transitions.
   */
  update(genA: PaletteGenome, genB: PaletteGenome, mix: number, hueShiftDeg: number): void {
    // cheap dirty check (quantized) so idle frames with slow drift still
    // update but identical frames don't
    const key = `${genA.baseHue.toFixed(2)}:${genB.baseHue.toFixed(2)}:${mix.toFixed(3)}:${hueShiftDeg.toFixed(1)}:${genA.a[0].toFixed(3)}:${genB.a[0].toFixed(3)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const m = this.mixed;
    for (let i = 0; i < 3; i++) {
      m.a[i] = lerp(genA.a[i], genB.a[i], mix);
      m.b[i] = lerp(genA.b[i], genB.b[i], mix);
      m.c[i] = lerp(genA.c[i], genB.c[i], mix);
      m.d[i] = lerp(genA.d[i], genB.d[i], mix);
    }
    const hue = lerpHue(genA.baseHue, genB.baseHue, mix) + hueShiftDeg;
    const hueRad = (hue * Math.PI) / 180;

    const d = this.img.data;
    const s = this.scratch;
    for (let i = 0; i < 256; i++) {
      cosPalette(m, i / 255, s);
      hueRotate(clamp01(s[0]), clamp01(s[1]), clamp01(s[2]), hueRad, s);
      d[i * 4] = clamp01(s[0]) * 255;
      d[i * 4 + 1] = clamp01(s[1]) * 255;
      d[i * 4 + 2] = clamp01(s[2]) * 255;
      d[i * 4 + 3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0);
    this.texture.source.update();
    this.revision++;
    this.deriveHazard();
  }

  /**
   * Hazard color invariant: LUT color at platform luminance, hue +150–210°,
   * +25% saturation, then verify ≥3:1 contrast vs the platform color —
   * if the palette refuses, push toward signal red/white.
   */
  private deriveHazard(): void {
    const d = this.img.data;
    const pi = Math.round(0.55 * 255) * 4;
    const pr = d[pi] / 255;
    const pg = d[pi + 1] / 255;
    const pb = d[pi + 2] / 255;
    this.platformColor[0] = pr;
    this.platformColor[1] = pg;
    this.platformColor[2] = pb;

    const s = this.scratch;
    hueRotate(pr, pg, pb, Math.PI, s); // +180° (middle of 150–210 band)
    // +25% saturation
    const l = (s[0] + s[1] + s[2]) / 3;
    let hr = clamp01(l + (s[0] - l) * 1.25);
    let hg = clamp01(l + (s[1] - l) * 1.25);
    let hb = clamp01(l + (s[2] - l) * 1.25);
    // brighten hazards so they carry the warning pulse
    const boost = 1.35;
    hr = clamp01(hr * boost);
    hg = clamp01(hg * boost);
    hb = clamp01(hb * boost);

    const platLum = relLum(pr, pg, pb);
    let ratio = contrastRatio(relLum(hr, hg, hb), platLum);
    if (ratio < 3) {
      // push toward signal white or deep signal red — whichever pole can
      // actually beat 3:1 against this platform (white maxes out at
      // 1.05/(lum+0.05); the deep red pole has lum ≈ 0.05)
      const whiteRatio = 1.05 / (platLum + 0.05);
      const darkRatio = (platLum + 0.05) / (0.049 + 0.05);
      const towardWhite = whiteRatio >= darkRatio;
      const tr = towardWhite ? 1.0 : 0.22;
      const tg = towardWhite ? 0.95 : 0.0;
      const tb = towardWhite ? 0.92 : 0.03;
      for (let k = 0; k < 8 && ratio < 3; k++) {
        hr = lerp(hr, tr, 0.5);
        hg = lerp(hg, tg, 0.5);
        hb = lerp(hb, tb, 0.5);
        ratio = contrastRatio(relLum(hr, hg, hb), platLum);
      }
    }
    this.hazardColor[0] = hr;
    this.hazardColor[1] = hg;
    this.hazardColor[2] = hb;
    this.hazardContrast = Math.round(ratio * 100) / 100;
  }

  /** current color at t∈[0,1] as 0..1 floats written into out */
  colorFloatAt(t: number, out: Float32Array): void {
    const i = Math.min(255, Math.max(0, Math.round(t * 255))) * 4;
    const d = this.img.data;
    out[0] = d[i] / 255;
    out[1] = d[i + 1] / 255;
    out[2] = d[i + 2] / 255;
  }

  /** current color at t∈[0,1] as CSS — for DOM/HUD tinting */
  colorAt(t: number): string {
    const i = Math.min(255, Math.max(0, Math.round(t * 255))) * 4;
    const d = this.img.data;
    return `rgb(${d[i]},${d[i + 1]},${d[i + 2]})`;
  }
}
