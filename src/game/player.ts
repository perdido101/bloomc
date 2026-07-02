import { TUNING } from './difficulty';
import {
  RingField,
  SAMPLE_HAZARD,
  SAMPLE_NONE,
  SAMPLE_PLATFORM,
} from './rings';

/* ------------------------------------------------------------------ */
/*  Input — mobile-first, one thumb, no zones to learn:                 */
/*    tap anywhere      = jump                                          */
/*    swipe left/right  = flip run direction                            */
/*    swipe up          = flash-dash                                    */
/*  Desktop: Space/W/↑ jump · A/D or ←/→ set direction · Shift dash.    */
/* ------------------------------------------------------------------ */

export class Input {
  /** run direction in screen terms: +1 = clockwise, -1 = counter-clockwise */
  runDir = 1;
  onPause: (() => void) | null = null;
  onAnyInput: (() => void) | null = null;

  private jumpPressedAt = -Infinity;
  private dashPressedAt = -Infinity;
  private touches = new Map<number, { x: number; y: number; t: number }>();

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    el.addEventListener('pointerdown', this.onPointerDown);
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
        this.runDir = -1;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.runDir = 1;
        break;
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        this.jumpPressedAt = performance.now();
        e.preventDefault();
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.dashPressedAt = performance.now();
        break;
      case 'Escape':
        this.onPause?.();
        break;
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.onAnyInput?.();
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  };

  private onPointerUp = (e: PointerEvent): void => {
    const start = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = performance.now() - start.t;
    const dist = Math.hypot(dx, dy);

    if (dist <= TUNING.TAP_SLOP_PX && dt <= TUNING.TAP_MAX_MS) {
      this.jumpPressedAt = performance.now();
      return;
    }
    if (dist < TUNING.SWIPE_MIN_PX) return;
    if (Math.abs(dy) > Math.abs(dx)) {
      if (dy < 0) this.dashPressedAt = performance.now(); // swipe up
      // swipe down: ignored (reserved)
    } else {
      this.runDir = dx > 0 ? 1 : -1;
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
  };

  /** jump requested within the input buffer window? */
  jumpBuffered(): boolean {
    return performance.now() - this.jumpPressedAt <= TUNING.BUFFER_MS;
  }

  consumeJump(): void {
    this.jumpPressedAt = -Infinity;
  }

  dashQueued(): boolean {
    return performance.now() - this.dashPressedAt <= 150;
  }

  consumeDash(): void {
    this.dashPressedAt = -Infinity;
  }

  clear(): void {
    this.jumpPressedAt = -Infinity;
    this.dashPressedAt = -Infinity;
    this.touches.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  The Climber: polar physics with auto-run and ledge grabs            */
/* ------------------------------------------------------------------ */

export interface ShardEvents {
  onJump?: () => void;
  onDash?: () => void;
  onLand?: (ring: number) => void;
  /** hit the solid underside of a ring while jumping inward */
  onBounce?: (ring: number) => void;
  /** grabbed a ledge and is pulling up onto ring k */
  onGrab?: (ring: number) => void;
  /** left a ring after standing standDur seconds (skim if < window) */
  onLeave?: (standDur: number) => void;
  onMote?: (count: number) => void;
  onDie?: (cause: 'fall' | 'hazard') => void;
}

export class Shard {
  /** radial position, world units; larger = deeper (toward the eye) */
  depth = 0;
  /** radial velocity; positive = inward */
  vel = 0;
  theta = 0;
  /** inherited angular velocity while airborne, rad/s */
  angVel = 0;
  /** eased auto-run velocity, rad/s (world theta terms) */
  moveVel = 0;
  onRing = true;
  ringK = 0;
  standTime = 0;
  alive = true;
  dashUsed = false;
  intangibleT = 0;
  /** 0..1 while pulling up onto a ledge; <0 when not grabbing */
  grabT = -1;
  /** total tangential angular velocity this frame (for the animator) */
  tangentOmega = 0;
  /** escalation compensation (set by the game per tier) */
  jumpBoost = 1;
  coyoteMs: number = TUNING.COYOTE_MS;
  private grabRing = 0;
  private grabFromTheta = 0;
  private grabToTheta = 0;
  private coyoteT = 0;

  reset(): void {
    this.depth = 0;
    this.vel = 0;
    this.theta = Math.random() * Math.PI * 2;
    this.angVel = 0;
    this.moveVel = 0;
    this.onRing = true;
    this.ringK = 0;
    this.standTime = 0;
    this.alive = true;
    this.dashUsed = false;
    this.intangibleT = 0;
    this.grabT = -1;
    this.coyoteT = 0;
  }

  get grabbing(): boolean {
    return this.grabT >= 0;
  }

  update(
    dt: number,
    input: Input,
    field: RingField,
    wedge: number,
    ringSpeedMul: number,
    ev: ShardEvents,
    twist = 0
  ): void {
    if (!this.alive || dt <= 0) return;
    const S = TUNING.RING_SPACING;
    this.intangibleT = Math.max(0, this.intangibleT - dt);
    this.coyoteT = Math.max(0, this.coyoteT - dt);

    // --- ledge pull-up: scripted, then stand ---
    if (this.grabbing) {
      this.tangentOmega = (this.grabToTheta - this.grabFromTheta) / TUNING.GRAB_PULL_S;
      this.grabT += dt / TUNING.GRAB_PULL_S;
      const t = Math.min(1, this.grabT);
      const e = t * t * (3 - 2 * t);
      this.theta = this.grabFromTheta + (this.grabToTheta - this.grabFromTheta) * e;
      this.depth = this.grabRing * S - (1 - e) * 1.4; // hangs just below, pulls up
      if (this.grabT >= 1) {
        this.grabT = -1;
        this.land(this.grabRing, ev);
      }
      return;
    }

    const ring = field.rings.get(this.ringK);
    const ringOmega = ring ? ring.omega * field.dirFlip * ringSpeedMul : 0;
    // auto-run: screen-clockwise = negative theta
    const dirTheta = -input.runDir;
    const runSpeed = Math.max(TUNING.RUN_SPEED_MIN, Math.abs(ringOmega) * TUNING.RUN_SPEED_REL);

    // --- tangential motion ---
    if (this.onRing) {
      const target = dirTheta * runSpeed;
      const rate = runSpeed / TUNING.MOVE_EASE_S;
      this.moveVel = approach(this.moveVel, target, rate * dt);
      this.tangentOmega = ringOmega + this.moveVel;
      this.theta += this.tangentOmega * dt;
    } else {
      const target = dirTheta * TUNING.AIR_DRIFT;
      this.moveVel = approach(this.moveVel, target, (TUNING.AIR_DRIFT / TUNING.MOVE_EASE_S) * dt);
      this.tangentOmega = this.angVel + this.moveVel;
      this.theta += this.tangentOmega * dt;
    }

    // --- standing support / hazards ---
    if (this.onRing) {
      this.standTime += dt;
      const s = field.sample(this.ringK, this.theta, wedge, twist);
      if (s === SAMPLE_HAZARD && this.intangibleT <= 0) {
        this.die('hazard', ev);
        return;
      }
      if (s === SAMPLE_NONE) {
        // ran off the edge: start falling, grant coyote time
        this.onRing = false;
        this.vel = 0;
        this.angVel = ringOmega + this.moveVel;
        this.coyoteT = this.coyoteMs / 1000;
        ev.onLeave?.(this.standTime);
      }
    }

    // --- jump (with input buffer + coyote time) ---
    if (input.jumpBuffered() && (this.onRing || this.coyoteT > 0)) {
      input.consumeJump();
      if (this.onRing) {
        ev.onLeave?.(this.standTime);
        this.angVel = ringOmega + this.moveVel;
      }
      this.onRing = false;
      this.coyoteT = 0;
      this.vel = TUNING.JUMP_IMPULSE * this.jumpBoost;
      this.dashUsed = false;
      ev.onJump?.();
    }

    // --- flash-dash: one per airtime, refreshed on landing ---
    if (!this.onRing && !this.dashUsed && input.dashQueued()) {
      input.consumeDash();
      this.dashUsed = true;
      this.vel = Math.max(this.vel * 0.35, 0) + TUNING.DASH_IMPULSE;
      this.intangibleT = TUNING.DASH_INTANGIBLE_S;
      ev.onDash?.();
    }

    // --- radial integration + ring-plane crossings ---
    if (!this.onRing) {
      this.vel -= TUNING.GRAVITY_OUT * dt;
      const prev = this.depth;
      this.depth += this.vel * dt;

      if (this.vel > 0) {
        // rising inward: solid ring undersides block — only doors let you
        // through. This is the maze.
        const loK = Math.ceil(prev / S + 1e-6);
        const hiK = Math.floor(this.depth / S);
        for (let k = Math.max(1, loK); k <= hiK; k++) {
          if (!field.rings.has(k)) continue;
          const sUp = field.sample(k, this.theta, wedge, twist);
          if (sUp !== SAMPLE_NONE) {
            this.depth = k * S - 0.05;
            this.vel = -this.vel * TUNING.BOUNCE_RESTITUTION;
            ev.onBounce?.(k);
            break;
          }
        }
      }

      if (this.vel < 0) {
        // falling outward: test each ring plane crossed this frame
        const hiK = Math.floor(prev / S);
        const loK = Math.ceil(this.depth / S);
        for (let k = hiK; k >= loK; k--) {
          if (k < 0) break;
          const plane = k * S;
          if (prev < plane || this.depth > plane) continue;
          const s = field.sample(k, this.theta, wedge, twist);
          if (s === SAMPLE_HAZARD && this.intangibleT <= 0) {
            this.die('hazard', ev);
            return;
          }
          if (s === SAMPLE_PLATFORM) {
            this.land(k, ev);
            break;
          }
          // just missed: the climber catches the ledge and pulls up
          const dTheta = field.grabEdge(k, this.theta, wedge, twist);
          if (dTheta !== null) {
            this.grabT = 0;
            this.grabRing = k;
            this.grabFromTheta = this.theta;
            this.grabToTheta = this.theta + dTheta;
            this.vel = 0;
            this.depth = plane - 1.4;
            this.moveVel = 0;
            ev.onGrab?.(k);
            return;
          }
        }
      }

      // fell past the outermost ring of the window: death
      if (!this.onRing && this.depth < (field.minDepth * S) - 2) {
        this.die('fall', ev);
        return;
      }
    }

    // --- motes ---
    const collected = field.collectMotes(this.depth, this.theta, wedge, twist);
    if (collected > 0) ev.onMote?.(collected);
  }

  private land(k: number, ev: ShardEvents): void {
    this.onRing = true;
    this.ringK = k;
    this.depth = k * TUNING.RING_SPACING;
    this.vel = 0;
    this.standTime = 0;
    this.dashUsed = false;
    this.moveVel = 0;
    ev.onLand?.(k);
  }

  private die(cause: 'fall' | 'hazard', ev: ShardEvents): void {
    this.alive = false;
    ev.onDie?.(cause);
  }
}

function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  return Math.max(target, v - maxDelta);
}
