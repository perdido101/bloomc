import { TUNING } from './difficulty';
import {
  RingField,
  SAMPLE_HAZARD,
  SAMPLE_NONE,
  SAMPLE_PLATFORM,
} from './rings';

/* ------------------------------------------------------------------ */
/*  Input: keyboard + touch zones. One-thumb playable.                  */
/*  Touch: center 40% = jump (double-tap = dash), sides = move.         */
/* ------------------------------------------------------------------ */

export class Input {
  /** -1..1 tangential input */
  axis = 0;
  leftHanded = false;
  onPause: (() => void) | null = null;
  onAnyInput: (() => void) | null = null;

  private keyLeft = false;
  private keyRight = false;
  private touchLeft = 0;
  private touchRight = 0;
  private jumpPressedAt = -Infinity;
  private dashPressedAt = -Infinity;
  private lastJumpTapAt = -Infinity;
  private activeZones = new Map<number, string>();
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.onAnyInput?.();
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.keyLeft = true;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.keyRight = true;
        break;
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        this.pressJump();
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
    this.updateAxis();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.keyLeft = false;
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.keyRight = false;
        break;
    }
    this.updateAxis();
  };

  private zoneFor(e: PointerEvent): string {
    const r = this.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const jumpR = Math.min(r.width, r.height) * 0.2; // center 40% = jump
    if (Math.hypot(dx, dy) < jumpR) return 'jump';
    let side = dx < 0 ? 'left' : 'right';
    if (this.leftHanded) side = side === 'left' ? 'right' : 'left';
    return side;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.onAnyInput?.();
    const zone = this.zoneFor(e);
    this.activeZones.set(e.pointerId, zone);
    if (zone === 'jump') this.pressJump();
    else if (zone === 'left') this.touchLeft++;
    else this.touchRight++;
    this.updateAxis();
  };

  private onPointerUp = (e: PointerEvent): void => {
    const zone = this.activeZones.get(e.pointerId);
    this.activeZones.delete(e.pointerId);
    if (zone === 'left') this.touchLeft = Math.max(0, this.touchLeft - 1);
    else if (zone === 'right') this.touchRight = Math.max(0, this.touchRight - 1);
    this.updateAxis();
  };

  private pressJump(): void {
    const now = performance.now();
    // double-tap jump = dash
    if (now - this.lastJumpTapAt < 260) this.dashPressedAt = now;
    this.lastJumpTapAt = now;
    this.jumpPressedAt = now;
  }

  private updateAxis(): void {
    const l = this.keyLeft || this.touchLeft > 0;
    const r = this.keyRight || this.touchRight > 0;
    this.axis = (r ? 1 : 0) - (l ? 1 : 0);
  }

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
  }
}

/* ------------------------------------------------------------------ */
/*  The Shard: polar physics                                            */
/* ------------------------------------------------------------------ */

export interface ShardEvents {
  onJump?: () => void;
  onDash?: () => void;
  onLand?: (ring: number) => void;
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
  /** eased tangential input velocity, rad/s */
  moveVel = 0;
  onRing = true;
  ringK = 0;
  standTime = 0;
  alive = true;
  dashUsed = false;
  intangibleT = 0;
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
    this.coyoteT = 0;
  }

  update(
    dt: number,
    input: Input,
    field: RingField,
    wedge: number,
    ringSpeedMul: number,
    ev: ShardEvents
  ): void {
    if (!this.alive || dt <= 0) return;
    const S = TUNING.RING_SPACING;
    this.intangibleT = Math.max(0, this.intangibleT - dt);
    this.coyoteT = Math.max(0, this.coyoteT - dt);

    const ring = field.rings.get(this.ringK);
    const ringOmega = ring ? ring.omega * field.dirFlip * ringSpeedMul : 0;

    // --- tangential movement (eased); right input = clockwise on screen ---
    if (this.onRing) {
      const maxRel = TUNING.MOVE_MAX_REL * Math.max(0.25, Math.abs(ringOmega));
      const target = -input.axis * maxRel;
      const rate = maxRel / TUNING.MOVE_EASE_S;
      this.moveVel = approach(this.moveVel, target, rate * dt);
      this.theta += (ringOmega + this.moveVel) * dt;
    } else {
      const target = -input.axis * TUNING.AIR_STEER;
      this.moveVel = approach(this.moveVel, target, (TUNING.AIR_STEER / TUNING.MOVE_EASE_S) * dt);
      this.theta += (this.angVel + this.moveVel) * dt;
    }

    // --- standing support / hazards ---
    if (this.onRing) {
      this.standTime += dt;
      const s = field.sample(this.ringK, this.theta, wedge);
      if (s === SAMPLE_HAZARD && this.intangibleT <= 0) {
        this.die('hazard', ev);
        return;
      }
      if (s === SAMPLE_NONE) {
        // walked/rotated off the edge: start falling, grant coyote time
        this.onRing = false;
        this.vel = 0;
        this.angVel = ringOmega + this.moveVel;
        this.coyoteT = TUNING.COYOTE_MS / 1000;
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
      this.vel = TUNING.JUMP_IMPULSE;
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

      if (this.vel < 0) {
        // falling outward: test each ring plane crossed this frame
        const hiK = Math.floor(prev / S);
        const loK = Math.ceil(this.depth / S);
        for (let k = hiK; k >= loK; k--) {
          if (k < 0) break;
          const plane = k * S;
          if (prev < plane || this.depth > plane) continue;
          const s = field.sample(k, this.theta, wedge);
          if (s === SAMPLE_HAZARD && this.intangibleT <= 0) {
            this.die('hazard', ev);
            return;
          }
          if (s === SAMPLE_PLATFORM) {
            this.land(k, ev);
            break;
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
    const collected = field.collectMotes(this.depth, this.theta, wedge);
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
