// Black-hole visual. A camera-facing quad whose fragment shader traces each light ray backwards
// through Schwarzschild spacetime (non-rotating hole) and reports what it hits: the horizon,
// the accretion disk, or the already-rendered scene behind.
//
// What is and is not physical:
//  - Ray paths: integrated from the exact photon orbit equation u'' + u = (3/2) rs u^2,
//    written in Cartesian form as  a = -(3/2) h^2 x / r^5  with rs = 1, h = |x cross v|.
//    This produces the shadow, the photon ring and the disk's far side arching over the top.
//  - Bending is faded out towards the edge of the traced region so the quad blends into the
//    normal render. Far-field deflection is therefore weaker than real.
//  - Disk: purely artistic emission (bands, brightness falloff, a Doppler-like brightening of
//    the approaching side). No redshift, no radiative transfer, no physical temperature.
//  - Background: looked up in a render of the scene at one assumed distance behind the hole,
//    so lensed images of bodies and stars are approximate. Bodies in front are left unlensed.
//  - Dynamics are untouched: bodies still move under Newtonian gravity, and the horizon
//    radius is the body's `radius`, not derived from its mass (the sim has no speed of light).
import * as THREE from 'three';

const R0 = 15; // traced region radius, in horizon radii

export function blackHoleQuad(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    transparent: true, // sorts it after trails and glows; blending itself is off
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tBg: { value: null },
      tDepth: { value: null },
      uFwd: { value: new THREE.Vector3() }, // camera forward, world space
      uNear: { value: 0.1 },
      uFar: { value: 1 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uCam: { value: new THREE.Vector3() }, // camera position relative to the hole, in horizon radii
      uHole: { value: new THREE.Vector3() },
      uRs: { value: 1 },
      uViewProj: { value: new THREE.Matrix4() },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tBg, tDepth;
      uniform vec2 uRes;
      uniform vec3 uCam, uHole, uFwd;
      uniform float uRs, uTime, uNear, uFar;
      uniform mat4 uViewProj;
      varying vec3 vWorld;

      const float RIN = 2.6, ROUT = 9.0, R0 = ${R0.toFixed(1)}, SRC = 40.0;
      const int STEPS = 150;

      float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
      float noise1(float x) {
        float i = floor(x), f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(hash(i), hash(i + 1.0), f);
      }

      // Artistic emission at point p in the disk plane (y = 0), seen along ray direction v.
      vec4 disk(vec3 p, vec3 v) {
        float rho = length(p.xz), t = (rho - RIN) / (ROUT - RIN), ang = atan(p.z, p.x);
        float streak = noise1(rho * 6.0 + 1.2 * sin(ang * 3.0 + 9.0 / sqrt(rho) - uTime * 0.5));
        float fine = noise1(rho * 23.0 + 0.6 * sin(ang * 5.0 - uTime * 0.8 + rho));
        float I = (0.35 + 0.65 * streak) * (0.6 + 0.4 * fine) * pow(1.0 - t, 1.5);
        vec3 orbit = vec3(-sin(ang), 0.0, cos(ang));
        I *= pow(1.0 + 0.35 * dot(orbit, -normalize(v)), 2.0); // approaching side brighter
        vec3 col = mix(vec3(0.85, 0.1, 0.02), vec3(1.0, 0.45, 0.08), smoothstep(0.05, 0.6, I));
        col = mix(col, vec3(1.0, 0.8, 0.5), smoothstep(0.8, 1.6, I));
        float a = smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.7, t) * clamp(I * 2.0, 0.0, 1.0);
        return vec4(col * min(I * 1.5, 1.3), a);
      }

      // Distance from the camera, in horizon radii, to whatever the scene pass drew at uv,
      // measured along a ray with world direction dir.
      float sceneDist(vec2 uv, vec3 dir) {
        float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
        float viewZ = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
        return viewZ / max(dot(dir, uFwd), 1e-3) / uRs;
      }

      // xy = screen uv, z = 1 if it lands on screen in front of the camera
      vec3 project(vec4 p) {
        vec4 c = uViewProj * p;
        vec2 uv = c.xy / c.w * 0.5 + 0.5;
        return vec3(uv, float(c.w > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0));
      }

      void main() {
        vec2 suv = gl_FragCoord.xy / uRes;
        vec3 straight = texture2D(tBg, suv).rgb;
        vec3 x = uCam, rd = normalize((vWorld - uHole) / uRs - uCam);

        // something nearer than the hole sits on this ray: it is in front, so it is not lensed
        if (sceneDist(suv, rd) < -dot(uCam, rd)) { gl_FragColor = vec4(straight, 1.0); return; }

        // skip empty space: start on the traced sphere if the camera is outside it
        float path = 0.0; // distance travelled from the camera
        float b = dot(x, rd), c = dot(x, x) - R0 * R0;
        if (c > 0.0) {
          float disc = b * b - c;
          if (disc < 0.0 || b > 0.0) { gl_FragColor = vec4(straight, 1.0); return; }
          path = -b - sqrt(disc);
          x += rd * path;
        }

        vec3 v = rd, hv = cross(x, v);
        float h2 = dot(hv, hv); // squared impact parameter; conserved along the ray
        vec3 col = vec3(0.0);
        float alpha = 0.0;
        bool captured = false;

        for (int i = 0; i < STEPS; i++) {
          float r2 = dot(x, x);
          if (r2 < 1.0) { captured = true; break; }
          if (r2 > R0 * R0 * 1.02 && dot(x, v) > 0.0) break;
          float dt = 0.06 * sqrt(r2); // finer steps where the bending is strong
          v += -1.5 * h2 * x / (r2 * r2 * sqrt(r2)) * dt;
          vec3 xn = x + v * dt;
          if (x.y * xn.y < 0.0) { // crossed the disk plane
            vec3 p = mix(x, xn, x.y / (x.y - xn.y));
            float rho = length(p.xz);
            if (rho > RIN && rho < ROUT) {
              vec4 d = disk(p, v);
              col += (1.0 - alpha) * d.rgb * d.a;
              alpha += (1.0 - alpha) * d.a;
            }
          }
          path += length(v) * dt;
          x = xn;
        }

        vec3 bg = vec3(0.0);
        if (!captured) {
          // fade the bending out towards the edge of the traced region so there is no visible seam
          float w = smoothstep(R0, 0.6 * R0, sqrt(h2));
          // Look up the rendered scene where the bent ray is SRC radii past its exit point.
          // One assumed source distance keeps the mapping continuous (no torn or erased
          // objects); it is right for bodies orbiting near the hole and slightly off for the
          // star field, where nobody can tell.
          vec3 P = mix(uCam + rd * (path + SRC), x + normalize(v) * SRC, w);
          vec3 uv = project(vec4(uHole + P * uRs, 1.0));
          if (uv.z > 0.5) bg = texture2D(tBg, uv.xy).rgb;
        }
        gl_FragColor = vec4(col + (1.0 - alpha) * bg, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.renderOrder = 999;
  quad.frustumCulled = false;
  quad.visible = false;
  return quad;
}

/** Quad half-size in world units for a horizon radius rs: slightly larger than the traced sphere. */
export const quadSize = (rs: number): number => rs * R0 * 1.1;
