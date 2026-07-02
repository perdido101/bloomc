import { Mesh, RenderTexture } from 'pixi.js';
import type { Geometry, Renderer, Shader, Texture } from 'pixi.js';
import { GLSL_FOLD, GLSL_HUE_ROTATE, quadMesh } from './gfx';
import { TUNING } from '../game/difficulty';
import type { RingField } from '../game/rings';

/**
 * The kaleidoscope engine.
 *
 * WedgePass renders the master wedge — ALL gameplay: ring platform arcs,
 * hazards, razor petals and prisma motes — into a polar-unwrapped render
 * target: x = normalized screen radius (post-fisheye), y = wedge angle
 * fraction. Everything is evaluated analytically in the fragment shader from
 * uniform arrays, so the hot loop allocates nothing.
 *
 * MirrorPass folds every screen pixel into the wedge with true alternating
 * mirror reflection (period 2·w, reflected on odd copies — not just
 * rotational copies) and samples the wedge target. During a Bloom it folds
 * with both the old and the new mirror count and dissolves between them.
 * The CPU collision code in rings.ts applies the exact same fold math.
 */

export const MAX_RINGS = 7;
export const ARC_SLOTS = 6;
export const MAX_MOTES = 12;

const WEDGE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform vec4 uRings[${MAX_RINGS}];              // sInner, sOuter, phi, fade
uniform vec4 uArcs[${MAX_RINGS * ARC_SLOTS}];   // start, end, kind(0/1/2), spare
uniform vec4 uMotes[${MAX_MOTES}];              // sN, frac, active, seed
uniform sampler2D uTexA;
uniform sampler2D uTexA2;
uniform sampler2D uLut;
uniform float uWedge;    // wedge angular width, radians
uniform float uTime;
uniform float uBeat;     // 0..1 decaying beat pulse
uniform float uTexMix;   // phase texture crossfade

${GLSL_FOLD}
${GLSL_HUE_ROTATE}

vec3 lut(float t) {
  return texture(uLut, vec2(clamp(t, 0.02, 0.98), 0.5)).rgb;
}

void main() {
  float sN = vUV.x;
  float ang = vUV.y * uWedge; // wedge-local angle
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float aa = fwidth(vUV.y) * 1.5 + 0.004;

  for (int i = 0; i < ${MAX_RINGS}; i++) {
    vec4 R = uRings[i];
    if (R.y <= 0.0) continue;
    float mid = (R.x + R.y) * 0.5;
    float halfW = (R.y - R.x) * 0.5 * (1.0 + 0.015 * uBeat); // beat pulse
    float dr = sN - mid;
    if (abs(dr) > halfW * 3.2) continue;
    float fade = R.w;

    // ring-rotation fold inside the wedge (matches RingField.sample)
    float f = fold(ang - R.z, uWedge) / uWedge;

    float plat = 0.0;
    float haz = 0.0;
    for (int j = 0; j < ${ARC_SLOTS}; j++) {
      vec4 A = uArcs[i * ${ARC_SLOTS} + j];
      if (A.z < 0.5) continue;
      float m = smoothstep(A.x - aa, A.x + aa, f) * (1.0 - smoothstep(A.y - aa, A.y + aa, f));
      if (A.z < 1.5) plat = max(plat, m);
      else haz = max(haz, m);
    }

    float rr = dr / halfW; // -1 inner edge .. +1 outer edge
    float band = 1.0 - smoothstep(0.78, 1.0, abs(rr));

    // faint ghost band so gaps read as gaps, not voids
    float ghost = (1.0 - smoothstep(0.6, 1.0, abs(rr))) * 0.045 * fade;
    col += lut(0.34) * ghost;
    alpha = max(alpha, ghost);

    if (plat > 0.001) {
      // platform body: phase texture in polar UV + fresnel rim
      vec2 tuv = vec2(f * 2.0 + uTime * 0.008, sN * 3.0 - uTime * 0.005);
      vec3 texA = mix(texture(uTexA, tuv).rgb, texture(uTexA2, tuv).rgb, uTexMix);
      float texLum = dot(texA, vec3(0.299, 0.587, 0.114));
      float fres = pow(clamp(abs(rr), 0.0, 1.0), 3.0);
      float body = plat * band * fade;
      vec3 pc = lut(0.28 + texLum * 0.38 + fres * 0.30) + lut(0.93) * fres * 0.85;
      col += pc * body;
      alpha = max(alpha, body);
      // soft glow just beyond the band edges
      float glow = exp(-max(0.0, abs(rr) - 1.0) * 3.5) * plat * fade;
      col += lut(0.85) * glow * 0.10;
      alpha = max(alpha, glow * 0.10);
    }

    if (haz > 0.001) {
      // crystal spikes: zigzag radial teeth, 30° hue-shifted, fast pulse —
      // readable in any palette (shape + pulse + shifted hue)
      float tooth = abs(fract(f * 42.0) - 0.5) * 2.0;
      float spikeHalf = 0.30 + 0.90 * tooth;
      float sm = haz * (1.0 - smoothstep(spikeHalf - 0.08, spikeHalf + 0.08, abs(rr))) * fade;
      float pulse = 0.55 + 0.45 * sin(uTime * 9.0 + f * 30.0);
      vec3 hc = hueRotate(lut(0.60), 0.5236) * (1.0 + 0.9 * pulse);
      hc += vec3(1.0, 0.9, 0.9) * pow(1.0 - clamp(abs(rr) / max(spikeHalf, 1e-3), 0.0, 1.0), 3.0) * 0.55 * pulse;
      col = col * (1.0 - sm * 0.85) + hc * sm;
      alpha = max(alpha, sm);
    }
  }

  // prisma motes: glowing seeds, static in mirror space
  for (int j = 0; j < ${MAX_MOTES}; j++) {
    vec4 M = uMotes[j];
    if (M.z < 0.5) continue;
    float df = min(abs(vUV.y - M.y), min(vUV.y + M.y, 2.0 - vUV.y - M.y));
    float dx = df * uWedge * max(sN, 0.05); // arc length in sN units
    float dy = sN - M.x;
    float d2 = dx * dx + dy * dy;
    float tw = 0.75 + 0.25 * sin(uTime * 3.0 + M.w * 17.0);
    float core = exp(-d2 * 18000.0);
    float halo = exp(-d2 * 1600.0) * 0.35;
    vec3 mc = (lut(0.95) * 0.9 + vec3(0.5)) * core + lut(0.8) * halo;
    col += mc * tw;
    alpha = max(alpha, min(1.0, (core + halo) * tw));
  }

  finalColor = vec4(col, alpha);
}
`;

const MIRROR_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uWedgeTex;
uniform sampler2D uBgTex;
uniform float uWedgeOld;
uniform float uWedgeNew;
uniform float uMirrorMix;
uniform float uViewRot;

${GLSL_FOLD}

vec4 sampleWedge(float rN, float th, float w) {
  float a = fold(th, w) / w;
  a = clamp(a, 0.002, 0.998); // avoid seam bleed across the mirror line
  return texture(uWedgeTex, vec2(rN, a));
}

void main() {
  vec2 p = vUV * 2.0 - 1.0;
  float rN = length(p);
  float th = atan(p.y, p.x) - uViewRot;
  vec4 w = sampleWedge(rN, th, uWedgeOld);
  if (uMirrorMix > 0.001) {
    w = mix(w, sampleWedge(rN, th, uWedgeNew), uMirrorMix);
  }
  vec3 bg = texture(uBgTex, vUV).rgb;
  // wedge output is premultiplied-ish: composite over the background
  finalColor = vec4(bg * (1.0 - min(w.a, 1.0)) + w.rgb, 1.0);
}
`;

export class WedgePass {
  rt: RenderTexture;
  private mesh: Mesh<Geometry, Shader>;
  private ringData = new Float32Array(MAX_RINGS * 4);
  private arcData = new Float32Array(MAX_RINGS * ARC_SLOTS * 4);
  private moteData = new Float32Array(MAX_MOTES * 4);

  constructor(size: number, texA: Texture, lut: Texture) {
    this.rt = RenderTexture.create({ width: size, height: size });
    this.mesh = quadMesh(
      WEDGE_FRAG,
      {
        wedgeUniforms: {
          uRings: { value: this.ringData, type: 'vec4<f32>', size: MAX_RINGS },
          uArcs: { value: this.arcData, type: 'vec4<f32>', size: MAX_RINGS * ARC_SLOTS },
          uMotes: { value: this.moteData, type: 'vec4<f32>', size: MAX_MOTES },
          uWedge: { value: Math.PI / 4, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uBeat: { value: 0, type: 'f32' },
          uTexMix: { value: 0, type: 'f32' },
        },
        uTexA: texA.source,
        uTexA2: texA.source,
        uLut: lut.source,
      },
      'vortika-wedge'
    );
  }

  setTextures(current: Texture, next: Texture): void {
    this.mesh.shader!.resources.uTexA = current.source;
    this.mesh.shader!.resources.uTexA2 = next.source;
  }

  /**
   * Pack the visible ring window into uniform arrays.
   * mapDepth converts a world depth (world units) to normalized screen radius.
   */
  updateWorld(
    field: RingField,
    centerK: number,
    mapDepth: (d: number) => number,
    wedge: number,
    time: number,
    beat: number,
    texMix: number
  ): void {
    const rings = this.ringData;
    const arcs = this.arcData;
    const motes = this.moteData;
    rings.fill(0);
    arcs.fill(0);
    motes.fill(0);
    let moteSlot = 0;
    const S = TUNING.RING_SPACING;

    for (let i = 0; i < MAX_RINGS; i++) {
      const k = centerK - TUNING.RING_WINDOW + i;
      const ring = field.rings.get(k);
      if (!ring) continue;
      const sInner = mapDepth(k * S + TUNING.RING_BAND_HALF);
      const sOuter = mapDepth(k * S - TUNING.RING_BAND_HALF);
      if (sOuter <= 0.001) continue;
      const sMid = (sInner + sOuter) * 0.5;
      // fade in near the eye, fade out at the rim
      const fade =
        Math.min(1, Math.max(0, (sMid - 0.02) / 0.1)) *
        Math.min(1, Math.max(0, (0.985 - sMid) / 0.05));
      rings[i * 4] = sInner;
      rings[i * 4 + 1] = sOuter;
      rings[i * 4 + 2] = ring.phi;
      rings[i * 4 + 3] = fade;

      let slot = 0;
      for (const a of ring.arcs) {
        if (slot >= ARC_SLOTS - 1) break;
        const o = (i * ARC_SLOTS + slot) * 4;
        arcs[o] = a.s;
        arcs[o + 1] = a.e;
        arcs[o + 2] = a.hazard ? 2 : 1;
        slot++;
      }
      for (const p of ring.petals) {
        if (slot >= ARC_SLOTS) break;
        const o = (i * ARC_SLOTS + slot) * 4;
        arcs[o] = p.pos - p.halfSpan;
        arcs[o + 1] = p.pos + p.halfSpan;
        arcs[o + 2] = 2;
        slot++;
      }
      for (const m of ring.motes) {
        if (m.taken || moteSlot >= MAX_MOTES) continue;
        const o = moteSlot * 4;
        motes[o] = mapDepth((k + 0.55) * S);
        motes[o + 1] = m.frac;
        motes[o + 2] = 1;
        motes[o + 3] = k * 7 + moteSlot;
        moteSlot++;
      }
    }

    const u = this.mesh.shader!.resources.wedgeUniforms.uniforms;
    u.uWedge = wedge;
    u.uTime = time;
    u.uBeat = beat;
    u.uTexMix = texMix;
  }

  render(renderer: Renderer): void {
    renderer.render({ container: this.mesh, target: this.rt, clear: true });
  }

  resize(size: number): void {
    this.rt.resize(size, size);
  }
}

export class MirrorPass {
  private mesh: Mesh<Geometry, Shader>;

  constructor(wedgeTex: Texture, bgTex: Texture) {
    this.mesh = quadMesh(
      MIRROR_FRAG,
      {
        mirrorUniforms: {
          uWedgeOld: { value: Math.PI / 4, type: 'f32' },
          uWedgeNew: { value: Math.PI / 4, type: 'f32' },
          uMirrorMix: { value: 0, type: 'f32' },
          uViewRot: { value: 0, type: 'f32' },
        },
        uWedgeTex: wedgeTex.source,
        uBgTex: bgTex.source,
      },
      'vortika-mirror'
    );
  }

  setSources(wedgeTex: Texture, bgTex: Texture): void {
    this.mesh.shader!.resources.uWedgeTex = wedgeTex.source;
    this.mesh.shader!.resources.uBgTex = bgTex.source;
  }

  render(
    renderer: Renderer,
    target: RenderTexture,
    wedgeOld: number,
    wedgeNew: number,
    mirrorMix: number,
    viewRot: number
  ): void {
    const u = this.mesh.shader!.resources.mirrorUniforms.uniforms;
    u.uWedgeOld = wedgeOld;
    u.uWedgeNew = wedgeNew;
    u.uMirrorMix = mirrorMix;
    u.uViewRot = viewRot;
    renderer.render({ container: this.mesh, target, clear: true });
  }
}
