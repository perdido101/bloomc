import { Geometry, Mesh, Shader } from 'pixi.js';
import { TUNING } from '../game/difficulty';
import { es300 } from './gfx';

/**
 * Fixed-capacity additive particle pool (cap 600, §10). One geometry, one
 * draw call; all state lives in pre-allocated typed arrays — the update
 * loop performs zero allocations. Positions are in clip space of the square
 * world target. Dead particles collapse their quad to a point.
 */

const MAX = TUNING.PARTICLE_CAP;

const VERT = /* glsl */ `
in vec2 aPosition;
in vec4 aColor;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision mediump float;
in vec4 vColor;
out vec4 finalColor;
void main() {
  finalColor = vec4(vColor.rgb * vColor.a, 0.0);
}
`;

export class Particles {
  mesh: Mesh<Geometry, Shader>;
  private pos: Float32Array;
  private col: Float32Array;
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private cr = new Float32Array(MAX);
  private cg = new Float32Array(MAX);
  private cb = new Float32Array(MAX);
  private attract = new Float32Array(MAX);
  private cursor = 0;

  constructor() {
    this.pos = new Float32Array(MAX * 8);
    this.col = new Float32Array(MAX * 16);
    const idx = new Uint32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const geom = new Geometry({
      attributes: {
        aPosition: { buffer: this.pos, format: 'float32x2' },
        aColor: { buffer: this.col, format: 'float32x4' },
      },
      indexBuffer: idx,
    });
    const shader = Shader.from({
      gl: { vertex: es300(VERT), fragment: es300(FRAG), name: 'vortika-particles' },
      resources: {},
    });
    this.mesh = new Mesh({ geometry: geom, shader });
    this.mesh.blendMode = 'add';
  }

  spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    r: number,
    g: number,
    b: number,
    attract = 0
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.cr[i] = r;
    this.cg[i] = g;
    this.cb[i] = b;
    this.attract[i] = attract;
  }

  burst(
    x: number,
    y: number,
    n: number,
    speed: number,
    life: number,
    size: number,
    r: number,
    g: number,
    b: number,
    attract = 0
  ): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.35 + Math.random() * 0.65);
      this.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * (0.6 + Math.random() * 0.4), size, r, g, b, attract);
    }
  }

  clear(): void {
    this.life.fill(0);
  }

  update(dt: number): void {
    const pos = this.pos;
    const col = this.col;
    for (let i = 0; i < MAX; i++) {
      const o = i * 8;
      if (this.life[i] <= 0) {
        pos[o] = pos[o + 2] = pos[o + 4] = pos[o + 6] = 0;
        pos[o + 1] = pos[o + 3] = pos[o + 5] = pos[o + 7] = 0;
        continue;
      }
      this.life[i] -= dt;
      let x = this.px[i];
      let y = this.py[i];
      if (this.attract[i] > 0) {
        // absorbed into the mandala: accelerate toward the eye
        this.vx[i] -= x * this.attract[i] * dt;
        this.vy[i] -= y * this.attract[i] * dt;
      }
      this.vx[i] *= 1 - 1.6 * dt;
      this.vy[i] *= 1 - 1.6 * dt;
      x += this.vx[i] * dt;
      y += this.vy[i] * dt;
      this.px[i] = x;
      this.py[i] = y;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      const s = this.size[i] * (0.4 + 0.6 * t);
      pos[o] = x - s;
      pos[o + 1] = y - s;
      pos[o + 2] = x + s;
      pos[o + 3] = y - s;
      pos[o + 4] = x + s;
      pos[o + 5] = y + s;
      pos[o + 6] = x - s;
      pos[o + 7] = y + s;
      const a = t * t;
      const co = i * 16;
      for (let v = 0; v < 4; v++) {
        col[co + v * 4] = this.cr[i];
        col[co + v * 4 + 1] = this.cg[i];
        col[co + v * 4 + 2] = this.cb[i];
        col[co + v * 4 + 3] = a;
      }
    }
    this.mesh.geometry.getBuffer('aPosition').update();
    this.mesh.geometry.getBuffer('aColor').update();
  }
}
