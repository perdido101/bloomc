import { Geometry, Mesh, Shader } from 'pixi.js';
import type { RenderTexture, Renderer, Texture } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { GLSL_FOLD, QUAD_VERT, es300, fullscreenGeometry } from './gfx';

/**
 * The kaleidoscope tunnel (behind-the-runner view). A single fullscreen
 * pass ray-casts a CYLINDER in one-point perspective — a true mandala
 * around the vanishing point — with a flat floor chord to run on. The
 * cross-section angle is mirror-folded into mirrorN wedges (matching the
 * live DNA), the whole pattern corkscrews along z (endless spiral) and
 * slowly rotates, petal accents give the fold visible structure, and
 * glowing mandala rings sweep past for speed. Everything vanishes into a
 * portal of light at the center.
 *
 * The projection is the exact inverse of project() in main.ts — obstacles
 * drawn on top land pixel-perfectly on these surfaces.
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

${GLSL_FOLD}

vec3 lut(float t) {
  return texture(uLut, vec2(clamp(t, 0.01, 0.99), 0.5)).rgb;
}

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float F = uCam.w;
  float time = uMotion.x;
  vec2 rd = vec2(p.x, p.y - uGeo.x); // ray slope per unit z

  // the tunnel breathes a little (wobble from the DNA)
  float R = uGeo.y * (1.0 + uLook.y * 1.2 * sin(time * uLook.z));
  float yc = uGeo.z;

  // cylinder |(x, y) - (0, yc)| = R along the ray (camera is inside)
  float qa = dot(rd, rd) / (F * F);
  float qb = 2.0 * (rd.x * uCam.x + rd.y * (uCam.y - yc)) / F;
  float qc = uCam.x * uCam.x + (uCam.y - yc) * (uCam.y - yc) - R * R;
  float dzC = (-qb + sqrt(max(qb * qb - 4.0 * qa * qc, 0.0))) / max(2.0 * qa, 1e-6);

  // floor chord y = 0, only inside the cylinder
  float halfW = sqrt(max(R * R - yc * yc, 0.0));
  float dzF = 1e9;
  if (rd.y < -1e-4) {
    float d = -uCam.y * F / rd.y;
    float xf = uCam.x + rd.x * d / F;
    if (abs(xf) <= halfW) dzF = d;
  }
  bool onFloor = dzF < dzC;
  float dz = clamp(min(dzF, dzC), 0.35, 240.0);

  vec3 hit = vec3(uCam.x + rd.x * dz / F, uCam.y + rd.y * dz / F, uCam.z + dz);

  // ---- the kaleidoscope: fold the angle around the tunnel axis ----
  float th = atan(hit.y - yc, hit.x);
  float aa = th + uMotion.z + hit.z * uLook.w
           + uLook.y * sin(hit.z * 0.35 + time * uLook.z) * 1.6;
  float fA = fold(aa, uFold.x) / uFold.x;
  float fB = fold(aa, uFold.y) / uFold.y;
  float fw = mix(fA, fB, uFold.z);

  // pattern coordinates: a texture tile every ~8–15 units so shapes RUSH
  // PAST instead of smearing into rays
  float zn = hit.z * (0.06 + uLook.x * 0.015);
  vec2 tuv = vec2(fw * (0.5 + uLook.x * 0.1), zn + fw * 0.13);
  vec3 tA = texture(uTexA, tuv).rgb;
  vec3 tB = texture(uTexB, tuv).rgb;
  vec3 t = mix(tA, tB, uFold.w);
  float lum = dot(t, vec3(0.299, 0.587, 0.114));

  vec3 col = lut(lum) * (0.42 + 0.58 * lum);

  // petal accents — every wedge blooms toward its center line
  float pet = pow(0.5 + 0.5 * cos((fw * 2.0 - 1.0) * 3.14159), 3.0);
  col += lut(0.72) * pet * (0.20 + 0.10 * uMotion.y);

  // mirror seams glow — the spokes of the mandala, corkscrewing past
  float sd = min(fw, 1.0 - fw);
  col += lut(0.88) * exp(-sd * sd * 160.0) * 0.30;

  // mandala rings every 6 units, pulsing on the beat
  float rib = fract(hit.z / 6.0);
  rib = min(rib, 1.0 - rib);
  col += lut(0.92) * exp(-rib * rib * 900.0) * (0.35 + 0.55 * uMotion.y);

  if (onFloor) {
    col *= 0.36; // the floor reads as ground, not pattern
    // three lit lanes: guide lines at the lane boundaries
    float ax = abs(hit.x);
    float dl = min(abs(ax - uGeo.w * 0.5), abs(ax - uGeo.w * 1.5));
    col += lut(0.8) * exp(-dl * dl * 90.0) * 0.5;
    col += lut(0.6) * exp(-hit.x * hit.x * 1.2) * 0.05;
  }

  // depth fog into the palette's deep end
  float fog = 1.0 - exp(-dz * 0.030);
  col = mix(col, lut(0.06) * 0.85, fog * fog);

  // the portal: light at the end of the spiral
  vec2 vp = p - vec2(0.0, uGeo.x);
  float port = exp(-dot(vp, vp) * 7.0);
  col += lut(0.94) * port * port * (0.55 + 0.25 * uMotion.y);

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
  /** 0..1 whole-world brightness (menus dim the tunnel) */
  dim: number;
  noiseScale: number;
  wobAmp: number;
  wobFreq: number;
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
    renderer.render({ container: this.mesh, target, clear: true });
  }
}
