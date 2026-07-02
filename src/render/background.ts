import { Mesh, RenderTexture } from 'pixi.js';
import type { Geometry, Renderer, Shader, Texture } from 'pixi.js';
import { quadMesh } from './gfx';

/**
 * Fullscreen flow-noise fractal background (half-res). 4-octave FBM,
 * curl-style domain warp, time-warped at t*0.05, blended with the phase's
 * sourceB texture (dual independent drift), pushed through the palette LUT
 * and darkened toward the rim. Slow. Hypnotic.
 */

const BG_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexB;
uniform sampler2D uTexB2;
uniform sampler2D uLut;
uniform float uTime;
uniform float uSeed;
uniform float uPhaseMix;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453);
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
vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c) * p;
}
vec3 sampleDual(sampler2D tex, vec2 uv, float t) {
  vec2 uv1 = rot(uv - 0.5, t * 0.02) * 1.05 + 0.5 + vec2(t * 0.006, -t * 0.004);
  vec2 uv2 = rot(uv - 0.5, -t * 0.02) * 1.4 + 0.5 + vec2(-t * 0.004, t * 0.007);
  return mix(texture(tex, uv1).rgb, texture(tex, uv2).rgb, 0.5 + 0.3 * sin(t * 0.07));
}
void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);
  float t = uTime * 0.05;

  // curl-advected flow: warp the fbm domain by a rotated gradient of itself
  vec2 q = p * 1.8 + uSeed;
  float g1 = fbm(q + vec2(t * 0.6, -t * 0.4));
  float g2 = fbm(q * 1.3 - vec2(t * 0.3, t * 0.5) + 5.2);
  vec2 curl = vec2(g2 - 0.5, 0.5 - g1); // divergence-free-ish swirl
  float n = fbm(q + 1.6 * curl + vec2(0.0, t));

  vec3 tb = sampleDual(uTexB, vUV, uTime);
  if (uPhaseMix > 0.001) {
    tb = mix(tb, sampleDual(uTexB2, vUV, uTime), uPhaseMix);
  }

  float lum = clamp(n * 0.62 + dot(tb, vec3(0.333)) * 0.5, 0.0, 1.0);
  vec3 col = texture(uLut, vec2(lum * 0.72 + 0.02, 0.5)).rgb;
  col *= 0.5 + 0.25 * n;
  col *= 1.0 - 0.6 * pow(min(r, 1.4), 1.6); // darker toward the rim
  finalColor = vec4(col, 1.0);
}
`;

export class BackgroundPass {
  rt: RenderTexture;
  private mesh: Mesh<Geometry, Shader>;

  constructor(size: number, texB: Texture, lut: Texture) {
    this.rt = RenderTexture.create({ width: size, height: size });
    this.mesh = quadMesh(
      BG_FRAG,
      {
        bgUniforms: {
          uTime: { value: 0, type: 'f32' },
          uSeed: { value: 0, type: 'f32' },
          uPhaseMix: { value: 0, type: 'f32' },
        },
        uTexB: texB.source,
        uTexB2: texB.source,
        uLut: lut.source,
      },
      'vortika-bg'
    );
  }

  setTextures(current: Texture, next: Texture): void {
    this.mesh.shader!.resources.uTexB = current.source;
    this.mesh.shader!.resources.uTexB2 = next.source;
  }

  render(renderer: Renderer, time: number, seed: number, phaseMix: number): void {
    const u = this.mesh.shader!.resources.bgUniforms.uniforms;
    u.uTime = time;
    u.uSeed = seed;
    u.uPhaseMix = phaseMix;
    renderer.render({ container: this.mesh, target: this.rt, clear: true });
  }

  resize(size: number): void {
    this.rt.resize(size, size);
  }
}
