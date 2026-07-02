import { Graphics } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { cellX, cellY, type TrackField } from '../game/track';
import type { PaletteLut } from './palette';

/**
 * Projected world drawing. The pattern-rings themselves are rendered by
 * the cave shader — they ARE the kaleidoscope — so the only separate
 * objects left are the coins. Coordinates: world x lateral, y up,
 * z forward; the projection is the exact inverse of the shader's
 * ray-cast.
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

function rgb(c: ArrayLike<number>): number {
  const r = Math.min(255, Math.round(c[0] * 255));
  const g = Math.min(255, Math.round(c[1] * 255));
  const b = Math.min(255, Math.round(c[2] * 255));
  return (r << 16) | (g << 8) | b;
}

export class WorldLayer {
  readonly gfx = new Graphics();

  /** redraw the coins */
  update(
    track: TrackField,
    cam: Cam,
    S: number,
    lut: PaletteLut,
    time: number
  ): void {
    const g = this.gfx;
    g.clear();
    const scratch = new Float32Array(3);
    lut.colorFloatAt(0.9, scratch);
    const coinCol = rgb(scratch);

    // coins: spinning prisms riding their cell down the kaleidoscope
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
