import { Graphics } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import type { TrackField } from '../game/track';
import type { PaletteLut } from './palette';

/**
 * Projected world drawing: obstacles and coins, painter-ordered far→near,
 * redrawn each frame into one Graphics (a few dozen shapes at most).
 * Coordinates: world x lateral, y up, z forward. The projection is the
 * exact inverse of the cave shader's ray-cast, so bars sit ON the floor
 * and gates stand IN the corridor.
 */

export interface Cam {
  x: number;
  y: number;
  z: number;
}

export interface Projected {
  /** pixel coords in the square target (y down) */
  px: number;
  py: number;
  /** pixels per world unit at this depth */
  k: number;
  /** depth in front of the camera */
  dz: number;
}

/** world → square-target pixels; S = square side in device px */
export function project(cam: Cam, S: number, wx: number, wy: number, wz: number, out: Projected): boolean {
  const dz = wz - cam.z;
  if (dz < 0.4) return false;
  const k = TUNING.CAM_F / dz;
  const cx = (wx - cam.x) * k;
  const cy = (wy - cam.y) * k + TUNING.VP_Y;
  out.px = (cx * 0.5 + 0.5) * S;
  out.py = (0.5 - cy * 0.5) * S;
  out.k = k * S * 0.5;
  out.dz = dz;
  return true;
}

const P1: Projected = { px: 0, py: 0, k: 0, dz: 0 };
const P2: Projected = { px: 0, py: 0, k: 0, dz: 0 };
const P3: Projected = { px: 0, py: 0, k: 0, dz: 0 };
const P4: Projected = { px: 0, py: 0, k: 0, dz: 0 };

function rgb(c: ArrayLike<number>): number {
  const r = Math.min(255, Math.round(c[0] * 255));
  const g = Math.min(255, Math.round(c[1] * 255));
  const b = Math.min(255, Math.round(c[2] * 255));
  return (r << 16) | (g << 8) | b;
}

export class WorldLayer {
  readonly gfx = new Graphics();

  /** redraw all visible obstacles & coins */
  update(
    track: TrackField,
    cam: Cam,
    S: number,
    lut: PaletteLut,
    time: number,
    beat: number
  ): void {
    const g = this.gfx;
    g.clear();
    const hazCol = rgb(lut.hazardColor);
    const wallCol = rgb(lut.platformColor);
    const scratch = new Float32Array(3);
    lut.colorFloatAt(0.9, scratch);
    const coinCol = rgb(scratch);
    lut.colorFloatAt(0.98, scratch);
    const hotCol = rgb(scratch);
    const L = TUNING.LANE_X;

    // far → near painter's order (obstacles are z-sorted by construction)
    for (let i = track.obstacles.length - 1; i >= 0; i--) {
      const o = track.obstacles[i];
      const dz = o.z - cam.z;
      if (dz <= 0.5 || dz > TUNING.HORIZON_Z) continue;
      const cx = o.lane * L;
      const fade = Math.max(0, Math.min(1, 1.25 - dz / (TUNING.HORIZON_Z * 0.85)));
      // telegraph: obstacles pulse harder as they close in
      const pulse = dz < 18 ? 0.75 + 0.25 * beat : 0.9;
      const a = fade * pulse;

      if (o.kind === 'gate') {
        // crystal wall: filled lane-wide slab, floor to 2.5, bright rim
        if (!project(cam, S, cx - L * 0.5, 0, o.z, P1)) continue;
        project(cam, S, cx + L * 0.5, 0, o.z, P2);
        project(cam, S, cx + L * 0.5, 2.5, o.z, P3);
        project(cam, S, cx - L * 0.5, 2.5, o.z, P4);
        g.poly([P1.px, P1.py, P2.px, P2.py, P3.px, P3.py, P4.px, P4.py])
          .fill({ color: wallCol, alpha: 0.34 * a })
          .stroke({ color: wallCol, alpha: 0.95 * a, width: Math.max(1.5, P1.k * 0.07) });
        // inner facet lines give it a cut-gem read
        const mx = (P1.px + P2.px) / 2;
        const my = (P4.py + P1.py) / 2;
        g.moveTo(P1.px, P1.py).lineTo(mx, my).lineTo(P4.px, P4.py)
          .moveTo(P2.px, P2.py).lineTo(mx, my).lineTo(P3.px, P3.py)
          .stroke({ color: hotCol, alpha: 0.5 * a, width: Math.max(1, P1.k * 0.035) });
      } else if (o.kind === 'low') {
        // shin-height laser between two emitter posts — jump it
        const y = TUNING.LOW_BAR_Y;
        if (!project(cam, S, cx - L * 0.46, y, o.z, P1)) continue;
        project(cam, S, cx + L * 0.46, y, o.z, P2);
        const w = Math.max(1.5, P1.k * 0.09);
        g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
          .stroke({ color: hazCol, alpha: 0.28 * a, width: w * 3.2 });
        g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
          .stroke({ color: hazCol, alpha: 0.95 * a, width: w * 1.2 });
        g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
          .stroke({ color: 0xffffff, alpha: 0.85 * a, width: Math.max(1, w * 0.4) });
        // emitter posts down to the floor
        project(cam, S, cx - L * 0.46, 0, o.z, P3);
        project(cam, S, cx + L * 0.46, 0, o.z, P4);
        g.moveTo(P1.px, P1.py).lineTo(P3.px, P3.py)
          .moveTo(P2.px, P2.py).lineTo(P4.px, P4.py)
          .stroke({ color: hazCol, alpha: 0.7 * a, width: Math.max(1, w * 0.5) });
        g.circle(P1.px, P1.py, w).circle(P2.px, P2.py, w).fill({ color: 0xffffff, alpha: 0.9 * a });
      } else {
        // overhead laser curtain hanging to HIGH_BAR_Y — roll under it
        const yB = TUNING.HIGH_BAR_Y;
        const yT = 2.6;
        if (!project(cam, S, cx - L * 0.46, yB, o.z, P1)) continue;
        project(cam, S, cx + L * 0.46, yB, o.z, P2);
        project(cam, S, cx + L * 0.46, yT, o.z, P3);
        project(cam, S, cx - L * 0.46, yT, o.z, P4);
        g.poly([P1.px, P1.py, P2.px, P2.py, P3.px, P3.py, P4.px, P4.py])
          .fill({ color: hazCol, alpha: 0.18 * a });
        const w = Math.max(1.5, P1.k * 0.09);
        // the deadly bottom edge burns brightest
        g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
          .stroke({ color: hazCol, alpha: 0.3 * a, width: w * 3 });
        g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
          .stroke({ color: hazCol, alpha: 0.95 * a, width: w * 1.2 });
        g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
          .stroke({ color: 0xffffff, alpha: 0.85 * a, width: Math.max(1, w * 0.4) });
        g.circle(P1.px, P1.py, w).circle(P2.px, P2.py, w).fill({ color: 0xffffff, alpha: 0.9 * a });
      }
    }

    // coins: spinning prisms riding chest height down their lane
    for (const c of track.coins) {
      if (c.taken) continue;
      const dz = c.z - cam.z;
      if (dz <= 0.5 || dz > TUNING.HORIZON_Z) continue;
      if (!project(cam, S, c.lane * L, 0.9, c.z, P1)) continue;
      const fade = Math.max(0, Math.min(1, 1.25 - dz / (TUNING.HORIZON_Z * 0.85)));
      const spin = 0.55 + 0.45 * Math.abs(Math.sin(time * 4 + c.z * 0.7));
      const r = Math.max(1.5, P1.k * 0.16);
      g.circle(P1.px, P1.py, r * 1.8).fill({ color: coinCol, alpha: 0.16 * fade });
      g.poly([
        P1.px, P1.py - r,
        P1.px + r * spin, P1.py,
        P1.px, P1.py + r,
        P1.px - r * spin, P1.py,
      ]).fill({ color: coinCol, alpha: 0.95 * fade })
        .stroke({ color: 0xffffff, alpha: 0.8 * fade, width: 1 });
    }
  }
}
