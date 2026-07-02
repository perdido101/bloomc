import { TUNING } from './difficulty';
import { TrackField, type Obstacle } from './track';

/* ------------------------------------------------------------------ */
/*  Input — classic runner gestures, one thumb:                         */
/*    swipe ⇄       = change lane                                       */
/*    swipe ↑ / tap = jump (over LOW lasers)                            */
/*    swipe ↓       = roll (under HIGH lasers); mid-air = fast fall     */
/*  Desktop: ←/→ or A/D lanes · Space/↑ jump · ↓/S roll · Esc pause.    */
/*  Swipes fire the moment the finger crosses the threshold — no        */
/*  waiting for release.                                                */
/* ------------------------------------------------------------------ */

/** what the Runner consumes — tests provide doubles of this */
export interface RunnerInput {
  consumeLane(): number;
  consumeJump(): boolean;
  consumeRoll(): boolean;
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
  private jumpQueued = false;
  private rollQueued = false;
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
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        this.jumpQueued = true;
        e.preventDefault();
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.rollQueued = true;
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
    } else if (dy < 0) {
      this.jumpQueued = true;
    } else {
      this.rollQueued = true;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const t = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    if (!t || t.swiped) return;
    const dt = performance.now() - t.t;
    if (t.moved <= TUNING.TAP_SLOP_PX && dt <= TUNING.TAP_MAX_MS) {
      this.jumpQueued = true; // tap = jump
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

  consumeJump(): boolean {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  consumeRoll(): boolean {
    const r = this.rollQueued;
    this.rollQueued = false;
    return r;
  }

  clear(): void {
    this.laneQueued = 0;
    this.jumpQueued = false;
    this.rollQueued = false;
    this.touches.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  The Runner: auto-run down the cave; dodge, jump, roll.              */
/* ------------------------------------------------------------------ */

export type CrashCause = 'gate' | 'laser';

export interface RunnerEvents {
  onLane?: (dir: number) => void;
  onJump?: () => void;
  onRoll?: () => void;
  /** cleanly passed an obstacle event plane */
  onPass?: (closeCall: boolean) => void;
  onCoin?: (count: number) => void;
  onDie?: (cause: CrashCause) => void;
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
  /** height above the floor */
  y = 0;
  /** target lane −1 | 0 | +1 */
  lane = 0;
  alive = true;
  /** current forward speed (world units/s) */
  speed = 0;
  /** jump time remaining */
  jumpT = 0;
  /** roll time remaining */
  rollT = 0;
  /** lateral velocity estimate, for the animator's lean */
  lean = 0;

  private baseSpeed: number = TUNING.RUN_SPEED0;
  private tweenFrom = 0;
  private tweenT = 1; // 1 = settled
  private jumpBuffered = false;
  private lastEventZ = -Infinity;

  reset(): void {
    this.z = 0;
    this.x = 0;
    this.y = 0;
    this.lane = 0;
    this.alive = true;
    this.speed = 0;
    this.jumpT = 0;
    this.rollT = 0;
    this.lean = 0;
    this.baseSpeed = TUNING.RUN_SPEED0;
    this.tweenFrom = 0;
    this.tweenT = 1;
    this.jumpBuffered = false;
    this.lastEventZ = -Infinity;
  }

  get airborne(): boolean {
    return this.jumpT > 0;
  }

  get rolling(): boolean {
    return this.rollT > 0;
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
        this.tweenFrom = this.x;
        this.lane = target;
        this.tweenT = 0;
        ev.onLane?.(Math.sign(steps));
      }
    }
    const prevX = this.x;
    if (this.tweenT < 1) {
      this.tweenT = Math.min(1, this.tweenT + dt / TUNING.LANE_TWEEN_S);
      this.x =
        this.tweenFrom +
        (this.lane * TUNING.LANE_X - this.tweenFrom) * easeOutCubic(this.tweenT);
    } else {
      this.x = this.lane * TUNING.LANE_X;
    }
    this.lean = this.lean * Math.exp(-10 * dt) + (this.x - prevX) * 6;

    // --- jump / roll ---
    if (input.consumeJump()) {
      if (this.jumpT <= 0) {
        this.jumpT = TUNING.JUMP_S;
        this.rollT = 0;
        ev.onJump?.();
      } else if (this.jumpT < TUNING.JUMP_S * 0.35) {
        this.jumpBuffered = true; // landing soon: buffer the next hop
      }
    }
    if (input.consumeRoll()) {
      if (this.jumpT > 0) {
        // mid-air swipe down = fast fall
        this.jumpT = Math.min(this.jumpT, TUNING.JUMP_S * 0.12);
      } else {
        this.rollT = TUNING.ROLL_S;
        ev.onRoll?.();
      }
    }
    if (this.jumpT > 0) {
      this.jumpT = Math.max(0, this.jumpT - dt);
      if (this.jumpT === 0 && this.jumpBuffered) {
        this.jumpBuffered = false;
        this.jumpT = TUNING.JUMP_S;
        ev.onJump?.();
      }
    }
    if (this.rollT > 0) this.rollT = Math.max(0, this.rollT - dt);
    const p = this.jumpT > 0 ? 1 - this.jumpT / TUNING.JUMP_S : -1;
    this.y = p >= 0 ? TUNING.JUMP_H * Math.sin(Math.PI * p) : 0;

    // --- obstacle crossings this frame ---
    const hits = track.crossings(prevZ, this.z);
    if (hits.length > 0) {
      let closeCall = false;
      let passedPlane = false;
      for (const o of hits) {
        const d = Math.abs(this.x - o.lane * TUNING.LANE_X);
        if (d < TUNING.COLLIDE_HALF_X) {
          if (!this.clears(o)) {
            this.alive = false;
            ev.onDie?.(o.kind === 'gate' ? 'gate' : 'laser');
            return;
          }
        } else if (d < TUNING.LANE_X * 1.05) {
          closeCall = true; // skimmed right past a blocked lane
        }
        if (o.z !== this.lastEventZ) {
          this.lastEventZ = o.z;
          passedPlane = true;
        }
      }
      if (passedPlane) ev.onPass?.(closeCall);
    }

    // --- coins ---
    const got = track.collectCoins(prevZ, this.z, this.x);
    if (got > 0) ev.onCoin?.(got);
  }

  /** does the current pose clear obstacle o in-lane? */
  private clears(o: Obstacle): boolean {
    switch (o.kind) {
      case 'low':
        return this.y > TUNING.LOW_BAR_Y;
      case 'high':
        return this.rollT > 0 && this.y <= 0.01;
      case 'gate':
        return false;
    }
  }
}
