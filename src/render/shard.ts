import { Container, Geometry, Mesh, Shader } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { es300 } from './gfx';

/**
 * The Climber: a procedurally animated neon stickman — the only asymmetric,
 * unmirrored object on screen. White-hot core limbs over a palette-colored
 * glow so he reads on every phase. Poses: run cycle on rings, tuck on the
 * way up, flail on the way down, hang-and-pull-up on ledge grabs, stretch
 * on dash. Plus the signature hue-shifting ribbon trail at his back.
 * All buffers pre-allocated; per-frame updates write in place.
 */

export type ClimberState = 'run' | 'rise' | 'fall' | 'grab' | 'dash';

export interface ClimberPose {
  x: number;          // clip-space position (feet/pelvis anchor)
  y: number;
  posAngle: number;   // angle of the position around the center (incl. viewRot)
  omega: number;      // tangential angular velocity (sign = facing)
  state: ClimberState;
  grabT: number;      // 0..1 during pull-up
  size: number;       // body height in clip units
}

const SEGS = TUNING.TRAIL_SEGMENTS;

// skeleton: 11 joints
const J = {
  pelvis: 0, chest: 1, head: 2,
  lElbow: 3, lHand: 4, rElbow: 5, rHand: 6,
  lKnee: 7, lFoot: 8, rKnee: 9, rFoot: 10,
} as const;
const N_JOINTS = 11;
// limb segments as joint index pairs
const BONES: Array<[number, number, number]> = [
  // [a, b, width multiplier]
  [J.pelvis, J.chest, 1.15],
  [J.chest, J.head, 0.9],
  [J.chest, J.lElbow, 0.85], [J.lElbow, J.lHand, 0.75],
  [J.chest, J.rElbow, 0.85], [J.rElbow, J.rHand, 0.75],
  [J.pelvis, J.lKnee, 0.95], [J.lKnee, J.lFoot, 0.8],
  [J.pelvis, J.rKnee, 0.95], [J.rKnee, J.rFoot, 0.8],
];
// three layers per bone (dark silhouette, palette accent, white core) + head
const N_LAYERS = 3;
const N_QUADS = (BONES.length + 1) * N_LAYERS;

const VERT = /* glsl */ `
in vec2 aPosition;
in vec4 aCorner; // u, v, kind (0 capsule / 1 circle), unused
in vec4 aColor;
out vec4 vCorner;
out vec4 vColor;
void main() {
  vCorner = aCorner;
  vColor = aColor;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision mediump float;
in vec4 vCorner;
in vec4 vColor;
out vec4 finalColor;
void main() {
  float a;
  if (vCorner.z > 0.5) {
    float d = length(vCorner.xy);
    a = smoothstep(1.0, 0.55, d);
  } else {
    float v = vCorner.y;
    a = pow(max(0.0, 1.0 - v * v), 1.3)
      * smoothstep(0.0, 0.14, vCorner.x)
      * smoothstep(1.0, 0.86, vCorner.x);
  }
  // premultiplied, normal blending: the dark silhouette can darken the
  // bright ring bands underneath — that's what keeps the climber readable
  finalColor = vec4(vColor.rgb * vColor.a * a, vColor.a * a);
}
`;

const TRAIL_VERT = /* glsl */ `
in vec2 aPosition;
in vec4 aColor;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const TRAIL_FRAG = /* glsl */ `
precision mediump float;
in vec4 vColor;
out vec4 finalColor;
void main() {
  finalColor = vec4(vColor.rgb * vColor.a, 0.0);
}
`;

function hueToRgb(h: number, out: Float32Array, o: number, sat: number, val: number): void {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = val * (1 - sat);
  const q = val * (1 - f * sat);
  const t = val * (1 - (1 - f) * sat);
  let r = 0, g = 0, b = 0;
  switch (i) {
    case 0: r = val; g = t; b = p; break;
    case 1: r = q; g = val; b = p; break;
    case 2: r = p; g = val; b = t; break;
    case 3: r = p; g = q; b = val; break;
    case 4: r = t; g = p; b = val; break;
    default: r = val; g = p; b = q; break;
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

export class ShardVisual {
  root = new Container();
  /** palette glow color, set from the LUT each phase change */
  readonly glowColor = new Float32Array([0.4, 0.8, 1.0]);
  flash = 0;
  /** landing squash impulse (set to 1 on land, decays) */
  squash = 0;

  private body: Mesh<Geometry, Shader>;
  private trail: Mesh<Geometry, Shader>;
  private pos: Float32Array;
  private corner: Float32Array;
  private col: Float32Array;
  private trailPos: Float32Array;
  private trailCol: Float32Array;
  private hist = new Float32Array((SEGS + 1) * 2);
  private histLen = 0;
  private hueBase = 0;
  private runPhase = 0;
  // local-space joint targets and smoothed joints (x,y interleaved)
  private target = new Float32Array(N_JOINTS * 2);
  private joints = new Float32Array(N_JOINTS * 2);

  constructor() {
    this.pos = new Float32Array(N_QUADS * 8);
    this.corner = new Float32Array(N_QUADS * 16);
    this.col = new Float32Array(N_QUADS * 16);
    const idx = new Uint16Array(N_QUADS * 6);
    for (let i = 0; i < N_QUADS; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const geom = new Geometry({
      attributes: {
        aPosition: { buffer: this.pos, format: 'float32x2' },
        aCorner: { buffer: this.corner, format: 'float32x4' },
        aColor: { buffer: this.col, format: 'float32x4' },
      },
      indexBuffer: idx,
    });
    const shader = Shader.from({
      gl: { vertex: es300(VERT), fragment: es300(FRAG), name: 'vortika-climber' },
      resources: {},
    });
    this.body = new Mesh({ geometry: geom, shader });
    this.body.blendMode = 'normal';

    // ribbon trail (kept from the shard era — the signature streak)
    this.trailPos = new Float32Array((SEGS + 1) * 2 * 2);
    this.trailCol = new Float32Array((SEGS + 1) * 2 * 4);
    const tidx = new Uint16Array(SEGS * 6);
    for (let i = 0; i < SEGS; i++) {
      const v = i * 2;
      tidx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    }
    const trailGeom = new Geometry({
      attributes: {
        aPosition: { buffer: this.trailPos, format: 'float32x2' },
        aColor: { buffer: this.trailCol, format: 'float32x4' },
      },
      indexBuffer: tidx,
    });
    const trailShader = Shader.from({
      gl: { vertex: es300(TRAIL_VERT), fragment: es300(TRAIL_FRAG), name: 'vortika-trail' },
      resources: {},
    });
    this.trail = new Mesh({ geometry: trailGeom, shader: trailShader });
    this.trail.blendMode = 'add';

    this.root.addChild(this.trail, this.body);
  }

  reset(x: number, y: number): void {
    this.histLen = 0;
    this.pushHist(x, y);
    this.flash = 0;
    this.runPhase = 0;
    this.joints.fill(0);
    this.poseRun(0);
    this.joints.set(this.target);
  }

  private pushHist(x: number, y: number): void {
    const n = Math.min(this.histLen, SEGS);
    for (let i = n; i > 0; i--) {
      this.hist[i * 2] = this.hist[(i - 1) * 2];
      this.hist[i * 2 + 1] = this.hist[(i - 1) * 2 + 1];
    }
    this.hist[0] = x;
    this.hist[1] = y;
    this.histLen = Math.min(this.histLen + 1, SEGS + 1);
  }

  private setJ(j: number, x: number, y: number): void {
    this.target[j * 2] = x;
    this.target[j * 2 + 1] = y;
  }

  /** local space: +x = facing, +y = up (toward the vortex eye) */
  private poseRun(phase: number): void {
    const swing = Math.sin(phase);
    const swing2 = Math.sin(phase + Math.PI);
    const bob = Math.abs(Math.cos(phase)) * 0.03;
    const lean = 0.10;
    this.setJ(J.pelvis, 0, 0.34 + bob);
    this.setJ(J.chest, lean, 0.62 + bob);
    this.setJ(J.head, lean * 1.6, 0.78 + bob);
    // legs
    this.setJ(J.lKnee, 0.10 * swing + 0.04, 0.18 + 0.05 * Math.max(0, swing));
    this.setJ(J.lFoot, 0.20 * swing, Math.max(0, 0.10 * Math.cos(phase)) + 0.0);
    this.setJ(J.rKnee, 0.10 * swing2 + 0.04, 0.18 + 0.05 * Math.max(0, swing2));
    this.setJ(J.rFoot, 0.20 * swing2, Math.max(0, 0.10 * Math.cos(phase + Math.PI)));
    // arms counter-swing
    this.setJ(J.lElbow, 0.10 * swing2 + lean, 0.46);
    this.setJ(J.lHand, 0.20 * swing2 + lean + 0.05, 0.38 + 0.06 * swing2);
    this.setJ(J.rElbow, 0.10 * swing + lean, 0.46);
    this.setJ(J.rHand, 0.20 * swing + lean + 0.05, 0.38 + 0.06 * swing);
  }

  private poseRise(t: number): void {
    // tuck: knees up, arms raised toward the eye
    const w = Math.sin(t * 3) * 0.02;
    this.setJ(J.pelvis, 0, 0.36);
    this.setJ(J.chest, 0.02, 0.64);
    this.setJ(J.head, 0.04, 0.80);
    this.setJ(J.lKnee, 0.16, 0.34);
    this.setJ(J.lFoot, 0.10, 0.16);
    this.setJ(J.rKnee, 0.20, 0.30);
    this.setJ(J.rFoot, 0.14, 0.12);
    this.setJ(J.lElbow, -0.08 + w, 0.78);
    this.setJ(J.lHand, -0.12 + w, 0.94);
    this.setJ(J.rElbow, 0.12 - w, 0.78);
    this.setJ(J.rHand, 0.16 - w, 0.94);
  }

  private poseFall(t: number): void {
    // flail: limbs wide, waving (gently — it read as scribble when fast)
    const w = Math.sin(t * 6) * 0.03;
    this.setJ(J.pelvis, 0, 0.36);
    this.setJ(J.chest, 0, 0.64);
    this.setJ(J.head, 0, 0.80);
    this.setJ(J.lKnee, -0.14, 0.20);
    this.setJ(J.lFoot, -0.22 + w, 0.04);
    this.setJ(J.rKnee, 0.14, 0.20);
    this.setJ(J.rFoot, 0.22 - w, 0.04);
    this.setJ(J.lElbow, -0.18, 0.76);
    this.setJ(J.lHand, -0.30 - w, 0.86);
    this.setJ(J.rElbow, 0.18, 0.76);
    this.setJ(J.rHand, 0.30 + w, 0.86);
  }

  private poseGrab(g: number, t: number): void {
    // hanging by both hands, legs swaying; body rises as g→1 (physics lifts him)
    const sway = Math.sin(t * 5) * (1 - g) * 0.08;
    const tuck = g * 0.14;
    this.setJ(J.pelvis, sway * 0.5, 0.30 + tuck * 0.4);
    this.setJ(J.chest, sway * 0.3, 0.58 + tuck * 0.3);
    this.setJ(J.head, sway * 0.2, 0.74 + tuck * 0.3);
    this.setJ(J.lElbow, -0.10, 0.82);
    this.setJ(J.lHand, -0.13, 1.02 - tuck);
    this.setJ(J.rElbow, 0.10, 0.82);
    this.setJ(J.rHand, 0.13, 1.02 - tuck);
    this.setJ(J.lKnee, -0.06 + sway, 0.14 + tuck);
    this.setJ(J.lFoot, -0.10 + sway * 1.5, -0.02 + tuck);
    this.setJ(J.rKnee, 0.08 + sway, 0.12 + tuck);
    this.setJ(J.rFoot, 0.12 + sway * 1.5, -0.04 + tuck);
  }

  private poseDash(): void {
    // superman stretch along facing
    this.setJ(J.pelvis, 0, 0.40);
    this.setJ(J.chest, 0.22, 0.46);
    this.setJ(J.head, 0.38, 0.50);
    this.setJ(J.lElbow, 0.40, 0.42);
    this.setJ(J.lHand, 0.56, 0.44);
    this.setJ(J.rElbow, 0.42, 0.50);
    this.setJ(J.rHand, 0.58, 0.52);
    this.setJ(J.lKnee, -0.16, 0.36);
    this.setJ(J.lFoot, -0.34, 0.34);
    this.setJ(J.rKnee, -0.14, 0.44);
    this.setJ(J.rFoot, -0.32, 0.42);
  }

  update(dt: number, pose: ClimberPose, time: number, visible: boolean): void {
    this.root.visible = visible;
    if (!visible) return;
    this.flash = Math.max(0, this.flash - dt * 4);
    this.squash = Math.max(0, this.squash - dt * 5);
    this.hueBase = (this.hueBase + dt * 0.35) % 1;

    // --- pick pose in local space ---
    const speed = Math.abs(pose.omega);
    switch (pose.state) {
      case 'run':
        this.runPhase += speed * dt * 9;
        this.poseRun(this.runPhase);
        break;
      case 'rise': this.poseRise(time); break;
      case 'fall': this.poseFall(time); break;
      case 'grab': this.poseGrab(Math.max(0, pose.grabT), time); break;
      case 'dash': this.poseDash(); break;
    }
    // smooth toward target pose
    const k = 1 - Math.exp(-dt * 15);
    for (let i = 0; i < N_JOINTS * 2; i++) {
      this.joints[i] += (this.target[i] - this.joints[i]) * k;
    }

    // --- transform: local (+x facing, +y up=inward) → clip space ---
    const upA = pose.posAngle + Math.PI; // toward the center
    const facing = pose.omega >= 0 ? 1 : -1;
    const ux = Math.cos(upA), uy = Math.sin(upA);
    // tangent for CCW motion is posAngle + 90°; flip with facing
    const tx = -Math.sin(pose.posAngle) * facing;
    const ty = Math.cos(pose.posAngle) * facing;
    const s = pose.size;
    const sqX = 1 + 0.18 * this.squash;
    const sqY = 1 - 0.24 * this.squash;
    const wx = (lx: number, ly: number) => pose.x + (tx * lx * sqX + ux * ly * sqY) * s;
    const wy = (lx: number, ly: number) => pose.y + (ty * lx * sqX + uy * ly * sqY) * s;

    // --- write quads: glow pass under core pass per bone ---
    const coreW = s * 0.055;
    const g = this.glowColor;
    const bright = Math.min(1.6, 1 + this.flash);
    // layer params: dark silhouette → palette accent → white-hot core
    const widths = [coreW * 2.6, coreW * 1.7, coreW];
    const colR = [0.008, g[0], 0.97 * bright];
    const colG = [0.014, g[1], 0.99 * bright];
    const colB = [0.045, g[2], 1.0 * bright];
    const colA = [0.92, 0.95, 1.0];
    const headR = [s * 0.165, s * 0.14, s * 0.11];
    let q = 0;
    for (let pass = 0; pass < N_LAYERS; pass++) {
      const w = widths[pass];
      const r = colR[pass];
      const gg = colG[pass];
      const b = colB[pass];
      const a = colA[pass];
      for (const [ja, jb] of BONES) {
        const x1 = wx(this.joints[ja * 2], this.joints[ja * 2 + 1]);
        const y1 = wy(this.joints[ja * 2], this.joints[ja * 2 + 1]);
        const x2 = wx(this.joints[jb * 2], this.joints[jb * 2 + 1]);
        const y2 = wy(this.joints[jb * 2], this.joints[jb * 2 + 1]);
        this.writeCapsule(q++, x1, y1, x2, y2, w, r, gg, b, a);
      }
      // head circle
      const hx = wx(this.joints[J.head * 2], this.joints[J.head * 2 + 1] + 0.06);
      const hy = wy(this.joints[J.head * 2], this.joints[J.head * 2 + 1] + 0.06);
      this.writeCircle(q++, hx, hy, headR[pass], r, gg, b, a);
    }
    this.body.geometry.getBuffer('aPosition').update();
    this.body.geometry.getBuffer('aCorner').update();
    this.body.geometry.getBuffer('aColor').update();

    // --- trail from the pelvis ---
    const px = wx(this.joints[J.pelvis * 2], this.joints[J.pelvis * 2 + 1]);
    const py = wy(this.joints[J.pelvis * 2], this.joints[J.pelvis * 2 + 1]);
    const prevX = this.hist[0];
    const prevY = this.hist[1];
    if (Math.hypot(px - prevX, py - prevY) > 0.004) this.pushHist(px, py);
    else {
      this.hist[0] = px;
      this.hist[1] = py;
    }
    const clipSpeed = Math.hypot(px - prevX, py - prevY) / Math.max(dt, 1e-4);
    const w0 = 0.003 + Math.min(0.015, clipSpeed * 0.009);
    const pts = Math.max(2, this.histLen);
    for (let i = 0; i <= SEGS; i++) {
      const pi = Math.min(i, pts - 1);
      const hx = this.hist[pi * 2];
      const hy = this.hist[pi * 2 + 1];
      const qi = Math.min(pi + 1, pts - 1);
      let dx = this.hist[qi * 2] - hx;
      let dy = this.hist[qi * 2 + 1] - hy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const t = i / SEGS;
      const w = w0 * (1 - t) * (1 - t) + 0.001;
      const o = i * 4;
      this.trailPos[o] = hx - dy * w;
      this.trailPos[o + 1] = hy + dx * w;
      this.trailPos[o + 2] = hx + dy * w;
      this.trailPos[o + 3] = hy - dx * w;
      const co = i * 8;
      const alpha = (1 - t) * 0.45 * Math.min(1, this.histLen / 4);
      hueToRgb((this.hueBase + t * 0.5) % 1, this.trailCol, co, 0.7, 1);
      this.trailCol[co + 3] = alpha;
      this.trailCol.copyWithin(co + 4, co, co + 3);
      this.trailCol[co + 7] = alpha;
    }
    this.trail.geometry.getBuffer('aPosition').update();
    this.trail.geometry.getBuffer('aColor').update();
  }

  private writeCapsule(
    q: number, x1: number, y1: number, x2: number, y2: number,
    w: number, r: number, g: number, b: number, a: number
  ): void {
    let dx = x2 - x1;
    let dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-5;
    dx /= len;
    dy /= len;
    // extend ends by w for round caps
    const ex1 = x1 - dx * w, ey1 = y1 - dy * w;
    const ex2 = x2 + dx * w, ey2 = y2 + dy * w;
    const nx = -dy * w, ny = dx * w;
    const o = q * 8;
    this.pos[o] = ex1 + nx; this.pos[o + 1] = ey1 + ny;
    this.pos[o + 2] = ex2 + nx; this.pos[o + 3] = ey2 + ny;
    this.pos[o + 4] = ex2 - nx; this.pos[o + 5] = ey2 - ny;
    this.pos[o + 6] = ex1 - nx; this.pos[o + 7] = ey1 - ny;
    const c = q * 16;
    // u along (0..1), v across (-1..1), kind 0
    this.corner.set([0, 1, 0, 0, 1, 1, 0, 0, 1, -1, 0, 0, 0, -1, 0, 0], c);
    for (let v = 0; v < 4; v++) {
      this.col[c + v * 4] = r;
      this.col[c + v * 4 + 1] = g;
      this.col[c + v * 4 + 2] = b;
      this.col[c + v * 4 + 3] = a;
    }
  }

  private writeCircle(
    q: number, x: number, y: number, radius: number,
    r: number, g: number, b: number, a: number
  ): void {
    const o = q * 8;
    this.pos[o] = x - radius; this.pos[o + 1] = y - radius;
    this.pos[o + 2] = x + radius; this.pos[o + 3] = y - radius;
    this.pos[o + 4] = x + radius; this.pos[o + 5] = y + radius;
    this.pos[o + 6] = x - radius; this.pos[o + 7] = y + radius;
    const c = q * 16;
    this.corner.set([-1, -1, 1, 0, 1, -1, 1, 0, 1, 1, 1, 0, -1, 1, 1, 0], c);
    for (let v = 0; v < 4; v++) {
      this.col[c + v * 4] = r;
      this.col[c + v * 4 + 1] = g;
      this.col[c + v * 4 + 2] = b;
      this.col[c + v * 4 + 3] = a;
    }
  }
}
