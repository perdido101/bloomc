import { Geometry, Mesh, Shader } from 'pixi.js';
import type { RenderTexture, Renderer, Texture } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { GLSL_FOLD, QUAD_VERT, es300, fullscreenGeometry } from './gfx';

/**
 * The living kaleidoscope (behind-the-cat view). One fullscreen pass:
 *
 *  · NEAR — a cylinder ray-cast around the vanishing point. The fold
 *    wraps the whole cross-section, corkscrews along z (endless spiral),
 *    slowly rotates, and is domain-warped by two texture octaves so every
 *    DNA reads differently. No floor — you float in open pattern-space.
 *  · FAR — a true 2D kaleidoscope face in screen polar coordinates, the
 *    view straight down the instrument: folded wedges, concentric
 *    pattern rings flowing outward as you fly into it.
 *
 * The two blend by depth fog, so the whole screen is kaleidoscope.
 * The projection is the exact inverse of project() in main.ts.
 */

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform sampler2D uLut;
uniform vec4 uCam;    // camX, camY, camZ, focal
uniform vec4 uGeo;    // vpY, tunnelR, axisY, laneX
uniform vec4 uFold;   // wedgeA, wedgeB, foldMix, texMix
uniform vec4 uMotion; // time, beat, spin, dim
uniform vec4 uLook;   // noiseScale, wobAmp, wobFreq, spiralRate
uniform vec4 uVar;    // warpStrength, texDrift, detail, petalSharp

${GLSL_FOLD}

vec3 lut(float t) {
  return texture(uLut, vec2(clamp(t, 0.01, 0.99), 0.5)).rgb;
}

vec3 patTex(vec2 uv) {
  return mix(texture(uTexA, uv).rgb, texture(uTexB, uv).rgb, uFold.w);
}

// folded-pattern sample shared by tunnel & face: fw = wedge frac 0..1,
// s = distance coordinate along the pattern's flow
vec3 kaleid(float fw, float s, out float lum) {
  vec2 uv = vec2(fw * (0.5 + uLook.x * 0.1), s + fw * 0.13);
  // detail octave + domain warp — DNA decides how much
  vec3 base = patTex(uv);
  vec2 warp = (base.rb - 0.5) * uVar.x * 0.22;
  vec3 fine = patTex(uv * 2.618 + warp + 0.37);
  vec3 t = mix(base, fine, 0.28 + 0.3 * uVar.z);
  lum = dot(t, vec3(0.299, 0.587, 0.114));
  vec3 col = lut(lum) * (0.42 + 0.58 * lum);
  // petal accents — every wedge blooms toward its center line
  float pet = pow(0.5 + 0.5 * cos((fw * 2.0 - 1.0) * 3.14159), uVar.w);
  col += lut(0.72) * pet * (0.22 + 0.10 * uMotion.y);
  // mirror seams glow — the spokes of the mandala
  float sd = min(fw, 1.0 - fw);
  col += lut(0.88) * exp(-sd * sd * 160.0) * 0.30;
  return col;
}

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float F = uCam.w;
  float time = uMotion.x;
  vec2 rd = vec2(p.x, p.y - uGeo.x); // ray slope per unit z

  // the tunnel breathes a little (wobble from the DNA)
  float R = uGeo.y * (1.0 + uLook.y * 1.2 * sin(time * uLook.z));
  float yc = uGeo.z;

  // ---- NEAR: cylinder |(x,y)-(0,yc)| = R along the ray ----
  float qa = dot(rd, rd) / (F * F);
  float qb = 2.0 * (rd.x * uCam.x + rd.y * (uCam.y - yc)) / F;
  float qc = uCam.x * uCam.x + (uCam.y - yc) * (uCam.y - yc) - R * R;
  float dz = (-qb + sqrt(max(qb * qb - 4.0 * qa * qc, 0.0))) / max(2.0 * qa, 1e-5);
  dz = clamp(dz, 0.35, 400.0);
  vec3 hit = vec3(uCam.x + rd.x * dz / F, uCam.y + rd.y * dz / F, uCam.z + dz);

  float th = atan(hit.y - yc, hit.x);
  float aa = th + uMotion.z + hit.z * uLook.w
           + uLook.y * sin(hit.z * 0.35 + time * uLook.z) * 1.6;
  float fA = fold(aa, uFold.x) / uFold.x;
  float fB = fold(aa, uFold.y) / uFold.y;
  float fw = mix(fA, fB, uFold.z);
  float lum;
  vec3 col = kaleid(fw, hit.z * (0.06 + uLook.x * 0.015), lum);

  // mandala rings every 6 units, pulsing on the beat
  float rib = fract(hit.z / 6.0);
  rib = min(rib, 1.0 - rib);
  col += lut(0.92) * exp(-rib * rib * 900.0) * (0.35 + 0.55 * uMotion.y);

  // ---- FAR: the kaleidoscope's face, straight down the instrument ----
  vec2 vp = p - vec2(0.0, uGeo.x);
  float rad = length(vp);
  float ang = atan(vp.y, vp.x) - uMotion.z * 1.4 - time * uVar.y * 0.06;
  float ffA = fold(ang, uFold.x) / uFold.x;
  float ffB = fold(ang, uFold.y) / uFold.y;
  float ffw = mix(ffA, ffB, uFold.z);
  // log-radial flow: rings of pattern POUR outward as you fly in
  float fr = log(rad + 0.045) * 0.42 - uCam.z * 0.032;
  float lumF;
  vec3 colF = kaleid(ffw, fr, lumF) * 1.15;
  // concentric pattern rings on the face
  float cring = fract(fr * 5.0);
  cring = min(cring, 1.0 - cring);
  colF += lut(0.9) * exp(-cring * cring * 420.0) * 0.3;

  // blend by depth: near = tunnel wall rushing past, far/center = the face
  float fog = 1.0 - exp(-dz * 0.022);
  col = mix(col, colF, smoothstep(0.45, 1.0, fog));

  // the portal: light at the eye of the mandala
  float port = exp(-rad * rad * 7.0);
  col += lut(0.94) * port * port * (0.5 + 0.25 * uMotion.y);

  col *= uMotion.w;
  finalColor = vec4(col, 1.0);
}
`;

export interface CaveOpts {
  camX: number;
  camY: number;
  camZ: number;
  time: number;
  beat: number;
  /** wedge widths (2π/mirrorN) for current & next DNA + morph mix */
  wedgeA: number;
  wedgeB: number;
  foldMix: number;
  texMix: number;
  /** live rotation of the whole mandala, radians */
  spin: number;
  /** helix: radians of pattern twist per world unit of depth */
  spiralRate: number;
  /** 0..1 whole-world brightness (menus dim the kaleidoscope) */
  dim: number;
  noiseScale: number;
  wobAmp: number;
  wobFreq: number;
  /** DNA variation: domain warp, pattern drift, detail octave, petal sharpness */
  warp: number;
  texDrift: number;
  detail: number;
  petalSharp: number;
}

export class CavePass {
  private mesh: Mesh<Geometry, Shader>;

  constructor(texA: Texture, lut: Texture) {
    const shader = Shader.from({
      gl: { vertex: es300(QUAD_VERT), fragment: es300(FRAG), name: 'bloom-cave' },
      resources: {
        caveUniforms: {
          uCam: { value: new Float32Array([0, TUNING.CAM_H, 0, TUNING.CAM_F]), type: 'vec4<f32>' },
          uGeo: {
            value: new Float32Array([TUNING.VP_Y, TUNING.TUNNEL_R, TUNING.TUNNEL_Y, TUNING.LANE_X]),
            type: 'vec4<f32>',
          },
          uFold: { value: new Float32Array([Math.PI / 4, Math.PI / 4, 0, 0]), type: 'vec4<f32>' },
          uMotion: { value: new Float32Array([0, 0, 0, 1]), type: 'vec4<f32>' },
          uLook: { value: new Float32Array([3, 0, 1, 0.08]), type: 'vec4<f32>' },
          uVar: { value: new Float32Array([0.5, 1, 0.5, 3]), type: 'vec4<f32>' },
        },
        uTexA: texA.source,
        uTexB: texA.source,
        uLut: lut.source,
      },
    });
    this.mesh = new Mesh({ geometry: fullscreenGeometry(), shader });
  }

  setTextures(cur: Texture, next: Texture): void {
    this.mesh.shader!.resources.uTexA = cur.source;
    this.mesh.shader!.resources.uTexB = next.source;
  }

  render(renderer: Renderer, target: RenderTexture, o: CaveOpts): void {
    const u = this.mesh.shader!.resources.caveUniforms.uniforms;
    const cam = u.uCam as Float32Array;
    cam[0] = o.camX;
    cam[1] = o.camY;
    cam[2] = o.camZ;
    const fold = u.uFold as Float32Array;
    fold[0] = o.wedgeA;
    fold[1] = o.wedgeB;
    fold[2] = o.foldMix;
    fold[3] = o.texMix;
    const mo = u.uMotion as Float32Array;
    mo[0] = o.time;
    mo[1] = o.beat;
    mo[2] = o.spin;
    mo[3] = o.dim;
    const lk = u.uLook as Float32Array;
    lk[0] = o.noiseScale;
    lk[1] = o.wobAmp;
    lk[2] = o.wobFreq;
    lk[3] = o.spiralRate;
    const va = u.uVar as Float32Array;
    va[0] = o.warp;
    va[1] = o.texDrift;
    va[2] = o.detail;
    va[3] = o.petalSharp;
    renderer.render({ container: this.mesh, target, clear: true });
  }
}
