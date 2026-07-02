import { Geometry, Mesh, Shader } from 'pixi.js';

/**
 * Shared helpers for the custom render pipeline. All world passes are
 * fullscreen-triangle meshes with clip-space vertex shaders; pixi's scene
 * transforms are bypassed entirely (we render meshes directly per pass).
 *
 * Conventions: clip space +y = up. World angle θ is standard math CCW.
 * A point at (sN, θ) maps to clip (sN·cosθ, sN·sinθ) in the square target.
 */

/**
 * Pixi v8 keys its WebGL2 path off the source containing `#version 300 es`
 * (it strips and re-inserts it at the top). Every shader goes through this.
 */
export function es300(src: string): string {
  return `#version 300 es\n${src}`;
}

export const QUAD_VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vUV;
void main() {
  vUV = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** GLSL kaleidoscope fold — must match foldAngle() in rings.ts */
export const GLSL_FOLD = /* glsl */ `
float fold(float x, float w) {
  float p = 2.0 * w;
  float t = mod(x, p);
  return t > w ? p - t : t;
}
`;

export const GLSL_HUE_ROTATE = /* glsl */ `
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}
`;

/** One fullscreen triangle (covers clip space, no index buffer needed). */
export function fullscreenGeometry(): Geometry {
  return new Geometry({
    attributes: {
      aPosition: {
        buffer: new Float32Array([-1, -1, 3, -1, -1, 3]),
        format: 'float32x2',
      },
    },
  });
}

export function quadMesh(
  fragment: string,
  resources: Record<string, unknown>,
  name: string
): Mesh<Geometry, Shader> {
  const shader = Shader.from({
    gl: { vertex: es300(QUAD_VERT), fragment: es300(fragment), name },
    resources,
  });
  return new Mesh({ geometry: fullscreenGeometry(), shader });
}
