import { Container, Geometry, Mesh, Shader } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { es300 } from './gfx';

/**
 * The Comet Wisp: a bright teardrop of light — molten white core, palette
 * halo, dark backdrop disc for readability over bright rings, and the
 * signature hue-shifting ribbon tail. It stretches along its motion when
 * flying, doubles its stretch on a dash, squashes on landings, and clings
 * tight during ledge grabs. Simple shapes that always read at phone size.
 * All buffers pre-allocated; per-frame updates write in place.
 */

export type ClimberState = 'run' | 'rise' | 'fall' | 'grab' | 'dash';

export interface ClimberPose {
  x: number;          // clip-space position
  y: number;
  posAngle: number;   // angle of the position around the center (incl. viewRot)
  omega: number;      // tangential angular velocity (sign = facing)
  state: ClimberState;
  grabT: number;      // 0..1 during pull-up
  size: number;       // characteristic radius in clip units
}

const SEGS = TUNING.TRAIL_SEGMENTS;

const SHAPE_VERT = /* glsl */ `
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

/** premultiplied normal blending; alpha 0 rows act additively */
const SHAPE_FRAG = /* glsl */ `
precision mediump float;
in vec4 vCorner;
in vec4 vColor;
out vec4 finalColor;
void main() {
  float a;
  if (vCorner.z > 0.5) {
    float d = length(vCorner.xy);
    a = smoothstep(1.0, 0.25, d);
  } else {
    float v = vCorner.y;
    a = pow(max(0.0, 1.0 - v * v), 1.5)
      * smoothstep(0.0, 0.18, vCorner.x)
      * smoothstep(1.0, 0.82, vCorner.x);
  }
  finalColor = vec4(vColor.rgb * a, vColor.a * a);
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

// body quads: dark backdrop teardrop + halo + body streak + core + hot pip
const N_QUADS = 5;

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
  // smoothed motion direction + stretch
  private dirX = 1;
  private dirY = 0;
  private stretch = 0;
  private pulseT = 0;

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
      gl: { vertex: es300(SHAPE_VERT), fragment: es300(SHAPE_FRAG), name: 'bloom-wisp' },
      resources: {},
    });
    this.body = new Mesh({ geometry: geom, shader });
    this.body.blendMode = 'normal';

    // ribbon tail — the signature streak
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
      gl: { vertex: es300(TRAIL_VERT), fragment: es300(TRAIL_FRAG), name: 'bloom-tail' },
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
    this.squash = 0;
    this.stretch = 0;
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

  update(dt: number, pose: ClimberPose, time: number, visible: boolean): void {
    this.root.visible = visible;
    if (!visible) return;
    this.flash = Math.max(0, this.flash - dt * 4);
    this.squash = Math.max(0, this.squash - dt * 5);
    this.hueBase = (this.hueBase + dt * 0.35) % 1;
    this.pulseT = time;

    // --- motion direction from position history (smoothed) ---
    const prevX = this.hist[0];
    const prevY = this.hist[1];
    let mx = pose.x - prevX;
    let my = pose.y - prevY;
    const mlen = Math.hypot(mx, my);
    const speed = mlen / Math.max(dt, 1e-4);
    if (mlen > 1e-5) {
      mx /= mlen;
      my /= mlen;
      const k = 1 - Math.exp(-dt * 14);
      this.dirX += (mx - this.dirX) * k;
      this.dirY += (my - this.dirY) * k;
      const dl = Math.hypot(this.dirX, this.dirY) || 1;
      this.dirX /= dl;
      this.dirY /= dl;
    }

    // --- stretch by state + speed ---
    let targetStretch = Math.min(1, speed * 1.6);
    if (pose.state === 'dash') targetStretch = 1.8;
    else if (pose.state === 'grab') targetStretch = 0.1;
    else if (pose.state === 'run') targetStretch = Math.min(0.45, speed * 1.2);
    this.stretch += (targetStretch - this.stretch) * (1 - Math.exp(-dt * 10));

    const s = pose.size;
    const g = this.glowColor;
    const bright = 1 + this.flash * 0.8;
    const sq = this.squash;
    const breathe = 1 + 0.05 * Math.sin(this.pulseT * 5.2);
    // squash flattens along "up" (radial) and widens tangentially
    const upX = Math.cos(pose.posAngle + Math.PI);
    const upY = Math.sin(pose.posAngle + Math.PI);
    const headX = pose.x;
    const headY = pose.y;
    const tailX = headX - this.dirX * s * (0.9 + 1.6 * this.stretch);
    const tailY = headY - this.dirY * s * (0.9 + 1.6 * this.stretch);

    // radius helper with squash applied against the surface normal
    const rad = (base: number) => base * breathe * (1 - 0.28 * sq);

    let q = 0;
    // 1. dark backdrop teardrop (readability over bright bands)
    this.writeCapsule(q++, headX + upX * s * 0.04 * sq, headY + upY * s * 0.04 * sq,
      (headX + tailX) / 2, (headY + tailY) / 2,
      rad(s * 0.62), 0.01, 0.02, 0.06, 0.55);
    // 2. palette halo (additive)
    this.writeCircle(q++, headX, headY, rad(s * (0.95 + 0.15 * sq)),
      g[0] * 0.55 * bright, g[1] * 0.55 * bright, g[2] * 0.55 * bright, 0);
    // 3. body streak head→tail (additive, white-warm)
    this.writeCapsule(q++, headX, headY, tailX, tailY, rad(s * 0.3),
      0.85 * bright, 0.9 * bright, 1.0 * bright, 0);
    // 4. core (additive, hot)
    this.writeCircle(q++, headX, headY, rad(s * 0.42),
      1.0 * bright, 1.0 * bright, 1.0 * bright, 0);
    // 5. tiny over-bright pip that feeds the post bloom
    this.writeCircle(q++, headX, headY, rad(s * 0.2), 1.6, 1.6, 1.7, 0);

    this.body.geometry.getBuffer('aPosition').update();
    this.body.geometry.getBuffer('aCorner').update();
    this.body.geometry.getBuffer('aColor').update();

    // --- ribbon tail ---
    if (mlen > 0.004) this.pushHist(pose.x, pose.y);
    else {
      this.hist[0] = pose.x;
      this.hist[1] = pose.y;
    }
    const w0 = 0.005 + Math.min(0.02, speed * 0.012);
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
      const alpha = (1 - t) * 0.5 * Math.min(1, this.histLen / 4);
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
    const ex1 = x1 - dx * w, ey1 = y1 - dy * w;
    const ex2 = x2 + dx * w, ey2 = y2 + dy * w;
    const nx = -dy * w, ny = dx * w;
    const o = q * 8;
    this.pos[o] = ex1 + nx; this.pos[o + 1] = ey1 + ny;
    this.pos[o + 2] = ex2 + nx; this.pos[o + 3] = ey2 + ny;
    this.pos[o + 4] = ex2 - nx; this.pos[o + 5] = ey2 - ny;
    this.pos[o + 6] = ex1 - nx; this.pos[o + 7] = ey1 - ny;
    const c = q * 16;
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
