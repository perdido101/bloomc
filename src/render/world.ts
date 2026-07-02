import { Graphics } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import type { TrackField } from '../game/track';
import type { PaletteLut } from './palette';

/**
 * Projected world drawing: obstacles and coins, painter-ordered far→near,
 * redrawn each frame into one Graphics (a few dozen shapes at most).
 * Coordinates: world x lateral, y up, z forward. The projection is the
 * exact inverse of the cave shader's ray-cast, so everything sits ON the
 * kaleidoscope surfaces.
 *
 * Obstacle language: an event with walls draws a full-tunnel mandala
 * MEMBRANE — a spoked web filling the cross-section — whose blocked lanes
 * grow crystal petal fans; the open lane is the gap in the pattern you
 * thread. Lasers are luminous bars with prism teeth (jump the low ones,
 * roll under the hanging ones).
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
    beat: number,
    mirrorN: number
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
    const yc = TUNING.TUNNEL_Y;
    const R = TUNING.TUNNEL_R;

    // far → near painter's order over the EVENTS (grouped by plane)
    for (let e = track.events.length - 1; e >= 0; e--) {
      const ev = track.events[e];
      const dz = ev.z - cam.z;
      if (dz <= 2.5 || dz > TUNING.HORIZON_Z) continue;
      const fade = Math.max(0, Math.min(1, 1.25 - dz / (TUNING.HORIZON_Z * 0.85)));
      // telegraph: obstacles pulse harder as they close in
      const pulse = dz < 18 ? 0.75 + 0.25 * beat : 0.9;
      const a = fade * pulse;
      const hasWall = ev.cells.includes('gate');

      // ---- the membrane: a spoked mandala web across the whole tunnel;
      // the open lane is the GAP in the pattern you run through ----
      if (hasWall && project(cam, S, 0, yc, ev.z, P1)) {
        const rpx = R * P1.k;
        const wa = 0.5 * a;
        g.circle(P1.px, P1.py, rpx)
          .stroke({ color: wallCol, alpha: 0.55 * wa, width: Math.max(1.5, P1.k * 0.09) });
        g.circle(P1.px, P1.py, rpx * 0.62)
          .stroke({ color: wallCol, alpha: 0.3 * wa, width: Math.max(1, P1.k * 0.05) });
        const n = Math.min(mirrorN, 14);
        const rot = time * 0.14;
        for (let i = 0; i < n; i++) {
          const ang = rot + (i * Math.PI * 2) / n;
          g.moveTo(P1.px + Math.cos(ang) * rpx * 0.2, P1.py + Math.sin(ang) * rpx * 0.2)
            .lineTo(P1.px + Math.cos(ang) * rpx, P1.py + Math.sin(ang) * rpx);
        }
        g.stroke({ color: wallCol, alpha: 0.26 * wa, width: Math.max(1, P1.k * 0.035) });
      }

      for (let lane = -1; lane <= 1; lane++) {
        const kind = ev.cells[lane + 1];
        if (kind === 'clear') continue;
        const cx = lane * L;

        if (kind === 'gate') {
          // crystal petal fan blooming out of the floor — the membrane's
          // solid segment over this lane
          for (const pa of [-0.5, 0, 0.5]) {
            const bx = cx;
            const by = 0.12;
            const tx = cx + Math.sin(pa) * 1.15;
            const ty = 0.12 + Math.cos(pa) * 2.3;
            const mx = (bx + tx) / 2;
            const my = (by + ty) / 2;
            // perpendicular in the cross-section plane
            let pxv = ty - by;
            let pyv = bx - tx;
            const pl = Math.hypot(pxv, pyv) || 1;
            pxv = (pxv / pl) * 0.42;
            pyv = (pyv / pl) * 0.42;
            if (!project(cam, S, bx, by, ev.z, P1)) continue;
            project(cam, S, mx + pxv, my + pyv, ev.z, P2);
            project(cam, S, tx, ty, ev.z, P3);
            project(cam, S, mx - pxv, my - pyv, ev.z, P4);
            g.poly([P1.px, P1.py, P2.px, P2.py, P3.px, P3.py, P4.px, P4.py])
              .fill({ color: wallCol, alpha: 0.4 * a })
              .stroke({ color: wallCol, alpha: 0.95 * a, width: Math.max(1.2, P1.k * 0.05) });
            // bright center vein
            g.moveTo(P1.px, P1.py).lineTo(P3.px, P3.py)
              .stroke({ color: hotCol, alpha: 0.55 * a, width: Math.max(1, P1.k * 0.028) });
          }
        } else if (kind === 'low') {
          // shin-height laser between two emitter posts — jump it
          const y = TUNING.LOW_BAR_Y;
          if (!project(cam, S, cx - L * 0.46, y, ev.z, P1)) continue;
          project(cam, S, cx + L * 0.46, y, ev.z, P2);
          const w = Math.max(1.5, P1.k * 0.09);
          g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
            .stroke({ color: hazCol, alpha: 0.28 * a, width: w * 3.2 });
          g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
            .stroke({ color: hazCol, alpha: 0.95 * a, width: w * 1.2 });
          g.moveTo(P1.px, P1.py).lineTo(P2.px, P2.py)
            .stroke({ color: 0xffffff, alpha: 0.85 * a, width: Math.max(1, w * 0.4) });
          // prism teeth along the beam
          for (const f of [0.25, 0.5, 0.75]) {
            const tx = P1.px + (P2.px - P1.px) * f;
            const ty = P1.py + (P2.py - P1.py) * f;
            const r = w * 1.5;
            g.poly([tx, ty - r, tx + r * 0.7, ty, tx, ty + r, tx - r * 0.7, ty])
              .fill({ color: hazCol, alpha: 0.8 * a });
          }
          // emitter posts down to the floor
          project(cam, S, cx - L * 0.46, 0, ev.z, P3);
          project(cam, S, cx + L * 0.46, 0, ev.z, P4);
          g.moveTo(P1.px, P1.py).lineTo(P3.px, P3.py)
            .moveTo(P2.px, P2.py).lineTo(P4.px, P4.py)
            .stroke({ color: hazCol, alpha: 0.7 * a, width: Math.max(1, w * 0.5) });
          g.circle(P1.px, P1.py, w).circle(P2.px, P2.py, w).fill({ color: 0xffffff, alpha: 0.9 * a });
        } else {
          // hanging laser curtain down to HIGH_BAR_Y — roll under it
          const yB = TUNING.HIGH_BAR_Y;
          const yT = 2.8;
          if (!project(cam, S, cx - L * 0.46, yB, ev.z, P1)) continue;
          project(cam, S, cx + L * 0.46, yB, ev.z, P2);
          project(cam, S, cx + L * 0.46, yT, ev.z, P3);
          project(cam, S, cx - L * 0.46, yT, ev.z, P4);
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
          for (const f of [0.3, 0.7]) {
            const tx = P1.px + (P2.px - P1.px) * f;
            const ty = P1.py + (P2.py - P1.py) * f;
            const r = w * 1.4;
            g.poly([tx, ty - r, tx + r * 0.7, ty, tx, ty + r, tx - r * 0.7, ty])
              .fill({ color: hazCol, alpha: 0.8 * a });
          }
          g.circle(P1.px, P1.py, w).circle(P2.px, P2.py, w).fill({ color: 0xffffff, alpha: 0.9 * a });
        }
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
