import { Container, Graphics } from 'pixi.js';

/**
 * The cat of light, seen from behind — GALLOPING down the kaleidoscope.
 * All curves, all motion: a full gallop cycle (gather → drive → stretch)
 * rocks the body, kicks the hind paws, flashes the front paws out past
 * the flanks, bobs the head and ears, and the long S-curve tail flows
 * against it like a rudder. Speed ribbons stream past at pace.
 *
 * Layered glow discipline (dark silhouette → palette aura → white-hot
 * accents) keeps it readable over ANY generated palette; ink mode
 * inverts it into a brushed-ink cat automatically.
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
  /** gallop phase 0..1, driven by distance run */
  runPhase: number;
  /** speed 0..1 of max — stretches the gallop and the ribbons */
  speedN: number;
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

    // ---- the gallop cycle ----
    const ph = p.runPhase * Math.PI * 2;
    const drive = Math.sin(ph);                    // hinds push (+1) / gather (−1)
    const hop = Math.max(0, Math.sin(ph + 0.5));   // airborne arc of the bound
    const gath = Math.max(0, -drive);              // gathered under the body

    const cx = p.px;
    const cy = p.py - hop * h * 0.10 + Math.sin(time * 2.6) * h * 0.02;
    const lx = (t: number) => cx + lean * h * (t - 0.3);
    // the body stretches on the drive, bunches on the gather
    const stretch = 1 + drive * 0.07 + Math.abs(pitch) * 0.2;
    const wide = 1 - drive * 0.05;

    const rumpY = cy + h * 0.42 * stretch;
    const headY = cy - h * 0.34 * stretch + pitch * h * 0.2 - hop * h * 0.045;
    const headR = h * 0.28;
    const bodyW = h * 0.40 * wide;

    // ---- speed ribbons: the world streaking past the cat ----
    const rib = p.speedN;
    if (rib > 0.05) {
      for (const [sx, sy, ln] of [
        [-0.85, 0.15, 0.55], [0.9, -0.05, 0.7], [-0.6, 0.55, 0.4], [0.7, 0.5, 0.5],
      ] as Array<[number, number, number]>) {
        const wob = Math.sin(time * 17 + sx * 9) * h * 0.03;
        const x0 = cx + sx * h * 0.95;
        const y0 = cy + sy * h * 0.9 + wob;
        g.moveTo(x0, y0 - ln * h * rib * 0.5).lineTo(x0, y0 + ln * h * rib * 0.5)
          .stroke({ color: glow, alpha: 0.22 * rib, width: Math.max(1, h * 0.022), cap: 'round' });
      }
    }

    // ---- aura: the cat carries its own light ----
    au.ellipse(cx, cy, h * 0.85, h * 0.95).fill({ color: glow, alpha: 0.10 });
    au.ellipse(cx, cy, h * 0.55, h * 0.62).fill({ color: glow, alpha: 0.10 });

    // ---- tail: a long S-curve rudder, flowing with the bound ----
    const sway = Math.sin(time * 3.1 + drive * 0.8) * h * 0.16 - lean * h * 0.9;
    const sway2 = Math.sin(time * 3.1 + 1.2) * h * 0.12;
    const tailBase = { x: lx(0.9) + h * 0.16, y: rumpY - h * 0.06 };
    const tipY = tailBase.y - h * (0.72 + 0.08 * drive);
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
          tailBase.x + h * 0.30 + sway, tipY
        )
        .stroke({ color: colr, alpha: al, width: w, cap: 'round' });
    }
    g.circle(tailBase.x + h * 0.30 + sway, tipY - h * 0.01, tW * 0.75)
      .fill({ color: 0xffffff, alpha: 0.85 });

    // ---- hind legs: they kick back on the drive, gather on the bound ----
    for (const side of [-1, 1]) {
      const hipX = lx(0.9) + side * bodyW * 0.55;
      const hipYY = rumpY - h * 0.10;
      const phase = drive * (side < 0 ? 1 : 0.85); // slight offset feels alive
      const footX = hipX + side * h * (0.06 + gath * 0.03);
      const footY = hipYY + h * (0.16 + phase * 0.13);
      const kneeX = hipX + side * h * 0.10;
      const kneeY = hipYY + h * (0.05 + phase * 0.05);
      g.moveTo(hipX, hipYY).quadraticCurveTo(kneeX, kneeY, footX, footY)
        .stroke({ color: glow, alpha: 0.95, width: Math.max(1.5, h * 0.07), cap: 'round' });
      g.circle(footX, footY, Math.max(1.5, h * 0.055))
        .fill({ color: 0xffffff, alpha: 0.6 + 0.35 * Math.max(0, phase) });
    }

    // ---- body: a teardrop seen from behind, rocking with the gallop ----
    g.moveTo(lx(0.05) - headR * 0.85, headY + headR * 0.35)
      .bezierCurveTo(
        lx(0.35) - bodyW * 1.15, cy - h * 0.05,
        lx(0.75) - bodyW, rumpY - h * 0.28,
        lx(0.95) - bodyW * 0.78, rumpY
      )
      .quadraticCurveTo(lx(1.0), rumpY + h * 0.16, lx(0.95) + bodyW * 0.78, rumpY)
      .bezierCurveTo(
        lx(0.75) + bodyW, rumpY - h * 0.28,
        lx(0.35) + bodyW * 1.15, cy - h * 0.05,
        lx(0.05) + headR * 0.85, headY + headR * 0.35
      )
      .fill({ color: dark, alpha: 0.94 })
      .stroke({ color: glow, alpha: 0.85, width: Math.max(1.5, h * 0.045), join: 'round' });

    // ---- front paws: flashing out past the flanks on the reach ----
    const reach = Math.max(0, Math.sin(ph + Math.PI * 0.9));
    for (const side of [-1, 1]) {
      const r2 = side < 0 ? reach : Math.max(0, Math.sin(ph + Math.PI * 1.15));
      if (r2 < 0.15) continue;
      const pawX = lx(0.25) + side * (bodyW * 1.05 + r2 * h * 0.10);
      const pawY = cy - h * 0.02 + r2 * h * 0.06;
      g.moveTo(lx(0.3) + side * bodyW * 0.7, cy - h * 0.10)
        .quadraticCurveTo(pawX - side * h * 0.05, pawY - h * 0.08, pawX, pawY)
        .stroke({ color: glow, alpha: 0.8 * r2, width: Math.max(1.2, h * 0.05), cap: 'round' });
      g.circle(pawX, pawY, Math.max(1.5, h * 0.045)).fill({ color: 0xffffff, alpha: 0.7 * r2 });
    }

    // ---- head: round, with two proud ears, bobbing with the bound ----
    g.circle(lx(0.0), headY, headR)
      .fill({ color: dark, alpha: 0.96 })
      .stroke({ color: glow, alpha: 0.9, width: Math.max(1.5, h * 0.045) });
    const earBob = hop * headR * 0.12;
    const flick = Math.max(0, Math.sin(time * 0.9)) ** 24 * 0.35;
    for (const side of [-1, 1]) {
      const ex = lx(0.0) + side * headR * 0.62;
      const ey = headY - headR * 0.62 + earBob;
      const tipX = ex + side * headR * (0.55 + (side > 0 ? flick : 0));
      const tipY2 = ey - headR * (0.95 - (side > 0 ? flick * 0.5 : 0)) + earBob * 0.6;
      g.moveTo(ex - side * headR * 0.30, ey + headR * 0.12)
        .quadraticCurveTo(ex + side * headR * 0.05, ey - headR * 0.5, tipX, tipY2)
        .quadraticCurveTo(ex + side * headR * 0.55, ey + headR * 0.05, ex + side * headR * 0.62, ey + headR * 0.35)
        .fill({ color: dark, alpha: 0.96 })
        .stroke({ color: glow, alpha: 0.9, width: Math.max(1.2, h * 0.038), join: 'round' });
      g.moveTo(ex, ey + headR * 0.05)
        .quadraticCurveTo(ex + side * headR * 0.1, ey - headR * 0.32, tipX - side * headR * 0.1, tipY2 + headR * 0.22)
        .stroke({ color: glowHot, alpha: 0.8, width: Math.max(1, h * 0.03), cap: 'round' });
    }

    // ---- the light heart: collar spark at the neck ----
    const pulse = 1 + 0.12 * Math.sin(time * 6);
    g.circle(lx(0.12), headY + headR * 0.95, h * 0.05 * pulse)
      .fill({ color: 0xffffff, alpha: 0.9 });
    g.circle(lx(0.12), headY + headR * 0.95, h * 0.11 * pulse)
      .fill({ color: glowHot, alpha: 0.25 });
  }
}
