import { Container, Graphics } from 'pixi.js';

/**
 * The light-runner, seen from behind — a hooded figure of living light
 * sprinting into the cave. Layered glow discipline (dark silhouette →
 * palette aura → white-hot core) keeps it readable over ANY generated
 * palette, and the post chain's ink mode inverts it into a brushed-ink
 * figure automatically.
 *
 * Poses: run (legs pump with stride), jump (tuck, cape flares), roll
 * (a spinning comma of light), lane lean (whole body banks).
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

    // ---- floor shadow / light pool (reads jump height) ----
    const shScale = 1 / (1 + p.y * 0.55);
    sh.ellipse(p.px, p.py, h * 0.30 * shScale, h * 0.08 * shScale)
      .fill({ color: 0x000000, alpha: 0.2 * shScale });
    sh.ellipse(p.px, p.py, h * 0.48 * shScale, h * 0.13 * shScale)
      .fill({ color: glow, alpha: 0.15 * shScale });

    // feet-anchor moves up with jumps
    const fy = p.py - p.y * p.k;

    g.position.set(0, 0);
    g.pivot.set(0, 0);
    g.rotation = 0;

    if (p.pose === 'roll') {
      // a spinning comma of light hugging the floor
      const r = h * 0.26;
      const cy = fy - r;
      const a0 = p.rollP * Math.PI * 4;
      g.circle(p.px, cy, r * 1.5).fill({ color: glow, alpha: 0.16 });
      g.circle(p.px, cy, r).fill({ color: dark, alpha: 0.92 })
        .stroke({ color: glow, alpha: 0.9, width: Math.max(1.5, h * 0.05) });
      // swirl marks show the spin
      g.arc(p.px, cy, r * 0.62, a0, a0 + 1.9)
        .stroke({ color: glowHot, alpha: 0.9, width: Math.max(1.5, h * 0.05) });
      g.arc(p.px, cy, r * 0.3, a0 + 2.5, a0 + 4.1)
        .stroke({ color: 0xffffff, alpha: 0.95, width: Math.max(1, h * 0.035) });
      // speed streaks behind the ball
      g.moveTo(p.px - r * 1.6, cy + r * 0.5).lineTo(p.px - r * 0.4, cy + r * 0.5)
        .moveTo(p.px - r * 1.3, cy - r * 0.2).lineTo(p.px - r * 0.2, cy - r * 0.2)
        .stroke({ color: glow, alpha: 0.5, width: Math.max(1, h * 0.03) });
      return;
    }

    const lean = Math.max(-0.45, Math.min(0.45, p.lean * 0.16));
    const jump = p.pose === 'jump';
    // tuck: body compresses a touch at the apex
    const tuck = jump ? 0.88 + 0.12 * Math.abs(1 - p.jumpP * 2) : 1;
    const bh = h * tuck;             // body height
    const hipY = fy - bh * 0.46;
    const shoY = fy - bh * 0.76;
    const headY = fy - bh * 0.86;
    const lx = (t: number) => p.px + lean * bh * t; // lean shear by height

    // ---- legs: two strokes of light, pumping with the stride ----
    const stepA = Math.sin(p.stride * Math.PI * 2);
    const stepB = Math.sin(p.stride * Math.PI * 2 + Math.PI);
    const legW = Math.max(1.5, bh * 0.062);
    const legLen = bh * 0.48;
    const drawLeg = (side: number, s: number) => {
      const hipX = lx(0.42) + side * bh * 0.10;
      let kx: number, ky: number, fx: number, fyy: number;
      if (jump) {
        // tucked: knees up, feet back
        kx = hipX + side * bh * 0.06;
        ky = hipY + legLen * 0.35;
        fx = kx - bh * 0.10;
        fyy = ky + legLen * 0.2;
      } else {
        kx = hipX + s * bh * 0.07;
        ky = hipY + legLen * 0.55;
        fx = kx + s * bh * 0.12;
        fyy = hipY + legLen * (0.95 - 0.18 * Math.max(0, s));
      }
      g.moveTo(hipX, hipY).lineTo(kx, ky).lineTo(fx, fyy)
        .stroke({ color: glow, alpha: 0.95, width: legW, cap: 'round', join: 'round' });
      // foot spark on the down-stride
      const spark = jump ? 0.4 : Math.max(0, -s);
      if (spark > 0.1) {
        g.circle(fx, fyy, legW * (0.8 + spark * 0.8))
          .fill({ color: 0xffffff, alpha: 0.5 + 0.4 * spark });
      }
    };
    drawLeg(-1, stepA);
    drawLeg(1, stepB);

    // ---- cape: the hooded cloak, fluttering with speed ----
    const flut = (t: number) =>
      Math.sin(time * 13 + t * 5.2) * bh * 0.035 * (jump ? 1.8 : 1);
    const hemY = hipY + bh * 0.16 - (jump ? bh * 0.12 : 0);
    const capeW = bh * 0.34;
    g.poly([
      lx(0.78) - capeW * 0.55, shoY,                     // left shoulder
      lx(0.78) + capeW * 0.55, shoY,                     // right shoulder
      lx(0.42) + capeW * (jump ? 1.15 : 0.9) + flut(0.9), hemY + flut(0.3),
      lx(0.42) + capeW * 0.3, hemY + bh * 0.05 + flut(0.7),
      lx(0.42) - capeW * 0.3, hemY + bh * 0.05 + flut(0.1),
      lx(0.42) - capeW * (jump ? 1.15 : 0.9) - flut(0.5), hemY + flut(0.9),
    ])
      .fill({ color: dark, alpha: 0.93 })
      .stroke({ color: glow, alpha: 0.85, width: Math.max(1.5, bh * 0.045), join: 'round' });

    // ---- arms: slight opposite swing, seen at the cape's sides ----
    const armW = Math.max(1.2, bh * 0.045);
    const swing = jump ? 0.5 : 1;
    g.moveTo(lx(0.78) - capeW * 0.5, shoY)
      .lineTo(lx(0.6) - capeW * (0.72 + 0.18 * stepB * swing), shoY + bh * 0.22)
      .moveTo(lx(0.78) + capeW * 0.5, shoY)
      .lineTo(lx(0.6) + capeW * (0.72 + 0.18 * stepA * swing), shoY + bh * 0.22)
      .stroke({ color: glow, alpha: 0.8, width: armW, cap: 'round' });

    // ---- hood: round, dark, rimmed with light, overlapping the cape ----
    const hr = bh * 0.12;
    g.circle(lx(0.86), headY, hr)
      .fill({ color: dark, alpha: 0.96 })
      .stroke({ color: glowHot, alpha: 0.9, width: Math.max(1.2, bh * 0.032) });

    // ---- the light heart: a small white-hot core between the shoulders ----
    const pulse = 1 + 0.12 * Math.sin(time * 6);
    g.circle(lx(0.68), shoY + bh * 0.08, bh * 0.045 * pulse)
      .fill({ color: 0xffffff, alpha: 0.85 });
    g.circle(lx(0.68), shoY + bh * 0.08, bh * 0.10 * pulse)
      .fill({ color: glowHot, alpha: 0.22 });
  }
}
