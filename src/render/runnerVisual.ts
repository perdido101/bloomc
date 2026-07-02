import { Container, Graphics } from 'pixi.js';

/**
 * The light-runner, seen from behind — a wraith of living light sprinting
 * into the kaleidoscope. Everything is drawn with bezier curves: a flowing
 * cloak that ripples with the stride, a pointed cowl, ribbon trails
 * streaming off the shoulders, sinuous light-legs. Layered glow discipline
 * (dark silhouette → palette aura → white-hot core) keeps it readable over
 * ANY generated palette, and the post chain's ink mode inverts it into a
 * brushed-ink figure automatically.
 *
 * Poses: run (legs pump, cloak ripples), jump (tuck, cloak flares),
 * roll (a spinning comma of light), lane lean (whole body banks).
 */

export type RunnerPose = 'run' | 'jump' | 'roll';

export interface RunnerPoseIn {
  /** pixel coords in the square target (y down) of the runner's FEET */
  px: number;
  py: number;
  /** pixels per world unit at the runner's depth */
  k: number;
  /** height above floor, world units */
  y: number;
  /** signed lean from lane changes */
  lean: number;
  pose: RunnerPose;
  /** stride phase 0..1 (from distance run) */
  stride: number;
  /** roll progress 0..1 */
  rollP: number;
  /** jump progress 0..1 */
  jumpP: number;
}

export class RunnerVisual {
  root = new Container();
  /** live palette accent (0..1 floats), fed from the LUT each frame */
  readonly glowColor = new Float32Array([0.6, 0.9, 1.0]);
  private shadow = new Graphics();
  private body = new Graphics();
  private visT = 0;

  constructor() {
    this.root.addChild(this.shadow, this.body);
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
    const sh = this.shadow;
    g.clear();
    sh.clear();

    const h = p.k * 1.6;            // standing height in px
    const glow = this.glowRGB(1);
    const glowHot = this.glowRGB(1.35);
    const dark = 0x05060d;
    const cyc = p.stride * Math.PI * 2; // one full stride cycle

    // ---- floor shadow / light pool (reads jump height) ----
    const shScale = 1 / (1 + p.y * 0.55);
    sh.ellipse(p.px, p.py, h * 0.30 * shScale, h * 0.08 * shScale)
      .fill({ color: 0x000000, alpha: 0.2 * shScale });
    sh.ellipse(p.px, p.py, h * 0.48 * shScale, h * 0.13 * shScale)
      .fill({ color: glow, alpha: 0.15 * shScale });

    // feet-anchor rises with jumps; a soft bob rides the stride
    const bob = p.pose === 'run' ? Math.abs(Math.sin(cyc)) * h * 0.035 : 0;
    const fy = p.py - p.y * p.k - bob;

    if (p.pose === 'roll') {
      // a spinning comma of light hugging the floor
      const r = h * 0.26;
      const cy = p.py - r;
      const a0 = p.rollP * Math.PI * 4;
      g.circle(p.px, cy, r * 1.5).fill({ color: glow, alpha: 0.16 });
      g.circle(p.px, cy, r).fill({ color: dark, alpha: 0.92 })
        .stroke({ color: glow, alpha: 0.9, width: Math.max(1.5, h * 0.05) });
      g.arc(p.px, cy, r * 0.62, a0, a0 + 1.9)
        .stroke({ color: glowHot, alpha: 0.9, width: Math.max(1.5, h * 0.05) });
      g.arc(p.px, cy, r * 0.3, a0 + 2.5, a0 + 4.1)
        .stroke({ color: 0xffffff, alpha: 0.95, width: Math.max(1, h * 0.035) });
      g.moveTo(p.px - r * 1.6, cy + r * 0.5).lineTo(p.px - r * 0.4, cy + r * 0.5)
        .moveTo(p.px - r * 1.3, cy - r * 0.2).lineTo(p.px - r * 0.2, cy - r * 0.2)
        .stroke({ color: glow, alpha: 0.5, width: Math.max(1, h * 0.03) });
      return;
    }

    const lean = Math.max(-0.45, Math.min(0.45, p.lean * 0.16));
    const jump = p.pose === 'jump';
    const tuck = jump ? 0.88 + 0.12 * Math.abs(1 - p.jumpP * 2) : 1;
    const bh = h * tuck;             // body height
    const hipY = fy - bh * 0.46;
    const shoY = fy - bh * 0.74;
    const headY = fy - bh * 0.87;
    const lx = (t: number) => p.px + lean * bh * t; // lean shear by height

    // ---- legs: sinuous strokes of light, pumping with the stride ----
    const stepA = Math.sin(cyc);
    const stepB = Math.sin(cyc + Math.PI);
    const legW = Math.max(1.5, bh * 0.06);
    const drawLeg = (side: number, s: number) => {
      const hipX = lx(0.46) + side * bh * 0.08;
      let fx: number, fyy: number, kx: number, ky: number;
      if (jump) {
        kx = hipX + side * bh * 0.10;
        ky = hipY + bh * 0.20;
        fx = hipX - bh * 0.06 + side * bh * 0.04;
        fyy = hipY + bh * 0.30;
      } else {
        kx = hipX + s * bh * 0.10;
        ky = hipY + bh * 0.26;
        fx = hipX + s * bh * 0.20;
        fyy = fy - bh * 0.02 - Math.max(0, s) * bh * 0.12;
      }
      g.moveTo(hipX, hipY).quadraticCurveTo(kx, ky, fx, fyy)
        .stroke({ color: glow, alpha: 0.95, width: legW, cap: 'round' });
      g.moveTo(hipX, hipY).quadraticCurveTo(kx, ky, fx, fyy)
        .stroke({ color: 0xffffff, alpha: 0.55, width: legW * 0.4, cap: 'round' });
      const spark = jump ? 0.4 : Math.max(0, -s);
      if (spark > 0.1) {
        g.circle(fx, fyy, legW * (0.7 + spark * 0.7))
          .fill({ color: 0xffffff, alpha: 0.45 + 0.4 * spark });
      }
    };
    drawLeg(-1, stepA);
    drawLeg(1, stepB);

    // ---- ribbon trails: light streaming off the shoulders ----
    const ribW = Math.max(1, bh * 0.028);
    for (const side of [-1, 1]) {
      const sx = lx(0.72) + side * bh * 0.14;
      const w1 = Math.sin(time * 11 + side * 2.1) * bh * 0.05;
      const w2 = Math.sin(time * 9 + side * 4.4) * bh * 0.09;
      g.moveTo(sx, shoY + bh * 0.04)
        .bezierCurveTo(
          sx + side * bh * 0.22, shoY + bh * 0.22 + w1,
          sx + side * bh * 0.30 + w2, shoY + bh * 0.46,
          sx + side * bh * (jump ? 0.46 : 0.34), shoY + bh * (jump ? 0.52 : 0.66) + w2
        )
        .stroke({ color: glow, alpha: 0.42, width: ribW, cap: 'round' });
    }

    // ---- the cloak: one flowing bezier silhouette, hem rippling ----
    const swy = (ph: number) => Math.sin(time * 12 + ph) * bh * 0.028 * (jump ? 2 : 1);
    const hemY = hipY + bh * 0.08 - (jump ? bh * 0.10 : 0);
    const hw = bh * (jump ? 0.42 : 0.30 + 0.02 * Math.sin(cyc * 2)); // hem half-width
    const shoW = bh * 0.15;
    const Ls = lx(0.72) - shoW;
    const Rs = lx(0.72) + shoW;
    g.moveTo(Ls, shoY)
      // left side: bells outward to the hem
      .bezierCurveTo(
        lx(0.6) - bh * 0.26, shoY + bh * 0.16,
        lx(0.46) - hw, hemY - bh * 0.10,
        lx(0.44) - hw, hemY + swy(0)
      )
      // rippling hem: two soft scallops
      .quadraticCurveTo(lx(0.44) - hw * 0.45, hemY + bh * 0.10 + swy(2.2), lx(0.44), hemY + bh * 0.05 + swy(4.1))
      .quadraticCurveTo(lx(0.44) + hw * 0.45, hemY + bh * 0.11 + swy(5.6), lx(0.44) + hw, hemY + swy(1.3))
      // right side back up to the shoulder
      .bezierCurveTo(
        lx(0.46) + hw, hemY - bh * 0.10,
        lx(0.6) + bh * 0.26, shoY + bh * 0.16,
        Rs, shoY
      )
      // rounded shoulders over the top
      .quadraticCurveTo(lx(0.74), shoY - bh * 0.10, Ls, shoY)
      .fill({ color: dark, alpha: 0.94 })
      .stroke({ color: glow, alpha: 0.85, width: Math.max(1.5, bh * 0.042), join: 'round' });

    // ---- the cowl: a pointed hood swept back by the run ----
    const hx = lx(0.88);
    const hr = bh * 0.115;
    g.moveTo(hx - hr, headY + hr * 0.5)
      .quadraticCurveTo(hx - hr * 1.05, headY - hr * 0.8, hx - hr * 0.15, headY - hr * 1.05)
      // the tip trails behind (down-screen) and flickers
      .quadraticCurveTo(hx + hr * 1.6, headY - hr * 1.3 + swy(3), hx + hr * 1.9, headY - hr * 0.2 + swy(6))
      .quadraticCurveTo(hx + hr * 1.1, headY - hr * 0.1, hx + hr * 0.95, headY + hr * 0.45)
      .quadraticCurveTo(hx, headY + hr * 1.15, hx - hr, headY + hr * 0.5)
      .fill({ color: dark, alpha: 0.96 })
      .stroke({ color: glowHot, alpha: 0.9, width: Math.max(1.2, bh * 0.032), join: 'round' });

    // ---- the light heart: a small white-hot core between the shoulders ----
    const pulse = 1 + 0.12 * Math.sin(time * 6);
    g.circle(lx(0.68), shoY + bh * 0.08, bh * 0.045 * pulse)
      .fill({ color: 0xffffff, alpha: 0.85 });
    g.circle(lx(0.68), shoY + bh * 0.08, bh * 0.10 * pulse)
      .fill({ color: glowHot, alpha: 0.22 });
  }
}
