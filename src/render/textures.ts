import { Assets, RenderTexture, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { TEX_IDS, type PhaseId } from '../game/phases';
import { quadMesh } from './gfx';

// Placeholder tints per source pair. Shaders read these textures mostly for
// luminance/structure — actual color always comes from the live palette LUT —
// so the tints only need to give each pair a distinct character.
const TINTS: Record<PhaseId, { deep: [number, number, number]; mid: [number, number, number] }> = {
  GLACIA: { deep: [0.04, 0.08, 0.25], mid: [0.5, 0.85, 0.95] },
  NEBULA: { deep: [0.14, 0.1, 0.32], mid: [0.75, 0.4, 0.85] },
  INFERNA: { deep: [0.13, 0.0, 0.02], mid: [0.9, 0.45, 0.2] },
  VERDANT: { deep: [0.01, 0.17, 0.17], mid: [0.5, 0.85, 0.35] },
};

/**
 * Texture placeholder system (§9).
 *
 * Final organic textures are dropped into public/textures/ and listed in
 * public/textures/manifest.json. Anything missing at runtime is replaced by
 * a procedural, seamlessly-tileable FBM flow-noise texture tinted with the
 * phase's mid-palette. Shaders only ever sample through getPhaseTextures(),
 * so swapping in real JPG/WebP files requires zero code changes.
 */

export interface PhaseTextures {
  sourceA: Texture;
  sourceB: Texture;
}

type Manifest = Record<string, { a: string; b: string }>;

const registry = new Map<PhaseId, PhaseTextures>();

/** wrapped-lattice value-noise FBM → tileable by construction */
const PLACEHOLDER_FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform vec3 uTintA;
uniform vec3 uTintB;
uniform float uSeed;

float hash(vec2 p, float period) {
  p = mod(p, period);
  return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 17.31) * 43758.5453);
}
float vnoise(vec2 uv, float freq) {
  vec2 i = floor(uv * freq);
  vec2 f = fract(uv * freq);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i, freq);
  float b = hash(i + vec2(1.0, 0.0), freq);
  float c = hash(i + vec2(0.0, 1.0), freq);
  float d = hash(i + vec2(1.0, 1.0), freq);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 uv) {
  float v = 0.0;
  float amp = 0.5;
  float freq = 4.0;
  for (int o = 0; o < 5; o++) {
    v += vnoise(uv, freq) * amp;
    uv += 11.31; // decorrelate octaves; mod-lattice keeps it tileable
    amp *= 0.55;
    freq *= 2.0;
  }
  return v;
}
void main() {
  // domain-warped fbm for an inky, flowing look
  float w1 = fbm(vUV + vec2(0.0, 0.31));
  float w2 = fbm(vUV + vec2(0.47, 0.0));
  float n = fbm(vUV + 0.35 * vec2(w1, w2));
  float veins = smoothstep(0.35, 0.75, n);
  vec3 col = mix(uTintA * 0.45, uTintB, veins);
  col += pow(smoothstep(0.6, 0.95, n), 3.0) * 0.35; // bright plasma filaments
  finalColor = vec4(col, 1.0);
}
`;

function makePlaceholder(renderer: Renderer, phaseId: PhaseId, slot: 'a' | 'b'): Texture {
  const mid = TINTS[phaseId].mid;
  const deep = TINTS[phaseId].deep;
  const seed = phaseId.charCodeAt(0) * 0.13 + (slot === 'a' ? 1.7 : 9.2);
  const mesh = quadMesh(
    PLACEHOLDER_FRAG,
    {
      placeholderUniforms: {
        uTintA: { value: new Float32Array(deep), type: 'vec3<f32>' },
        uTintB: { value: new Float32Array(mid), type: 'vec3<f32>' },
        uSeed: { value: seed, type: 'f32' },
      },
    },
    `placeholder-${phaseId}-${slot}`
  );
  const rt = RenderTexture.create({ width: 1024, height: 1024 });
  renderer.render({ container: mesh, target: rt, clear: true });
  rt.source.style.addressMode = 'repeat';
  rt.source.style.update();
  mesh.destroy(true);
  console.log(`[textures] placeholder for ${phaseId}_${slot}`);
  return rt;
}

async function loadOrPlaceholder(
  renderer: Renderer,
  phaseId: PhaseId,
  slot: 'a' | 'b',
  file: string | undefined
): Promise<Texture> {
  if (file) {
    try {
      const tex: Texture = await Assets.load(`textures/${file}`);
      tex.source.style.addressMode = 'repeat';
      tex.source.style.update();
      console.log(`[textures] loaded ${phaseId}_${slot}: ${file}`);
      return tex;
    } catch {
      /* fall through to placeholder */
    }
  }
  return makePlaceholder(renderer, phaseId, slot);
}

export async function initTextures(renderer: Renderer): Promise<void> {
  let manifest: Manifest = {};
  try {
    const res = await fetch('textures/manifest.json');
    if (res.ok) manifest = await res.json();
  } catch {
    console.log('[textures] no manifest found; using placeholders for all phases');
  }
  await Promise.all(
    TEX_IDS.map(async (id) => {
      const entry = manifest[id];
      const [a, b] = await Promise.all([
        loadOrPlaceholder(renderer, id, 'a', entry?.a),
        loadOrPlaceholder(renderer, id, 'b', entry?.b),
      ]);
      registry.set(id, { sourceA: a, sourceB: b });
    })
  );
}

export function getPhaseTextures(phaseId: PhaseId): PhaseTextures {
  const t = registry.get(phaseId);
  if (!t) throw new Error(`textures not initialized for ${phaseId}`);
  return t;
}
