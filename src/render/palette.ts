import { Texture } from 'pixi.js';

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToCss(r: number, g: number, b: number): string {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** Build a 256-entry LUT from evenly spaced gradient stops (smoothed). */
export function buildLut(stops: string[], out: Uint8ClampedArray): void {
  const rgb = stops.map(hexToRgb);
  const n = rgb.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * n;
    const seg = Math.min(n - 1, Math.floor(t));
    let f = t - seg;
    f = f * f * (3 - 2 * f); // smoothstep between stops
    const a = rgb[seg];
    const b = rgb[seg + 1];
    out[i * 4] = a[0] + (b[0] - a[0]) * f;
    out[i * 4 + 1] = a[1] + (b[1] - a[1]) * f;
    out[i * 4 + 2] = a[2] + (b[2] - a[2]) * f;
    out[i * 4 + 3] = 255;
  }
}

/**
 * The palette LUT texture sampled by every shader. Supports crossfading
 * between two phase palettes during a Bloom (CPU-lerped: 256 texels).
 */
export class PaletteLut {
  readonly texture: Texture;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private lutA = new Uint8ClampedArray(1024);
  private lutB = new Uint8ClampedArray(1024);
  private keyA = '';
  private keyB = '';
  private lastMix = -1;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 1;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(256, 1);
    this.texture = Texture.from(this.canvas);
    this.texture.source.style.addressMode = 'clamp-to-edge';
  }

  setBlend(stopsA: string[], stopsB: string[], mix: number): void {
    const kA = stopsA.join();
    const kB = stopsB.join();
    const q = Math.round(mix * 255) / 255;
    if (kA === this.keyA && kB === this.keyB && q === this.lastMix) return;
    if (kA !== this.keyA) {
      buildLut(stopsA, this.lutA);
      this.keyA = kA;
    }
    if (kB !== this.keyB) {
      buildLut(stopsB, this.lutB);
      this.keyB = kB;
    }
    this.lastMix = q;
    const d = this.img.data;
    for (let i = 0; i < 1024; i++) {
      d[i] = this.lutA[i] + (this.lutB[i] - this.lutA[i]) * q;
    }
    this.ctx.putImageData(this.img, 0, 0);
    this.texture.source.update();
  }

  /** current blended color at t∈[0,1], as CSS — for DOM/HUD tinting */
  colorAt(t: number): string {
    const i = Math.min(255, Math.max(0, Math.round(t * 255))) * 4;
    const d = this.img.data;
    return rgbToCss(d[i], d[i + 1], d[i + 2]);
  }
}

/** mid-palette color of a stop list (for tints outside the LUT flow) */
export function midColor(stops: string[]): [number, number, number] {
  const a = hexToRgb(stops[1]);
  const b = hexToRgb(stops[2]);
  return [(a[0] + b[0]) / 510, (a[1] + b[1]) / 510, (a[2] + b[2]) / 510];
}
