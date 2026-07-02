import { TUNING } from './difficulty';
import { RingField, SAMPLE_HAZARD, SAMPLE_NONE } from './rings';

/* ------------------------------------------------------------------ */
/*  Input — endless-runner gestures, one thumb:                         */
/*    drag left/right   = steer (rotate the tunnel, 1:1 under finger)   */
/*    quick flick ⇄     = lane hop (eased impulse)                      */
/*    tap               = jump (passes over LOW rings)                  */
/*    swipe up          = dash (burst + smash through one wall)         */
/*    swipe down        = brake (brief slow to line up a door)          */
/*  Desktop: hold ←/→ or A/D steer · Space jump · Shift dash · S brake. */
/* ------------------------------------------------------------------ */

export class Input {
  /** -1..1 keyboard steering */
  steerAxis = 0;
  onPause: (() => void) | null = null;
  onAnyInput: (() => void) | null = null;

  private left = false;
  private right = false;
  private jumpAt = -Infinity;
  private dashAt = -Infinity;
  private brakeAt = -Infinity;
  private dragPx = 0;      // accumulated horizontal drag since last consume
  private hopQueued = 0;   // -1 | 0 | +1
  private touches = new Map<
    number,
    { x: number; y: number; lx: number; t: number; moved: number }
  >();

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
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
        this.left = true;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = true;
        break;
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        this.jumpAt = performance.now();
        e.preventDefault();
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.dashAt = performance.now();
        break;
      case 'ArrowDown':
      case 'KeyS':
        this.brakeAt = performance.now();
        break;
      case 'Escape':
        this.onPause?.();
        break;
    }
    this.steerAxis = (this.right ? 1 : 0) - (this.left ? 1 : 0);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.left = false;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = false;
        break;
    }
    this.steerAxis = (this.right ? 1 : 0) - (this.left ? 1 : 0);
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.onAnyInput?.();
    this.touches.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      lx: e.clientX,
      t: performance.now(),
      moved: 0,
    });
  };

  private onPointerMove = (e: PointerEvent): void => {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    const dx = e.clientX - t.lx;
    t.lx = e.clientX;
    t.moved = Math.max(t.moved, Math.hypot(e.clientX - t.x, e.clientY - t.y));
    this.dragPx += dx;
  };

  private onPointerUp = (e: PointerEvent): void => {
    const t = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    if (!t) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    const dt = performance.now() - t.t;
    const now = performance.now();

    if (t.moved <= TUNING.TAP_SLOP_PX && dt <= TUNING.TAP_MAX_MS) {
      this.jumpAt = now; // tap = jump
      return;
    }
    if (Math.abs(dy) > Math.abs(dx) * 1.4 && Math.abs(dy) >= TUNING.SWIPE_V_MIN_PX) {
      if (dy < 0) this.dashAt = now;
      else this.brakeAt = now;
      return;
    }
    // fast horizontal flick = lane hop (in addition to the drag already applied)
    if (Math.abs(dx) >= TUNING.FLICK_MIN_PX && dt <= TUNING.FLICK_MAX_MS) {
      this.hopQueued = dx > 0 ? 1 : -1;
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
  };

  /** accumulated finger drag since last frame, in px (consumed) */
  consumeDragPx(): number {
    const d = this.dragPx;
    this.dragPx = 0;
    return d;
  }

  consumeHop(): number {
    const h = this.hopQueued;
    this.hopQueued = 0;
    return h;
  }

  jumpBuffered(): boolean {
    return performance.now() - this.jumpAt <= TUNING.JUMP_BUFFER_MS;
  }

  consumeJump(): void {
    this.jumpAt = -Infinity;
  }

  dashQueued(): boolean {
    return performance.now() - this.dashAt <= 150;
  }

  consumeDash(): void {
    this.dashAt = -Infinity;
  }

  brakeQueued(): boolean {
    return performance.now() - this.brakeAt <= 150;
  }

  consumeBrake(): void {
    this.brakeAt = -Infinity;
  }

  clear(): void {
    this.jumpAt = this.dashAt = this.brakeAt = -Infinity;
    this.dragPx = 0;
    this.hopQueued = 0;
    this.touches.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  The Runner: you fly forward; rings rush at you; thread the doors.   */
/* ------------------------------------------------------------------ */

export type CrashCause = 'wall' | 'hazard';

export interface RunnerEvents {
  /** passed ring k; viaDoor=false means jumped over or dashed through */
  onPass?: (k: number, viaDoor: boolean, graze: boolean) => void;
  onJump?: () => void;
  onDash?: () => void;
  onBrake?: () => void;
  onMote?: (count: number) => void;
  onDie?: (cause: CrashCause) => void;
}

export class Runner {
  /** forward flight depth, world units */
  z = 0;
  theta = 0;
  steerVel = 0;
  /** airborne window remaining (passes over LOW rings) */
  jumpT = 0;
  dashT = 0;
  dashCd = 0;
  brakeT = 0;
  brakeCd = 0;
  alive = true;
  /** last ring plane passed */
  ringK = 0;
  /** current forward speed (for the animator/trail) */
  speed = 0;
  /** total steering rate this frame (for the animator) */
  tangentOmega = 0;

  reset(): void {
    this.z = -TUNING.RING_SPACING * 0.5; // half a spacing of runway
    this.theta = Math.random() * Math.PI * 2;
    this.steerVel = 0;
    this.jumpT = 0;
    this.dashT = 0;
    this.dashCd = 0;
    this.brakeT = 0;
    this.brakeCd = 0;
    this.alive = true;
    this.ringK = 0;
    this.speed = 0;
  }

  update(
    dt: number,
    input: Input,
    field: RingField,
    wedge: number,
    forwardSpeed: number,
    ev: RunnerEvents,
    twist = 0
  ): void {
    if (!this.alive || dt <= 0) return;
    const S = TUNING.RING_SPACING;
    this.jumpT = Math.max(0, this.jumpT - dt);
    this.dashT = Math.max(0, this.dashT - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.brakeT = Math.max(0, this.brakeT - dt);
    this.brakeCd = Math.max(0, this.brakeCd - dt);

    // --- steering: drag is 1:1 under the finger; flicks add momentum ---
    const drag = input.consumeDragPx() * TUNING.DRAG_RAD_PER_PX;
    const hop = input.consumeHop();
    if (hop !== 0) this.steerVel += hop * TUNING.HOP_IMPULSE;
    this.steerVel += input.steerAxis * TUNING.STEER_KEY_SPEED * dt * 10;
    const maxSteer = TUNING.STEER_KEY_SPEED * 1.6;
    if (this.steerVel > maxSteer) this.steerVel = maxSteer;
    if (this.steerVel < -maxSteer) this.steerVel = -maxSteer;
    this.theta += drag + this.steerVel * dt;
    this.steerVel *= Math.exp(-TUNING.STEER_DAMP * dt);
    this.tangentOmega = this.steerVel + (dt > 0 ? drag / dt : 0);

    // --- moves ---
    if (input.jumpBuffered()) {
      input.consumeJump();
      this.jumpT = TUNING.JUMP_WINDOW_S;
      ev.onJump?.();
    }
    if (input.dashQueued() && this.dashCd <= 0) {
      input.consumeDash();
      this.dashT = TUNING.DASH_DUR_S;
      this.dashCd = TUNING.DASH_CD_S;
      ev.onDash?.();
    }
    if (input.brakeQueued() && this.brakeCd <= 0) {
      input.consumeBrake();
      this.brakeT = TUNING.BRAKE_DUR_S;
      this.brakeCd = TUNING.BRAKE_CD_S;
      ev.onBrake?.();
    }

    // --- forward flight ---
    let v = forwardSpeed;
    if (this.dashT > 0) v *= TUNING.DASH_SPEED_MUL;
    if (this.brakeT > 0) v *= TUNING.BRAKE_SPEED_MUL;
    this.speed = v;
    const prev = this.z;
    this.z += v * dt;

    // --- aim assist: near a crossing, ease toward a close-by door ---
    const nextPlane = (Math.floor(prev / S) + 1) * S;
    if (nextPlane - this.z < v * 0.3 && field.rings.has(Math.round(nextPlane / S))) {
      const k = Math.round(nextPlane / S);
      const da = field.doorDelta(k, this.theta, wedge, twist);
      if (da !== null && Math.abs(da) <= TUNING.ASSIST_RANGE && da !== 0) {
        const pull = Math.sign(da) * Math.min(Math.abs(da), TUNING.ASSIST_RATE * dt);
        this.theta += pull;
      }
    }

    // --- ring crossings ---
    const loK = Math.floor(prev / S) + 1;
    const hiK = Math.floor(this.z / S);
    for (let k = Math.max(1, loK); k <= hiK; k++) {
      const ring = field.rings.get(k);
      if (!ring) {
        this.ringK = k;
        continue;
      }
      const s = field.sample(k, this.theta, wedge, twist);
      if (s === SAMPLE_NONE) {
        // clean pass through a doorway; grazing the edge is style
        const edge = field.doorEdgeDist(k, this.theta, wedge, twist);
        const graze = edge !== null && edge <= TUNING.GRAZE_RAD;
        ev.onPass?.(k, true, graze);
      } else if (ring.low && this.jumpT > 0) {
        ev.onPass?.(k, false, false); // leapt over a low wall
      } else if (this.dashT > 0) {
        this.dashT = 0; // dash smashes through exactly one obstacle
        ev.onPass?.(k, false, false);
      } else if (s === SAMPLE_HAZARD) {
        this.alive = false;
        ev.onDie?.('hazard');
        return;
      } else {
        this.alive = false;
        ev.onDie?.('wall');
        return;
      }
      this.ringK = k;
    }

    // --- motes ---
    const collected = field.collectMotes(this.z, this.theta, wedge, twist);
    if (collected > 0) ev.onMote?.(collected);
  }
}
