import { Mesh, RenderTexture } from 'pixi.js';
import type { Geometry, Renderer, Shader, Texture } from 'pixi.js';
import { GLSL_FOLD, quadMesh } from './gfx';

/**
 * Fullscreen flow-noise fractal background (half-res), driven per Bloom by
 * PhaseDNA: five noise types (fbm / ridged / curl / voronoiFlow /
 * domainWarp2x), four texture blend modes, previous-frame feedback smear
 * (trippy trails), and — tier 3+ — a nested second kaleidoscope fold.
 * Output is compressed (−sat/−lum) vs the wedge so gameplay pops over it.
 */

const BG_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexB;
uniform sampler2D uTexB2;
uniform sampler2D uLut;
uniform sampler2D uPrev;     // previous frame (feedback)
uniform float uTime;
uniform float uSeed;
uniform float uPhaseMix;
uniform float uNoiseType;    // 0 fbm, 1 ridged, 2 curl, 3 voronoiFlow, 4 domainWarp2x
uniform float uNoiseScale;
uniform float uWarp;
uniform float uBlendMode;    // 0 mix, 1 screen, 2 overlay, 3 difference
uniform float uDrift;
uniform float uFeedback;     // 0..0.35
uniform float uNestedFold;   // 0 = off, else wedge width of nested kaleidoscope

${GLSL_FOLD}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453);
}
vec2 hash2(vec2 p) {
  return vec2(hash(p), hash(p + 19.19));
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = r * p * 2.03 + 3.7;
    a *= 0.5;
  }
  return v;
}
float voronoi(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash2(i + g);
      o = 0.5 + 0.5 * sin(uTime * 0.4 + o * 6.2831);
      d = min(d, length(g + o - f));
    }
  }
  return d;
}
vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c) * p;
}
vec3 blendTex(vec3 x, vec3 y, float mode) {
  if (mode < 0.5) return mix(x, y, 0.5);
  if (mode < 1.5) return 1.0 - (1.0 - x) * (1.0 - y);                       // screen
  if (mode < 2.5) return mix(2.0 * x * y, 1.0 - 2.0 * (1.0 - x) * (1.0 - y),
                             step(0.5, x));                                 // overlay
  return abs(x - y);                                                        // difference
}
vec3 sampleDual(sampler2D tex, vec2 uv, float t) {
  vec2 uv1 = rot(uv - 0.5, t * 0.02 * uDrift) * 1.05 + 0.5 + vec2(t * 0.006, -t * 0.004) * uDrift;
  vec2 uv2 = rot(uv - 0.5, -t * 0.02 * uDrift) * 1.4 + 0.5 + vec2(-t * 0.004, t * 0.007) * uDrift;
  vec3 s1 = texture(tex, uv1).rgb;
  vec3 s2 = texture(tex, uv2).rgb;
  vec3 b = blendTex(s1, s2, uBlendMode);
  return mix(mix(s1, s2, 0.5 + 0.3 * sin(t * 0.07)), b, 0.6);
}
void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);
  float t = uTime * 0.05;

  // nested kaleidoscope (tier 3+): the void itself folds, slower
  if (uNestedFold > 0.001) {
    float th = atan(p.y, p.x) + uTime * 0.012;
    float a = fold(th, uNestedFold);
    p = vec2(cos(a), sin(a)) * r;
  }

  vec2 q = p * uNoiseScale * 0.55 + uSeed;
  float n;
  if (uNoiseType < 0.5) {
    n = fbm(q + uWarp * vec2(fbm(q + t), fbm(q - t)));
  } else if (uNoiseType < 1.5) {
    float v = fbm(q + uWarp * 0.6 * vec2(fbm(q + t), fbm(q * 1.3 - t)));
    n = 1.0 - abs(2.0 * v - 1.0);
    n = n * n;
  } else if (uNoiseType < 2.5) {
    float g1 = fbm(q + vec2(t * 0.6, -t * 0.4));
    float g2 = fbm(q * 1.3 - vec2(t * 0.3, t * 0.5) + 5.2);
    vec2 curl = vec2(g2 - 0.5, 0.5 - g1);
    n = fbm(q + (1.0 + uWarp) * curl + vec2(0.0, t));
  } else if (uNoiseType < 3.5) {
    float d = voronoi(q + uWarp * 0.5 * vec2(fbm(q + t), fbm(q - t)));
    n = 1.0 - smoothstep(0.0, 0.9, d);
  } else {
    // domainWarp2x: warp of a warp — the liquid look
    vec2 w1 = vec2(fbm(q + t * 0.7), fbm(q + 4.7 - t * 0.5));
    vec2 w2 = vec2(fbm(q + 2.4 * w1 + 1.7), fbm(q + 2.4 * w1 + 8.2));
    n = fbm(q + uWarp * 2.2 * w2);
  }

  vec3 tb = sampleDual(uTexB, vUV, uTime);
  if (uPhaseMix > 0.001) {
    tb = mix(tb, sampleDual(uTexB2, vUV, uTime), uPhaseMix);
  }

  float lum = clamp(n * 0.62 + dot(tb, vec3(0.333)) * 0.5, 0.0, 1.0);
  vec3 col = texture(uLut, vec2(lum * 0.72 + 0.02, 0.5)).rgb;
  col *= 0.42 + 0.5 * n; // keep visible structure in the void
  // compression vs the wedge: −45% saturation, −20% luminance
  float grey = dot(col, vec3(0.333));
  col = mix(vec3(grey), col, 0.55) * 0.8;
  col *= 1.0 - 0.6 * pow(min(r, 1.4), 1.6); // darker toward the rim

  // previous-frame feedback smear (slow zoom-rotate) — trippy trails
  if (uFeedback > 0.001) {
    vec2 fuv = rot(vUV - 0.5, 0.006) * 0.992 + 0.5;
    vec3 prev = texture(uPrev, fuv).rgb;
    col = mix(col, max(col, prev * 0.985), uFeedback);
  }

  finalColor = vec4(col, 1.0);
}
`;

export interface BgParams {
  time: number;
  seed: number;
  phaseMix: number;
  noiseType: number;
  noiseScale: number;
  warp: number;
  blendMode: number;
  drift: number;
  feedback: number;
  nestedFold: number;
}

export class BackgroundPass {
  /** the RT the mirror pass reads this frame */
  rt: RenderTexture;
  private back: RenderTexture;
  private mesh: Mesh<Geometry, Shader>;

  constructor(size: number, texB: Texture, lut: Texture) {
    this.rt = RenderTexture.create({ width: size, height: size });
    this.back = RenderTexture.create({ width: size, height: size });
    this.mesh = quadMesh(
      BG_FRAG,
      {
        bgUniforms: {
          uTime: { value: 0, type: 'f32' },
          uSeed: { value: 0, type: 'f32' },
          uPhaseMix: { value: 0, type: 'f32' },
          uNoiseType: { value: 0, type: 'f32' },
          uNoiseScale: { value: 3, type: 'f32' },
          uWarp: { value: 0.6, type: 'f32' },
          uBlendMode: { value: 0, type: 'f32' },
          uDrift: { value: 1, type: 'f32' },
          uFeedback: { value: 0, type: 'f32' },
          uNestedFold: { value: 0, type: 'f32' },
        },
        uTexB: texB.source,
        uTexB2: texB.source,
        uLut: lut.source,
        uPrev: texB.source,
      },
      'vortika-bg'
    );
  }

  setTextures(current: Texture, next: Texture): void {
    this.mesh.shader!.resources.uTexB = current.source;
    this.mesh.shader!.resources.uTexB2 = next.source;
  }

  render(renderer: Renderer, p: BgParams): void {
    // ping-pong: write into `back` while reading last frame's `rt`
    const u = this.mesh.shader!.resources.bgUniforms.uniforms;
    u.uTime = p.time;
    u.uSeed = p.seed;
    u.uPhaseMix = p.phaseMix;
    u.uNoiseType = p.noiseType;
    u.uNoiseScale = p.noiseScale;
    u.uWarp = p.warp;
    u.uBlendMode = p.blendMode;
    u.uDrift = p.drift;
    u.uFeedback = p.feedback;
    u.uNestedFold = p.nestedFold;
    this.mesh.shader!.resources.uPrev = this.rt.source;
    renderer.render({ container: this.mesh, target: this.back, clear: true });
    const tmp = this.rt;
    this.rt = this.back;
    this.back = tmp;
  }
}
