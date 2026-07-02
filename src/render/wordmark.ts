import { Geometry, Mesh, Shader, Texture } from 'pixi.js';
import { GLSL_FOLD, es300 } from './gfx';

/**
 * Title wordmark FX: the word begins as a kaleidoscope mandala literally
 * made of its own letters — folded through mirror wedges with a spiral
 * twist — and unwinds over ~2.6s into the readable wordmark. Once formed
 * it keeps breathing: a subtle re-fold on the beat and a slow shimmer.
 * Rendered additively in the game's pipeline so it always wears the
 * current palette. The DOM wordmark keeps its layout slot but is invisible.
 */

const VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vUV;
uniform vec2 uCenter; // clip space
uniform vec2 uHalf;   // clip half extents
void main() {
  // y-down texture space over the quad
  vUV = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(uCenter + aPosition * uHalf, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uText;
uniform vec3 uTint;
uniform float uForm;   // 0 = fully folded mandala, 1 = readable word
uniform float uTime;
uniform float uAspect; // quad pixel aspect (w/h)

${GLSL_FOLD}

void main() {
  vec2 p = (vUV - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  float th = atan(p.y, p.x);
  float k = 1.0 - uForm;

  // unwinding spiral swirl (strong while folded, gone when formed)
  th += k * k * (7.0 * r + uTime * 0.5);

  // kaleidoscope fold that releases as the word forms
  float w = 6.2831853 / 10.0;
  float thF = fold(th, w);
  float release = smoothstep(0.5, 0.95, uForm);
  th = mix(thF, th, release);

  // the mandala starts tighter and blooms outward to full size
  float rr = r / mix(0.45, 1.0, smoothstep(0.0, 0.85, uForm));
  vec2 q = vec2(cos(th), sin(th)) * rr;
  vec2 uv = q / vec2(uAspect, 1.0) + 0.5;

  // chromatic fringe, strong while folded, a whisper when formed
  float ca = k * 0.014 + 0.0018;
  vec2 dir = r > 1e-4 ? (q / max(r, 1e-4)) / vec2(uAspect, 1.0) : vec2(0.0);
  float aR = texture(uText, uv + dir * ca).a;
  float aG = texture(uText, uv).a;
  float aB = texture(uText, uv - dir * ca).a;

  // white-hot core with palette-tinted edges + slow radial shimmer
  vec3 col = vec3(aR, aG, aB) * (uTint * 0.85 + 0.75);
  col *= 0.9 + 0.12 * sin(uTime * 1.7 + r * 9.0);
  col *= 0.35 + 0.65 * smoothstep(0.0, 0.25, uForm); // fade in from nothing
  float alpha = max(aR, max(aG, aB));
  finalColor = vec4(col * min(alpha * 2.2, 1.6), 0.0); // additive, bright
}
`;

function makeTextCanvas(text: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 384;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const spacing = 28;
  ctx.font = '300 150px Georgia, "Times New Roman", serif';
  const cs = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in ctx) cs.letterSpacing = `${spacing}px`;
  // soft glow pass, then crisp core
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 26;
  ctx.fillText(text, canvas.width / 2 + spacing / 2, canvas.height / 2);
  ctx.shadowBlur = 8;
  ctx.fillText(text, canvas.width / 2 + spacing / 2, canvas.height / 2);
  return canvas;
}

export class WordmarkFX {
  mesh: Mesh<Geometry, Shader>;
  readonly tint = new Float32Array([0.6, 0.9, 1.0]);
  /** how much larger the effect quad is than the text box (fold spillover) */
  private readonly expand = 1.9;
  private form = 0;

  constructor(text: string) {
    const texture = Texture.from(makeTextCanvas(text));
    texture.source.style.addressMode = 'clamp-to-edge';
    const geometry = new Geometry({
      attributes: {
        aPosition: {
          buffer: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
          format: 'float32x2',
        },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex: es300(VERT), fragment: es300(FRAG), name: 'bloom-wordmark' },
      resources: {
        wordmarkUniforms: {
          uCenter: { value: new Float32Array(2), type: 'vec2<f32>' },
          uHalf: { value: new Float32Array(2), type: 'vec2<f32>' },
          uTint: { value: this.tint, type: 'vec3<f32>' },
          uForm: { value: 0, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uAspect: { value: 1024 / 384, type: 'f32' },
        },
        uText: texture.source,
      },
    });
    this.mesh = new Mesh({ geometry, shader });
    this.mesh.blendMode = 'add';
  }

  restart(): void {
    this.form = 0;
  }

  /**
   * rect: the DOM wordmark's box in CSS px; screenW/H: viewport CSS px.
   * Call each frame the title is visible, then render the mesh to screen.
   */
  update(
    dt: number,
    time: number,
    beat: number,
    rect: { left: number; top: number; width: number; height: number },
    screenW: number,
    screenH: number
  ): void {
    this.form = Math.min(1, this.form + dt / 2.6);
    // formed: breathe gently and re-fold a touch on the beat
    const breathe = 0.05 * (0.5 + 0.5 * Math.sin(time * 0.9)) + 0.1 * beat;
    const eff = Math.max(0, Math.min(1, this.form - (this.form >= 1 ? breathe : 0)));

    const u = this.mesh.shader!.resources.wordmarkUniforms.uniforms;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const halfWpx = (rect.width * this.expand) / 2;
    const halfHpx = Math.max(rect.height, rect.width * 0.375) * this.expand * 0.5;
    (u.uCenter as Float32Array)[0] = (cx / screenW) * 2 - 1;
    (u.uCenter as Float32Array)[1] = 1 - (cy / screenH) * 2;
    (u.uHalf as Float32Array)[0] = (halfWpx * 2) / screenW;
    (u.uHalf as Float32Array)[1] = (halfHpx * 2) / screenH;
    u.uForm = eff;
    u.uTime = time;
    u.uAspect = halfWpx / halfHpx;
  }
}
