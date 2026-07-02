import { Graphics } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { cellX, cellY, type TrackField } from '../game/track';
import type { PaletteLut } from './palette';

/**
 * Projected world drawing: the kaleidoscope RINGS and coins, painter-
 * ordered far→near, redrawn each frame into one Graphics. Coordinates:
 * world x lateral, y up, z forward. The projection is the exact inverse
 * of the cave shader's ray-cast, so rings sit IN the tunnel.
 *
 * A ring is a mandala plane across the whole tunnel: a spoked web with a
 * petal wreath around the rim, crystal rosettes sealing the CLOSED cells
 * — and glowing portal openings at the GAPS you fly through.
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

function rgb(c: ArrayLike<number>): number {
  const r = Math.min(255, Math.round(c[0] * 255));
  const g = Math.min(255, Math.round(c[1] * 255));
  const b = Math.min(255, Math.round(c[2] * 255));
  return (r << 16) | (g << 8) | b;
}

export class WorldLayer {
  readonly gfx = new Graphics();

  /** redraw all visible rings & coins */
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
    const R = TUNING.TUNNEL_R;
    const yc = TUNING.TUNNEL_Y;

    // far → near painter's order over the rings
    for (let e = track.events.length - 1; e >= 0; e--) {
      const ev = track.events[e];
      const dz = ev.z - cam.z;
      if (dz <= 1.6 || dz > TUNING.HORIZON_Z) continue;
      if (!project(cam, S, 0, yc, ev.z, P1)) continue;
      const k = P1.k;
      const rpx = R * k;
      const fade = Math.max(0, Math.min(1, 1.3 - dz / (TUNING.HORIZON_Z * 0.8)));
      // telegraph: the ring pulses harder as it closes in
      const pulse = dz < 18 ? 0.8 + 0.2 * beat : 0.9;
      const a = fade * pulse;
      const rot = time * 0.12 + ev.z * 0.05;

      // --- the web: rim, inner circle, spokes ---
      g.circle(P1.px, P1.py, rpx)
        .stroke({ color: wallCol, alpha: 0.6 * a, width: Math.max(1.5, k * 0.1) });
      g.circle(P1.px, P1.py, rpx * 0.55)
        .stroke({ color: wallCol, alpha: 0.22 * a, width: Math.max(1, k * 0.04) });
      const n = Math.min(mirrorN, 14);
      for (let i = 0; i < n; i++) {
        const ang = rot + (i * Math.PI * 2) / n;
        g.moveTo(P1.px + Math.cos(ang) * rpx * 0.22, P1.py + Math.sin(ang) * rpx * 0.22)
          .lineTo(P1.px + Math.cos(ang) * rpx, P1.py + Math.sin(ang) * rpx);
      }
      g.stroke({ color: wallCol, alpha: 0.2 * a, width: Math.max(1, k * 0.035) });

      // --- petal wreath around the rim ---
      const wreath = Math.min(mirrorN * 2, 22);
      for (let i = 0; i < wreath; i++) {
        const ang = -rot * 0.7 + (i * Math.PI * 2) / wreath;
        const bx = P1.px + Math.cos(ang) * rpx * 0.86;
        const by = P1.py + Math.sin(ang) * rpx * 0.86;
        const tx = P1.px + Math.cos(ang) * rpx * 1.04;
        const ty = P1.py + Math.sin(ang) * rpx * 1.04;
        const wx = -Math.sin(ang) * rpx * 0.05;
        const wy = Math.cos(ang) * rpx * 0.05;
        g.poly([bx + wx, by + wy, tx, ty, bx - wx, by - wy])
          .fill({ color: wallCol, alpha: 0.35 * a });
      }

      // --- the cells: rosettes seal the pattern; portals are the gaps ---
      for (let c = 0; c < 6; c++) {
        const wx = cellX(c);
        const wy = cellY(c);
        if (!project(cam, S, wx, wy, ev.z, P2)) continue;
        if (ev.open[c]) {
          // an open gap: a portal ring of light — THE way through
          const pr = k * 0.8;
          const spinA = rot * 2 + c;
          // inviting light pools inside the opening
          g.circle(P2.px, P2.py, pr * 0.9).fill({ color: hotCol, alpha: 0.10 * a });
          g.circle(P2.px, P2.py, pr * 0.45).fill({ color: 0xffffff, alpha: 0.08 * a });
          g.circle(P2.px, P2.py, pr * 1.25)
            .stroke({ color: hotCol, alpha: 0.16 * a, width: Math.max(1.5, k * 0.16) });
          g.circle(P2.px, P2.py, pr)
            .stroke({ color: hotCol, alpha: 0.85 * a, width: Math.max(1.5, k * 0.07) });
          g.circle(P2.px, P2.py, pr * 0.92)
            .stroke({ color: 0xffffff, alpha: 0.5 * a, width: Math.max(1, k * 0.025) });
          // orbiting ticks make the opening feel alive
          for (let t2 = 0; t2 < 3; t2++) {
            const ta = spinA + (t2 * Math.PI * 2) / 3;
            g.circle(P2.px + Math.cos(ta) * pr, P2.py + Math.sin(ta) * pr, Math.max(1.5, k * 0.055))
              .fill({ color: 0xffffff, alpha: 0.85 * a });
          }
        } else {
          // sealed: a crystal rosette grown SOLID over the cell
          g.circle(P2.px, P2.py, k * 0.68).fill({ color: 0x05060d, alpha: 0.55 * a });
          const petals = 6;
          for (let pp = 0; pp < petals; pp++) {
            const ang = -rot * 1.4 + (pp * Math.PI * 2) / petals;
            const len = k * 0.72;
            const tx = P2.px + Math.cos(ang) * len;
            const ty = P2.py + Math.sin(ang) * len;
            const sx = -Math.sin(ang) * len * 0.36;
            const sy = Math.cos(ang) * len * 0.36;
            const mx = P2.px + Math.cos(ang) * len * 0.5;
            const my = P2.py + Math.sin(ang) * len * 0.5;
            g.poly([P2.px, P2.py, mx + sx, my + sy, tx, ty, mx - sx, my - sy])
              .fill({ color: hazCol, alpha: 0.62 * a })
              .stroke({ color: hazCol, alpha: 0.95 * a, width: Math.max(1, k * 0.032) });
          }
          g.circle(P2.px, P2.py, k * 0.14).fill({ color: hazCol, alpha: 0.95 * a });
          g.circle(P2.px, P2.py, k * 0.07).fill({ color: 0xffffff, alpha: 0.8 * a });
        }
      }
    }

    // coins: spinning prisms riding their cell down the tunnel
    for (const c of track.coins) {
      if (c.taken) continue;
      const dz = c.z - cam.z;
      if (dz <= 0.5 || dz > TUNING.HORIZON_Z) continue;
      if (!project(cam, S, cellX(c.cell), cellY(c.cell), c.z, P1)) continue;
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
