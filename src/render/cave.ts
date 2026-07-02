import { Geometry, Mesh, Shader } from 'pixi.js';
import type { RenderTexture, Renderer, Texture } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { GLSL_FOLD, QUAD_VERT, es300, fullscreenGeometry } from './gfx';

/**
 * The kaleidoscope cave (behind-the-runner view). A single fullscreen pass
 * ray-casts a rectangular corridor in one-point perspective — floor,
 * ceiling, two walls — and wraps a live kaleidoscope over every surface:
 * the cross-section angle around the corridor axis is mirror-folded
 * (mirrorN wedges, matching the DNA), the fold twists slowly along z, and
 * the folded coordinate samples the phase texture through the palette LUT.
 * Glowing ribs sweep past every few meters for speed feel, the floor
 * carries three lit lane guides, and everything vanishes into a portal
 * of light at the vanishing point.
 *
 * The projection here is the exact inverse of project() in main.ts —
 * obstacles drawn on top land pixel-perfectly on these surfaces.
 */

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform sampler2D uLut;
uniform vec4 uCam;    // camX, camY, camZ, focal
uniform vec4 uGeo;    // vpY, halfW, caveH, laneX
uniform vec4 uFold;   // wedgeA, wedgeB, foldMix, texMix
uniform vec4 uMotion; // time, beat, twist, dim
uniform vec4 uLook;   // noiseScale, wobAmp, wobFreq, spiralFlow

${GLSL_FOLD}

vec3 lut(float t) {
  return texture(uLut, vec2(clamp(t, 0.01, 0.99), 0.5)).rgb;
}

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float F = uCam.w;
  float time = uMotion.x;
  vec2 rd = vec2(p.x, p.y - uGeo.x); // ray slope per unit z

  // cave breathes a little (wobble from the DNA)
  float breathe = 1.0 + uLook.y * 1.4 * sin(time * uLook.z + p.x * 2.0);
  float W = uGeo.y * breathe;
  float H = uGeo.z * breathe;

  // nearest surface along +z: floor y=0, ceiling y=H, walls x=±W
  float dz = 240.0;
  if (rd.y < -1e-4) dz = min(dz, -uCam.y * F / rd.y);
  if (rd.y >  1e-4) dz = min(dz, (H - uCam.y) * F / rd.y);
  if (abs(rd.x) > 1e-4) {
    float dw = ((rd.x > 0.0 ? W : -W) - uCam.x) * F / rd.x;
    if (dw > 0.0) dz = min(dz, dw);
  }
  dz = clamp(dz, 0.35, 240.0);

  vec3 hit = vec3(uCam.x + rd.x * dz / F, uCam.y + rd.y * dz / F, uCam.z + dz);
  bool onFloor = rd.y < -1e-4 && abs(dz + uCam.y * F / rd.y) < 1e-3;
  bool onCeil  = rd.y >  1e-4 && abs(dz - (H - uCam.y) * F / rd.y) < 1e-3;

  // ---- the kaleidoscope: fold the cross-section angle ----
  float ang = atan(hit.y - H * 0.42, hit.x);
  float aa = ang + uMotion.z * hit.z * 0.05 + time * 0.05
           + uLook.y * sin(hit.z * 0.35 + time * uLook.z) * 1.6;
  float fA = fold(aa, uFold.x) / uFold.x;
  float fB = fold(aa, uFold.y) / uFold.y;
  float fw = mix(fA, fB, uFold.z);

  // pattern coordinates: fold across the wedge, real distance along z —
  // a texture tile every ~8–15 units so shapes RUSH PAST instead of
  // smearing into rays
  float zn = hit.z * (0.06 + uLook.x * 0.015) + uLook.w * sin(fw * 6.2831) * 0.05;
  vec2 tuv = vec2(fw * (0.5 + uLook.x * 0.1), zn + fw * 0.13);
  vec3 tA = texture(uTexA, tuv).rgb;
  vec3 tB = texture(uTexB, tuv).rgb;
  vec3 t = mix(tA, tB, uFold.w);
  float lum = dot(t, vec3(0.299, 0.587, 0.114));

  vec3 col = lut(lum) * (0.42 + 0.58 * lum);

  // mirror seams glow — the spokes of the mandala, racing past
  float sd = min(fw, 1.0 - fw);
  col += lut(0.85) * exp(-sd * sd * 140.0) * 0.18;

  // each surface reads distinctly: ceiling recedes, walls step back
  if (onCeil) col *= 0.55;
  else if (!onFloor) col *= 0.75;

  // ribs: glowing hoops every 6 units, pulsing on the beat
  float rib = fract(hit.z / 6.0);
  rib = min(rib, 1.0 - rib);
  col += lut(0.92) * exp(-rib * rib * 900.0) * (0.3 + 0.55 * uMotion.y);

  if (onFloor) {
    col *= 0.4; // the floor reads as ground, not wall
    // three lit lanes: guide lines at the lane boundaries
    float ax = abs(hit.x);
    float dl = min(abs(ax - uGeo.w * 0.5), abs(ax - uGeo.w * 1.5));
    col += lut(0.8) * exp(-dl * dl * 90.0) * 0.7;
    // faint center-lane sheen
    col += lut(0.6) * exp(-hit.x * hit.x * 1.2) * 0.05;
  }

  // depth fog into the palette's deep end
  float fog = 1.0 - exp(-dz * 0.030);
  col = mix(col, lut(0.06) * 0.85, fog * fog);

  // the portal: light at the end of the cave
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
  twist: number;
  /** 0..1 whole-world brightness (menus dim the cave) */
  dim: number;
  noiseScale: number;
  wobAmp: number;
  wobFreq: number;
  spiralFlow: number;
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
            value: new Float32Array([TUNING.VP_Y, TUNING.CAVE_HALF_W, TUNING.CAVE_H, TUNING.LANE_X]),
            type: 'vec4<f32>',
          },
          uFold: { value: new Float32Array([Math.PI / 4, Math.PI / 4, 0, 0]), type: 'vec4<f32>' },
          uMotion: { value: new Float32Array([0, 0, 0, 1]), type: 'vec4<f32>' },
          uLook: { value: new Float32Array([3, 0, 1, 0]), type: 'vec4<f32>' },
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
    mo[2] = o.twist;
    mo[3] = o.dim;
    const lk = u.uLook as Float32Array;
    lk[0] = o.noiseScale;
    lk[1] = o.wobAmp;
    lk[2] = o.wobFreq;
    lk[3] = o.spiralFlow;
    renderer.render({ container: this.mesh, target, clear: true });
  }
}
