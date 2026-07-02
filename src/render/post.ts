import { Mesh, RenderTexture } from 'pixi.js';
import type { Geometry, Renderer, Shader, Texture } from 'pixi.js';
import { quadMesh } from './gfx';
import { TUNING } from '../game/difficulty';

/**
 * Post chain (§10): bright-pass → two-level Gaussian bloom (half + quarter
 * res) → final composite with chromatic aberration, barrel distortion,
 * breathing vignette, dash/death effects, and letterbox margins filled with
 * a darkened blurred copy of the scene (never black bars).
 */

const BRIGHT_FRAG = /* glsl */ `
precision mediump float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uScene;
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  vec3 b = max(c - ${TUNING.BLOOM_THRESHOLD}, 0.0) / ${(1 - TUNING.BLOOM_THRESHOLD).toFixed(4)};
  finalColor = vec4(b, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision mediump float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uSrc;
uniform vec2 uDir; // texel-scaled direction
void main() {
  vec3 c = texture(uSrc, vUV).rgb * 0.227027;
  c += texture(uSrc, vUV + uDir * 1.3846).rgb * 0.3162162;
  c += texture(uSrc, vUV - uDir * 1.3846).rgb * 0.3162162;
  c += texture(uSrc, vUV + uDir * 3.2308).rgb * 0.0702703;
  c += texture(uSrc, vUV - uDir * 3.2308).rgb * 0.0702703;
  finalColor = vec4(c, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uScene;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform vec2 uScreen;      // canvas size, device px
uniform vec3 uLayout;      // square offset x, y, side (device px)
uniform vec4 uFx;          // caSpike 0..1, ripple 0..1, zoom 0..1, breathe
uniform vec2 uZoomCenter;  // square-uv focus of the death zoom
uniform vec3 uVigColor;
uniform vec4 uParams;      // barrel, bloomGain, caBase, caRadial

float mirr(float x) {
  x = abs(x);
  return x > 1.0 ? 2.0 - x : x;
}

void main() {
  vec2 px = vUV * uScreen;
  vec2 suv = (px - uLayout.xy) / uLayout.z;
  vec2 m = abs(suv - 0.5);
  float inside = 1.0 - smoothstep(0.495, 0.505, max(m.x, m.y));

  vec2 c = suv * 2.0 - 1.0;
  // death slow-mo zoom toward the shard
  c = mix(c, uZoomCenter * 2.0 - 1.0, uFx.z * 0.4);
  c /= 1.0 + uFx.z * 0.9;
  float r2 = dot(c, c);
  c *= 1.0 + uParams.x * r2; // subtle barrel for extra fisheye
  float r = sqrt(dot(c, c));
  vec2 zuv = c * 0.5 + 0.5;

  float ca = (uParams.z + uParams.w * r) * (1.0 + uFx.x * 3.0);
  vec2 dir = r > 1e-4 ? c / r : vec2(0.0);
  vec3 col;
  col.r = texture(uScene, zuv + dir * ca).r;
  col.g = texture(uScene, zuv).g;
  col.b = texture(uScene, zuv - dir * ca).b;

  col += (texture(uB1, zuv).rgb * 0.65 + texture(uB2, zuv).rgb * 0.85) * uParams.y;

  // symmetric shockwave ripple (dash / new-best)
  if (uFx.y > 0.001) {
    float rr = (1.0 - uFx.y) * 1.35;
    float d = r - rr;
    col += (uVigColor + 0.6) * exp(-d * d * 320.0) * uFx.y * 0.9;
  }

  // breathing vignette, palette-dark
  float vig = smoothstep(0.55, 1.3, r) * (0.5 + 0.03 * uFx.w);
  col = mix(col, uVigColor * 0.35, vig);

  // margins outside the square: darkened blurred copy of the scene
  vec2 ms = vec2(mirr(suv.x), mirr(suv.y));
  vec3 margin = texture(uB2, ms).rgb * 0.7 + texture(uScene, ms).rgb * 0.18;
  finalColor = vec4(mix(margin * 0.45, col, inside), 1.0);
}
`;

export class PostChain {
  private bright: Mesh<Geometry, Shader>;
  private blurH1: Mesh<Geometry, Shader>;
  private blurV1: Mesh<Geometry, Shader>;
  private blurH2: Mesh<Geometry, Shader>;
  private blurV2: Mesh<Geometry, Shader>;
  private composite: Mesh<Geometry, Shader>;
  private brightRT: RenderTexture;
  private halfA: RenderTexture;
  private halfB: RenderTexture;
  private quarterA: RenderTexture;
  private quarterB: RenderTexture;
  private half: number;
  private quarter: number;

  constructor(sceneTex: Texture, size: number) {
    this.half = Math.max(2, size >> 1);
    this.quarter = Math.max(2, size >> 2);
    this.brightRT = RenderTexture.create({ width: this.half, height: this.half });
    this.halfA = RenderTexture.create({ width: this.half, height: this.half });
    this.halfB = RenderTexture.create({ width: this.half, height: this.half });
    this.quarterA = RenderTexture.create({ width: this.quarter, height: this.quarter });
    this.quarterB = RenderTexture.create({ width: this.quarter, height: this.quarter });

    this.bright = quadMesh(BRIGHT_FRAG, { uScene: sceneTex.source }, 'post-bright');
    const blur = (src: Texture, name: string) =>
      quadMesh(
        BLUR_FRAG,
        {
          blurUniforms: { uDir: { value: new Float32Array(2), type: 'vec2<f32>' } },
          uSrc: src.source,
        },
        name
      );
    this.blurH1 = blur(this.brightRT, 'post-blur-h1');
    this.blurV1 = blur(this.halfA, 'post-blur-v1');
    this.blurH2 = blur(this.halfB, 'post-blur-h2');
    this.blurV2 = blur(this.quarterA, 'post-blur-v2');

    this.composite = quadMesh(
      COMPOSITE_FRAG,
      {
        postUniforms: {
          uScreen: { value: new Float32Array(2), type: 'vec2<f32>' },
          uLayout: { value: new Float32Array(3), type: 'vec3<f32>' },
          uFx: { value: new Float32Array(4), type: 'vec4<f32>' },
          uZoomCenter: { value: new Float32Array([0.5, 0.5]), type: 'vec2<f32>' },
          uVigColor: { value: new Float32Array(3), type: 'vec3<f32>' },
          uParams: {
            value: new Float32Array([TUNING.BARREL_K, 1, TUNING.CA_BASE, TUNING.CA_RADIAL]),
            type: 'vec4<f32>',
          },
        },
        uScene: sceneTex.source,
        uB1: this.halfB.source,
        uB2: this.quarterB.source,
      },
      'post-composite'
    );
  }

  private setDir(mesh: Mesh<Geometry, Shader>, x: number, y: number): void {
    const d = mesh.shader!.resources.blurUniforms.uniforms.uDir as Float32Array;
    d[0] = x;
    d[1] = y;
  }

  render(
    renderer: Renderer,
    opts: {
      screenW: number;
      screenH: number;
      squareX: number;
      squareY: number;
      squareSize: number;
      caSpike: number;
      ripple: number;
      zoom: number;
      breathe: number;
      zoomCx: number;
      zoomCy: number;
      vigColor: ArrayLike<number>;
      reduceFlash: boolean;
    }
  ): void {
    renderer.render({ container: this.bright, target: this.brightRT, clear: true });
    this.setDir(this.blurH1, 1 / this.half, 0);
    renderer.render({ container: this.blurH1, target: this.halfA, clear: true });
    this.setDir(this.blurV1, 0, 1 / this.half);
    renderer.render({ container: this.blurV1, target: this.halfB, clear: true });
    this.setDir(this.blurH2, 1 / this.quarter, 0);
    renderer.render({ container: this.blurH2, target: this.quarterA, clear: true });
    this.setDir(this.blurV2, 0, 1 / this.quarter);
    renderer.render({ container: this.blurV2, target: this.quarterB, clear: true });

    const u = this.composite.shader!.resources.postUniforms.uniforms;
    (u.uScreen as Float32Array)[0] = opts.screenW;
    (u.uScreen as Float32Array)[1] = opts.screenH;
    const lay = u.uLayout as Float32Array;
    lay[0] = opts.squareX;
    lay[1] = opts.squareY;
    lay[2] = opts.squareSize;
    const fx = u.uFx as Float32Array;
    fx[0] = opts.reduceFlash ? 0 : opts.caSpike;
    fx[1] = opts.ripple;
    fx[2] = opts.zoom;
    fx[3] = opts.breathe;
    const zc = u.uZoomCenter as Float32Array;
    zc[0] = opts.zoomCx;
    zc[1] = opts.zoomCy;
    const vc = u.uVigColor as Float32Array;
    vc[0] = opts.vigColor[0];
    vc[1] = opts.vigColor[1];
    vc[2] = opts.vigColor[2];
    (u.uParams as Float32Array)[1] = opts.reduceFlash ? 0.45 : 1.0;

    renderer.render({ container: this.composite, clear: true });
  }
}
