// Eclipse shadows for planets, gas giants and moons.
//
// Shadow maps would need six extra renders per star per frame and still could not resolve a
// 0.25-radius moon 70 units from its star. Every caster and every light here is a sphere, so the
// fragment shader instead computes, for each light, what fraction of the light's disk the nearby
// spheres cover as seen from that point. The light's true angular size gives the umbra and the
// penumbra their correct widths. Limits: at most MAX_LIGHTS lights and the MAX_OCC
// apparently-largest occluders per receiving body; asteroids and comets receive no eclipses.
import * as THREE from 'three';
import type { Body } from './physics/engine';

export const MAX_LIGHTS = 4, MAX_OCC = 8;

export const isLight = (b: Body): boolean => b.type === 'star' || b.type === 'black hole';

/** Emitting radius, colour and intensity, matching the PointLights the scene also carries. */
function lightOf(b: Body): { radius: number; color: THREE.ColorRepresentation; intensity: number } {
  return b.type === 'black hole'
    ? { radius: b.radius * 6, color: 0xff8a3c, intensity: 1.6 } // the accretion disk, approximated as a sphere
    : { radius: b.radius, color: b.color, intensity: 2.5 };
}

/**
 * Writes into `out` the up-to-MAX_OCC bodies (other than `self`) that look largest from `self`,
 * largest first. Stars are included: one star can eclipse another. Returns the count.
 */
export function pickOccluders(self: Body, bodies: Body[], out: Body[]): number {
  const score: number[] = [];
  let n = 0;
  for (const b of bodies) {
    if (b === self) continue;
    const d = Math.hypot(b.pos[0] - self.pos[0], b.pos[1] - self.pos[1], b.pos[2] - self.pos[2]);
    const s = b.radius / Math.max(d - self.radius, 1e-6); // apparent size from the near surface
    if (n === MAX_OCC && s <= score[n - 1]) continue;
    let i = Math.min(n, MAX_OCC - 1);
    while (i > 0 && score[i - 1] < s) { // insertion into a short sorted list: no per-frame allocation churn
      score[i] = score[i - 1];
      out[i] = out[i - 1];
      i--;
    }
    score[i] = s;
    out[i] = b;
    if (n < MAX_OCC) n++;
  }
  return n;
}

export function eclipseMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      uLights: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
      uLightColors: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Color()) },
      uNumLights: { value: 0 },
      uOcc: { value: Array.from({ length: MAX_OCC }, () => new THREE.Vector4()) },
      uNumOcc: { value: 0 },
      uAmbient: { value: new THREE.Color(1, 1, 1).multiplyScalar(0.25 / Math.PI) }, // the scene's 0.25 ambient
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld, vNormal;
      varying vec2 vUv;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal); // uniform scale, so no inverse-transpose needed
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      #define MAX_LIGHTS ${MAX_LIGHTS}
      #define MAX_OCC ${MAX_OCC}
      uniform sampler2D map;
      uniform vec4 uLights[MAX_LIGHTS], uOcc[MAX_OCC]; // xyz world position, w radius
      uniform vec3 uLightColors[MAX_LIGHTS], uAmbient;
      uniform int uNumLights, uNumOcc;
      varying vec3 vWorld, vNormal;
      varying vec2 vUv;

      // Fraction of a disk of angular radius a covered by a disk of angular radius b whose centre
      // is d away. Exact at both ends (no contact, full containment); smooth in between.
      float covered(float a, float b, float d) {
        if (d >= a + b) return 0.0;
        float full = min(1.0, (b * b) / (a * a));
        if (d <= abs(a - b)) return full;
        return full * (1.0 - smoothstep(abs(a - b), a + b, d));
      }

      float visibility(vec4 light) {
        vec3 toL = light.xyz - vWorld;
        float dl = length(toL);
        float a = asin(min(1.0, light.w / dl));
        float vis = 1.0;
        for (int j = 0; j < MAX_OCC; j++) {
          if (j >= uNumOcc) break;
          vec3 toO = uOcc[j].xyz - vWorld;
          float d0 = length(toO);
          // skip the light itself, anything not between us and the light, and anything we are inside
          if (distance(uOcc[j].xyz, light.xyz) < 1e-4 || d0 >= dl || d0 <= uOcc[j].w || dot(toO, toL) <= 0.0) continue;
          float b = asin(min(1.0, uOcc[j].w / d0));
          float d = acos(clamp(dot(toO / d0, toL / dl), -1.0, 1.0));
          vis *= 1.0 - covered(a, b, d);
        }
        return vis;
      }

      void main() {
        vec3 n = normalize(vNormal), lit = uAmbient;
        for (int i = 0; i < MAX_LIGHTS; i++) {
          if (i >= uNumLights) break;
          float ndl = dot(n, normalize(uLights[i].xyz - vWorld));
          if (ndl > 0.0) lit += uLightColors[i] * ndl * visibility(uLights[i]);
        }
        gl_FragColor = vec4(texture2D(map, vUv).rgb * lit, 1.0);
      }`,
  });
}

const occ: Body[] = [];

/** Per-frame uniform update for one receiving body. `lights` is every light-emitting body. */
export function updateEclipse(mat: THREE.ShaderMaterial, self: Body, bodies: Body[], lights: Body[]): void {
  const u = mat.uniforms;
  const nl = Math.min(lights.length, MAX_LIGHTS);
  for (let i = 0; i < nl; i++) {
    const L = lights[i], l = lightOf(L);
    u.uLights.value[i].set(L.pos[0], L.pos[1], L.pos[2], l.radius);
    u.uLightColors.value[i].set(l.color).multiplyScalar(l.intensity / Math.PI); // same scale as three's Lambert
  }
  u.uNumLights.value = nl;
  const no = pickOccluders(self, bodies, occ);
  for (let j = 0; j < no; j++) {
    const b = occ[j];
    u.uOcc.value[j].set(b.pos[0], b.pos[1], b.pos[2], b.radius);
  }
  u.uNumOcc.value = no;
}
