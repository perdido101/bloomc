import { Container, Graphics } from 'pixi.js';

/**
 * The cat of light, seen from behind — gliding down the kaleidoscope.
 * All curves: a round head crowned with two pointed ears (inner glow),
 * a teardrop body, tucked hind paws, and a long tail that sways in an
 * animated S-curve. Layered glow discipline (dark silhouette → palette
 * aura → white-hot accents) keeps it readable over ANY generated
 * palette; ink mode inverts it into a brushed-ink cat automatically.
 *
 * It banks into lane changes, pitches and stretches when floating up or
 * down, and its tail counter-sways like a rudder.
 */

export interface RunnerPoseIn {
  /** pixel coords in the square target (y down) of the cat's CENTER */
  px: number;
  py: number;
  /** pixels per world unit at the cat's depth */
  k: number;
  /** signed bank from lane changes */
  lean: number;
  /** signed vertical velocity (float up/down) */
  vy: number;
}

export class RunnerVisual {
  root = new Container();
  /** live palette accent (0..1 floats), fed from the LUT each frame */
  readonly glowColor = new Float32Array([0.6, 0.9, 1.0]);
  private aura = new Graphics();
  private body = new Graphics();
  private visT = 0;

  constructor() {
    this.root.addChild(this.aura, this.body);
  }

  reset(): void {
    this.visT = 0;
  }

  private glowRGB(mul: number): number {
    const r = Math.min(255, Math.round(this.glowColor[0] * 255 * mul));
    const g = Math.min(255, Math.round(this.glowColor[1] * 255 * mul));
    const b = Math.min(255, Math.round(this.glowColor[2] * 255 * mul));
    return (r << 16) | (g << 8) | b;
  }

  update(dt: number, p: RunnerPoseIn, time: number, visible: boolean): void {
    this.visT = Math.max(0, Math.min(1, this.visT + (visible ? dt * 5 : -dt * 5)));
    this.root.visible = this.visT > 0.01;
    this.root.alpha = this.visT;
    if (!this.root.visible) return;

    const g = this.body;
    const au = this.aura;
    g.clear();
    au.clear();

    const h = p.k * 1.15;           // cat height in px
    const glow = this.glowRGB(1);
    const glowHot = this.glowRGB(1.35);
    const dark = 0x05060d;
    const lean = Math.max(-0.5, Math.min(0.5, p.lean * 0.14));
    const pitch = Math.max(-0.5, Math.min(0.5, p.vy * 0.10));

    // gentle hover bob
    const bob = Math.sin(time * 2.6) * h * 0.05;
    const cx = p.px;
    const cy = p.py + bob;
    // shear by height for the bank; stretch a touch when climbing
    const lx = (t: number) => cx + lean * h * (t - 0.3);
    const stretch = 1 + Math.abs(pitch) * 0.25;

    const rumpY = cy + h * 0.42;
    const headY = cy - h * (0.34 * stretch) + pitch * h * 0.2;
    const headR = h * 0.28;
    const bodyW = h * 0.40;

    // ---- aura: the cat carries its own light ----
    au.ellipse(cx, cy, h * 0.85, h * 0.95).fill({ color: glow, alpha: 0.10 });
    au.ellipse(cx, cy, h * 0.55, h * 0.62).fill({ color: glow, alpha: 0.10 });

    // ---- tail: a long S-curve rudder, always in motion ----
    const sway = Math.sin(time * 3.1) * h * 0.16 - lean * h * 0.9;
    const sway2 = Math.sin(time * 3.1 + 1.2) * h * 0.12;
    const tailBase = { x: lx(0.9) + h * 0.16, y: rumpY - h * 0.06 };
    const tW = Math.max(2, h * 0.085);
    for (const [w, colr, al] of [
      [tW * 2.2, glow, 0.18],
      [tW, glow, 0.9],
      [tW * 0.4, 0xffffff, 0.6],
    ] as Array<[number, number, number]>) {
      g.moveTo(tailBase.x, tailBase.y)
        .bezierCurveTo(
          tailBase.x + h * 0.42, tailBase.y + h * 0.10,
          tailBase.x + h * 0.52 + sway2, tailBase.y - h * 0.42,
          tailBase.x + h * 0.30 + sway, tailBase.y - h * (0.72 + 0.06 * Math.sin(time * 3.1 + 2))
        )
        .stroke({ color: colr, alpha: al, width: w, cap: 'round' });
    }
    // tail-tip star
    g.circle(tailBase.x + h * 0.30 + sway, tailBase.y - h * 0.73, tW * 0.75)
      .fill({ color: 0xffffff, alpha: 0.85 });

    // ---- body: a teardrop seen from behind ----
    g.moveTo(lx(0.05) - headR * 0.85, headY + headR * 0.35)
      .bezierCurveTo(
        lx(0.35) - bodyW * 1.15, cy - h * 0.05,
        lx(0.75) - bodyW, rumpY - h * 0.28,
        lx(0.95) - bodyW * 0.78, rumpY
      )
      // rounded rump bottom
      .quadraticCurveTo(lx(1.0), rumpY + h * 0.16, lx(0.95) + bodyW * 0.78, rumpY)
      .bezierCurveTo(
        lx(0.75) + bodyW, rumpY - h * 0.28,
        lx(0.35) + bodyW * 1.15, cy - h * 0.05,
        lx(0.05) + headR * 0.85, headY + headR * 0.35
      )
      .fill({ color: dark, alpha: 0.94 })
      .stroke({ color: glow, alpha: 0.85, width: Math.max(1.5, h * 0.045), join: 'round' });

    // ---- hind paws, tucked under the rump ----
    for (const side of [-1, 1]) {
      g.ellipse(lx(0.95) + side * bodyW * 0.5, rumpY + h * 0.06, h * 0.11, h * 0.075)
        .fill({ color: dark, alpha: 0.95 })
        .stroke({ color: glow, alpha: 0.75, width: Math.max(1, h * 0.028) });
    }

    // ---- head: round, with two proud ears ----
    g.circle(lx(0.0), headY, headR)
      .fill({ color: dark, alpha: 0.96 })
      .stroke({ color: glow, alpha: 0.9, width: Math.max(1.5, h * 0.045) });
    // ears: pointed curves with hot inner light; they flick now and then
    const flick = Math.max(0, Math.sin(time * 0.9)) ** 24 * 0.35;
    for (const side of [-1, 1]) {
      const ex = lx(0.0) + side * headR * 0.62;
      const ey = headY - headR * 0.62;
      const tipX = ex + side * headR * (0.55 + (side > 0 ? flick : 0));
      const tipY = ey - headR * (0.95 - (side > 0 ? flick * 0.5 : 0));
      g.moveTo(ex - side * headR * 0.30, ey + headR * 0.12)
        .quadraticCurveTo(ex + side * headR * 0.05, ey - headR * 0.5, tipX, tipY)
        .quadraticCurveTo(ex + side * headR * 0.55, ey + headR * 0.05, ex + side * headR * 0.62, ey + headR * 0.35)
        .fill({ color: dark, alpha: 0.96 })
        .stroke({ color: glow, alpha: 0.9, width: Math.max(1.2, h * 0.038), join: 'round' });
      // inner-ear glow
      g.moveTo(ex, ey + headR * 0.05)
        .quadraticCurveTo(ex + side * headR * 0.1, ey - headR * 0.32, tipX - side * headR * 0.1, tipY + headR * 0.22)
        .stroke({ color: glowHot, alpha: 0.8, width: Math.max(1, h * 0.03), cap: 'round' });
    }

    // ---- the light heart: collar spark at the neck ----
    const pulse = 1 + 0.12 * Math.sin(time * 6);
    g.circle(lx(0.12), headY + headR * 0.95, h * 0.05 * pulse)
      .fill({ color: 0xffffff, alpha: 0.9 });
    g.circle(lx(0.12), headY + headR * 0.95, h * 0.11 * pulse)
      .fill({ color: glowHot, alpha: 0.25 });

    // whisker-light: two faint arcs past the head's sides (seen edge-on)
    for (const side of [-1, 1]) {
      g.moveTo(lx(0.0) + side * headR * 0.9, headY + headR * 0.35)
        .quadraticCurveTo(
          lx(0.0) + side * headR * 1.5, headY + headR * 0.45,
          lx(0.0) + side * headR * 1.75, headY + headR * 0.7
        )
        .stroke({ color: glow, alpha: 0.4, width: Math.max(1, h * 0.02), cap: 'round' });
    }
  }
}
