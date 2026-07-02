import { Container, Geometry, Mesh, Shader } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { es300 } from './gfx';

/**
 * The Shard's visuals: a procedural luminous rhombus (white core, palette
 * fresnel edge, additive glow) plus a 24-segment hue-shifting ribbon trail.
 * Drawn UNMIRRORED on top of the kaleidoscope — the one asymmetric object.
 * All buffers are pre-allocated; per-frame updates write in place.
 */

const SHARD_VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vLocal;
uniform vec2 uPos;    // clip-space center
uniform vec2 uScale;  // clip-space half extents
uniform float uAngle;
void main() {
  vLocal = aPosition;
  float c = cos(uAngle), s = sin(uAngle);
  vec2 p = vec2(aPosition.x * c - aPosition.y * s, aPosition.x * s + aPosition.y * c);
  gl_Position = vec4(uPos + p * uScale, 0.0, 1.0);
}
`;

const SHARD_FRAG = /* glsl */ `
precision highp float;
in vec2 vLocal;
out vec4 finalColor;
uniform sampler2D uLut;
uniform float uTime;
uniform float uFlash; // dash/land flash 0..1
void main() {
  // elongated rhombus SDF in local space (x = long axis)
  float d = abs(vLocal.x) / 0.92 + abs(vLocal.y) / 0.34;
  float core = exp(-d * d * 5.0);
  float edge = smoothstep(1.0, 0.82, d) * smoothstep(0.35, 0.75, d);
  float glow = exp(-d * 1.8) * 0.5;
  vec3 edgeCol = texture(uLut, vec2(0.72 + 0.2 * sin(uTime * 2.1), 0.5)).rgb;
  vec3 col = vec3(1.0) * core * (1.3 + uFlash)
           + edgeCol * edge * 1.6
           + edgeCol * glow;
  finalColor = vec4(col, 0.0); // additive
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
precision highp float;
in vec4 vColor;
out vec4 finalColor;
void main() {
  finalColor = vec4(vColor.rgb * vColor.a, 0.0); // additive
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

const SEGS = TUNING.TRAIL_SEGMENTS;

export class ShardVisual {
  root = new Container();
  private shard: Mesh<Geometry, Shader>;
  private trail: Mesh<Geometry, Shader>;
  private trailPos: Float32Array;
  private trailCol: Float32Array;
  private hist = new Float32Array((SEGS + 1) * 2);
  private histLen = 0;
  private hueBase = 0;
  flash = 0;

  constructor(lut: Texture) {
    const shardShader = Shader.from({
      gl: { vertex: es300(SHARD_VERT), fragment: es300(SHARD_FRAG), name: 'vortika-shard' },
      resources: {
        shardUniforms: {
          uPos: { value: new Float32Array(2), type: 'vec2<f32>' },
          uScale: { value: new Float32Array([0.1, 0.1]), type: 'vec2<f32>' },
          uAngle: { value: 0, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uFlash: { value: 0, type: 'f32' },
        },
        uLut: lut.source,
      },
    });
    const quad = new Geometry({
      attributes: {
        aPosition: {
          buffer: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
          format: 'float32x2',
        },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    this.shard = new Mesh({ geometry: quad, shader: shardShader });
    this.shard.blendMode = 'add';

    this.trailPos = new Float32Array((SEGS + 1) * 2 * 2);
    this.trailCol = new Float32Array((SEGS + 1) * 2 * 4);
    const idx = new Uint16Array(SEGS * 6);
    for (let i = 0; i < SEGS; i++) {
      const v = i * 2;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    }
    const trailGeom = new Geometry({
      attributes: {
        aPosition: { buffer: this.trailPos, format: 'float32x2' },
        aColor: { buffer: this.trailCol, format: 'float32x4' },
      },
      indexBuffer: idx,
    });
    const trailShader = Shader.from({
      gl: { vertex: es300(TRAIL_VERT), fragment: es300(TRAIL_FRAG), name: 'vortika-trail' },
      resources: {},
    });
    this.trail = new Mesh({ geometry: trailGeom, shader: trailShader });
    this.trail.blendMode = 'add';

    this.root.addChild(this.trail, this.shard);
  }

  reset(x: number, y: number): void {
    this.histLen = 0;
    this.pushHist(x, y);
    this.flash = 0;
  }

  private pushHist(x: number, y: number): void {
    // shift history (25 points max — trivially cheap, no allocation)
    const n = Math.min(this.histLen, SEGS);
    for (let i = n; i > 0; i--) {
      this.hist[i * 2] = this.hist[(i - 1) * 2];
      this.hist[i * 2 + 1] = this.hist[(i - 1) * 2 + 1];
    }
    this.hist[0] = x;
    this.hist[1] = y;
    this.histLen = Math.min(this.histLen + 1, SEGS + 1);
  }

  /**
   * x,y in clip space of the square target; angle = facing; speed 0..~2
   * (clip units/s) controls trail width.
   */
  update(dt: number, x: number, y: number, angle: number, speed: number, time: number, visible: boolean): void {
    this.root.visible = visible;
    if (!visible) return;
    this.flash = Math.max(0, this.flash - dt * 4);
    this.hueBase = (this.hueBase + dt * 0.35) % 1;

    const prevX = this.hist[0];
    const prevY = this.hist[1];
    if (Math.hypot(x - prevX, y - prevY) > 0.004) this.pushHist(x, y);
    else {
      this.hist[0] = x;
      this.hist[1] = y;
    }

    const su = this.shard.shader!.resources.shardUniforms.uniforms;
    (su.uPos as Float32Array)[0] = x;
    (su.uPos as Float32Array)[1] = y;
    const s = 0.05; // ~3.5% of screen (half-extent in clip units ±1)
    (su.uScale as Float32Array)[0] = s * 1.45;
    (su.uScale as Float32Array)[1] = s;
    su.uAngle = angle;
    su.uTime = time;
    su.uFlash = this.flash;

    // rebuild ribbon strip in place
    const w0 = 0.006 + Math.min(0.028, speed * 0.018);
    const pts = Math.max(2, this.histLen);
    for (let i = 0; i <= SEGS; i++) {
      const pi = Math.min(i, pts - 1);
      const px = this.hist[pi * 2];
      const py = this.hist[pi * 2 + 1];
      const qi = Math.min(pi + 1, pts - 1);
      let dx = this.hist[qi * 2] - px;
      let dy = this.hist[qi * 2 + 1] - py;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const t = i / SEGS;
      const w = w0 * (1 - t) * (1 - t) + 0.001;
      const o = i * 4;
      this.trailPos[o] = px - dy * w;
      this.trailPos[o + 1] = py + dx * w;
      this.trailPos[o + 2] = px + dy * w;
      this.trailPos[o + 3] = py - dx * w;
      const co = i * 8;
      const alpha = (1 - t) * 0.55 * Math.min(1, this.histLen / 4);
      hueToRgb((this.hueBase + t * 0.5) % 1, this.trailCol, co, 0.75, 1);
      this.trailCol[co + 3] = alpha;
      this.trailCol.copyWithin(co + 4, co, co + 3);
      this.trailCol[co + 7] = alpha;
    }
    this.trail.geometry.getBuffer('aPosition').update();
    this.trail.geometry.getBuffer('aColor').update();
  }
}
