import { Container, Geometry, Mesh, Shader } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { es300 } from './gfx';

/**
 * The Moth: a luminous moth drawn to the light at the tunnel's heart.
 * Molten white body, palette-tinted wing glows that beat faster with
 * speed, fold back on a dash, flare wide on a jump; a dark backdrop
 * silhouette keeps it readable over bright rings, and the hue-shifting
 * ribbon tail streams behind as wing dust.
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

// dark silhouette (body + 2 wings) + glow (4 wings, body, core, pip)
const N_QUADS = 10;

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

  private flapPhase = 0;

  update(dt: number, pose: ClimberPose, time: number, visible: boolean): void {
    this.root.visible = visible;
    if (!visible) return;
    this.flash = Math.max(0, this.flash - dt * 4);
    this.squash = Math.max(0, this.squash - dt * 5);
    this.hueBase = (this.hueBase + dt * 0.35) % 1;

    // motion (for the tail) from position history
    const prevX = this.hist[0];
    const prevY = this.hist[1];
    const mx = pose.x - prevX;
    const my = pose.y - prevY;
    const mlen = Math.hypot(mx, my);
    const speed = mlen / Math.max(dt, 1e-4);

    // the moth faces the light at the tunnel's heart
    const hx = -Math.cos(pose.posAngle);
    const hy = -Math.sin(pose.posAngle);
    const sxv = -hy; // side vector
    const syv = hx;
    // bank into the steering
    const bank = Math.max(-0.5, Math.min(0.5, pose.omega * 0.18));

    // wing beat: faster with speed; flared on jumps, folded on dashes
    const rise = pose.state === 'rise';
    const dash = pose.state === 'dash';
    this.flapPhase += dt * (9 + speed * 7) * (rise ? 0.55 : 1);
    let open = 0.55 + 0.45 * Math.sin(this.flapPhase);
    if (dash) open = 0.18;
    if (rise) open = 1.0 + 0.1 * Math.sin(time * 10);
    const sweep = dash ? -0.34 : -0.06; // wings sweep back when dashing

    const s = pose.size * (1 - 0.18 * this.squash);
    const g = this.glowColor;
    const bright = 1 + this.flash * 0.8;
    const cx = pose.x;
    const cy = pose.y;
    const at = (f: number, sd: number) => [cx + hx * s * f + sxv * s * sd, cy + hy * s * f + syv * s * sd] as const;

    // wing geometry (per side): outer pair large, inner pair small
    const wingR = s * (0.34 + 0.16 * open) * (rise ? 1.25 : 1);
    const wingR2 = s * (0.22 + 0.1 * open);
    const spread = 0.36 + 0.34 * open;
    const [lwx, lwy] = at(0.12 + sweep + bank * 0.4, -spread);
    const [rwx, rwy] = at(0.12 + sweep - bank * 0.4, spread);
    const [lw2x, lw2y] = at(-0.3 + sweep * 0.6, -(spread * 0.68));
    const [rw2x, rw2y] = at(-0.3 + sweep * 0.6, spread * 0.68);
    const [headX, headY] = at(0.52, 0);
    const [tailX, tailY] = at(-0.5 - (dash ? 0.5 : 0), 0);

    let q = 0;
    // --- dark silhouette (normal blending: keeps it readable) ---
    this.writeCapsule(q++, headX, headY, tailX, tailY, s * 0.3, 0.01, 0.02, 0.06, 0.5);
    this.writeCircle(q++, lwx, lwy, wingR * 1.25, 0.01, 0.02, 0.06, 0.42);
    this.writeCircle(q++, rwx, rwy, wingR * 1.25, 0.01, 0.02, 0.06, 0.42);
    // --- glow wings (additive, palette-tinted) ---
    const wA = 0; // additive rows use alpha 0
    const wr = g[0] * 0.85 * bright;
    const wg = g[1] * 0.85 * bright;
    const wb = g[2] * 0.85 * bright;
    this.writeCircle(q++, lwx, lwy, wingR, wr, wg, wb, wA);
    this.writeCircle(q++, rwx, rwy, wingR, wr, wg, wb, wA);
    this.writeCircle(q++, lw2x, lw2y, wingR2, wr * 0.7, wg * 0.7, wb * 0.7, wA);
    this.writeCircle(q++, rw2x, rw2y, wingR2, wr * 0.7, wg * 0.7, wb * 0.7, wA);
    // --- body: white streak + hot core + over-bright pip ---
    this.writeCapsule(q++, headX, headY, tailX, tailY, s * 0.16,
      0.85 * bright, 0.9 * bright, 1.0 * bright, wA);
    this.writeCircle(q++, headX, headY, s * 0.3, bright, bright, bright, wA);
    this.writeCircle(q++, headX, headY, s * 0.15, 1.6, 1.6, 1.7, wA);

    this.body.geometry.getBuffer('aPosition').update();
    this.body.geometry.getBuffer('aCorner').update();
    this.body.geometry.getBuffer('aColor').update();

    void mlen;
    if (mlen > 0.004) this.pushHist(pose.x, pose.y);
    else {
      this.hist[0] = pose.x;
      this.hist[1] = pose.y;
    }
    const histSpeed = speed;
    void histSpeed;

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
