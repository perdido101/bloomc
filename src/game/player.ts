import { TUNING } from './difficulty';
import { TrackField, cellX, cellY } from './track';

/* ------------------------------------------------------------------ */
/*  Input — one thumb, four swipes:                                     */
/*    swipe ⇄   = change lane                                           */
/*    swipe ↑/↓ = float up / sink down                                  */
/*    tap       = flip height (up if low, down if high)                 */
/*  Desktop: ←/→ or A/D lanes · ↑/W up · ↓/S down · Space flip · Esc.   */
/*  Swipes fire the moment the finger crosses the threshold — no        */
/*  waiting for release.                                                */
/* ------------------------------------------------------------------ */

/** what the Runner consumes — tests provide doubles of this */
export interface RunnerInput {
  consumeLane(): number;
  /** +1 = up, −1 = down, 0 = none (last wins within a frame) */
  consumeVert(): number;
  consumeFlip(): boolean;
}

interface Touch {
  x: number;
  y: number;
  t: number;
  moved: number;
  swiped: boolean;
}

export class Input implements RunnerInput {
  onPause: (() => void) | null = null;
  onAnyInput: (() => void) | null = null;

  private laneQueued = 0; // accumulated ±1 steps
  private vertQueued = 0;
  private flipQueued = false;
  private touches = new Map<number, Touch>();

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.onAnyInput?.();
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.laneQueued -= 1;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.laneQueued += 1;
        break;
      case 'ArrowUp':
      case 'KeyW':
        this.vertQueued = 1;
        e.preventDefault();
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.vertQueued = -1;
        break;
      case 'Space':
        this.flipQueued = true;
        e.preventDefault();
        break;
      case 'Escape':
        this.onPause?.();
        break;
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.onAnyInput?.();
    this.touches.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      moved: 0,
      swiped: false,
    });
  };

  private onPointerMove = (e: PointerEvent): void => {
    const t = this.touches.get(e.pointerId);
    if (!t || t.swiped) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    t.moved = Math.max(t.moved, Math.hypot(dx, dy));
    if (performance.now() - t.t > TUNING.SWIPE_MAX_MS) return;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < TUNING.SWIPE_MIN_PX) return;
    t.swiped = true; // fire immediately at the threshold — feels instant
    if (Math.abs(dx) >= Math.abs(dy)) {
      this.laneQueued += dx > 0 ? 1 : -1;
    } else {
      this.vertQueued = dy < 0 ? 1 : -1;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const t = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    if (!t || t.swiped) return;
    const dt = performance.now() - t.t;
    if (t.moved <= TUNING.TAP_SLOP_PX && dt <= TUNING.TAP_MAX_MS) {
      this.flipQueued = true; // tap = flip height
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
  };

  consumeLane(): number {
    const d = this.laneQueued;
    this.laneQueued = 0;
    return d;
  }

  consumeVert(): number {
    const v = this.vertQueued;
    this.vertQueued = 0;
    return v;
  }

  consumeFlip(): boolean {
    const f = this.flipQueued;
    this.flipQueued = false;
    return f;
  }

  clear(): void {
    this.laneQueued = 0;
    this.vertQueued = 0;
    this.flipQueued = false;
    this.touches.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  The Runner: a cat of light gliding down the kaleidoscope.           */
/*  Rings sweep past; line up with a gap in the pattern or shatter.     */
/* ------------------------------------------------------------------ */

export interface RunnerEvents {
  onLane?: (dir: number) => void;
  onTier?: (dir: number) => void;
  /** flew through a ring's gap; closeCall = brushed the pattern's edge */
  onPass?: (closeCall: boolean) => void;
  onCoin?: (count: number) => void;
  onDie?: () => void;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export class Runner {
  /** forward distance, world units */
  z = 0;
  /** lateral position, world units */
  x = 0;
  /** flight height, world units */
  y: number = TUNING.TIER_Y0;
  /** target lane −1 | 0 | +1 */
  lane = 0;
  /** target height tier 0 | 1 */
  tier = 0;
  alive = true;
  /** current forward speed (world units/s) */
  speed = 0;
  /** lateral velocity estimate, for the animator's bank */
  lean = 0;
  /** vertical velocity estimate, for the animator's pitch */
  vy = 0;

  private baseSpeed: number = TUNING.RUN_SPEED0;
  private laneFrom = 0;
  private laneT = 1; // 1 = settled
  private tierFrom: number = TUNING.TIER_Y0;
  private tierT = 1;

  reset(): void {
    this.z = 0;
    this.x = 0;
    this.y = TUNING.TIER_Y0;
    this.lane = 0;
    this.tier = 0;
    this.alive = true;
    this.speed = 0;
    this.lean = 0;
    this.vy = 0;
    this.baseSpeed = TUNING.RUN_SPEED0;
    this.laneFrom = 0;
    this.laneT = 1;
    this.tierFrom = TUNING.TIER_Y0;
    this.tierT = 1;
  }

  /**
   * @param speedMul pace multiplier from the PhaseManager (Blooms) and
   *                 the takeoff ramp; 1 = base pace.
   */
  update(
    dt: number,
    input: RunnerInput,
    track: TrackField,
    speedMul: number,
    ev: RunnerEvents
  ): void {
    if (!this.alive || dt <= 0) return;

    // --- forward pace: slow, fair ramp toward RUN_SPEED_MAX ---
    this.baseSpeed = Math.min(TUNING.RUN_SPEED_MAX, this.baseSpeed + TUNING.RUN_ACCEL * dt);
    this.speed = this.baseSpeed * speedMul;
    const prevZ = this.z;
    this.z += this.speed * dt;

    // --- lane changes ---
    const steps = input.consumeLane();
    if (steps !== 0) {
      const target = Math.max(-1, Math.min(1, this.lane + steps));
      if (target !== this.lane) {
        this.laneFrom = this.x;
        this.lane = target;
        this.laneT = 0;
        ev.onLane?.(Math.sign(steps));
      }
    }
    const prevX = this.x;
    if (this.laneT < 1) {
      this.laneT = Math.min(1, this.laneT + dt / TUNING.LANE_TWEEN_S);
      this.x = this.laneFrom +
        (this.lane * TUNING.LANE_X - this.laneFrom) * easeOutCubic(this.laneT);
    } else {
      this.x = this.lane * TUNING.LANE_X;
    }
    this.lean = this.lean * Math.exp(-10 * dt) + (this.x - prevX) * 6;

    // --- floating up / down ---
    let vert = input.consumeVert();
    if (input.consumeFlip()) vert = this.tier === 0 ? 1 : -1;
    if (vert !== 0) {
      const target = vert > 0 ? 1 : 0;
      if (target !== this.tier) {
        this.tierFrom = this.y;
        this.tier = target;
        this.tierT = 0;
        ev.onTier?.(vert);
      }
    }
    const prevY = this.y;
    const tierY = this.tier === 0 ? TUNING.TIER_Y0 : TUNING.TIER_Y1;
    if (this.tierT < 1) {
      this.tierT = Math.min(1, this.tierT + dt / TUNING.TIER_TWEEN_S);
      this.y = this.tierFrom + (tierY - this.tierFrom) * easeOutCubic(this.tierT);
    } else {
      this.y = tierY;
    }
    this.vy = this.vy * Math.exp(-8 * dt) + (this.y - prevY) * 5;

    // --- ring crossings: are we inside a gap? ---
    for (const ring of track.crossings(prevZ, this.z)) {
      let safe = false;
      let edge = true;
      for (let c = 0; c < ring.open.length; c++) {
        if (!ring.open[c]) continue;
        const dx = Math.abs(this.x - cellX(c));
        const dy = Math.abs(this.y - cellY(c));
        if (dx <= TUNING.GAP_HALF_X && dy <= TUNING.GAP_HALF_Y) {
          safe = true;
          // dead-center pass is clean; brushing the rim is a close call
          if (dx < TUNING.GAP_HALF_X * 0.55 && dy < TUNING.GAP_HALF_Y * 0.55) edge = false;
        }
      }
      if (!safe) {
        this.alive = false;
        ev.onDie?.();
        return;
      }
      ev.onPass?.(edge);
    }

    // --- coins ---
    const got = track.collectCoins(prevZ, this.z, this.x, this.y);
    if (got > 0) ev.onCoin?.(got);
  }
}
