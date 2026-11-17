// Procedural surface maps drawn to a canvas: no image assets, nothing to license.
import * as THREE from 'three';
import type { BodyType } from './physics/engine';

function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(seed, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = ease(x - xi), v = ease(y - yi), w = ease(z - zi);
  const h = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz, seed);
  return lerp(
    lerp(lerp(h(0, 0, 0), h(1, 0, 0), u), lerp(h(0, 1, 0), h(1, 1, 0), u), v),
    lerp(lerp(h(0, 0, 1), h(1, 0, 1), u), lerp(h(0, 1, 1), h(1, 1, 1), u), v),
    w,
  );
}

/** Fractal noise in [0, 1], 4 octaves. */
function fbm(x: number, y: number, z: number, seed: number): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 4; o++, f *= 2, amp *= 0.5) sum += amp * noise3(x * f, y * f, z * f, seed);
  return sum / 0.9375;
}

const cache = new Map<string, THREE.Texture | null>();

/** Equirectangular map for a body type tinted with its colour, or null for bodies too small to need one. */
export function bodyTexture(type: BodyType, color: string): THREE.Texture | null {
  if (type === 'asteroid' || type === 'comet' || type === 'black hole') return null;
  const key = `${type}|${color}`;
  if (cache.has(key)) return cache.get(key)!; // shared per type+colour, so the texture count stays bounded

  const W = 256, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const rgb = parseInt(color.slice(1), 16);
  const base = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
  const seed = [...key].reduce((s, c) => Math.imul(s, 31) + c.charCodeAt(0), 7);

  for (let py = 0; py < H; py++) {
    const polar = ((py + 0.5) / H) * Math.PI, y = Math.cos(polar), ring = Math.sin(polar);
    for (let px = 0; px < W; px++) {
      // sample noise on the sphere itself, so the map wraps without a seam
      const lon = (px / W) * 2 * Math.PI, x = ring * Math.cos(lon), z = ring * Math.sin(lon);
      let k: [number, number, number];
      if (type === 'star') {
        const n = 0.7 + 0.6 * fbm(x * 7, y * 7, z * 7, seed); // granulation: cooler cells go redder
        k = [Math.min(1, n + 0.2), n, n * n];
      } else if (type === 'gas giant') {
        const n = 0.72 + 0.38 * (0.5 + 0.5 * Math.sin(y * 16 + fbm(x * 1.5, y * 1.5, z * 1.5, seed) * 5)); // turbulent bands
        k = [n, n, n];
      } else {
        const n = type === 'moon' ? 0.5 + 0.9 * fbm(x * 5, y * 5, z * 5, seed) : 0.45 + 1.1 * fbm(x * 2.2, y * 2.2, z * 2.2, seed);
        k = [n, n, n];
      }
      const i = (py * W + px) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.min(255, base[c] * k[c]);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/** Rim-glow shell. `scale` is the shell radius relative to the planet; glow is 0 at the shell edge, 1 at the limb. */
export function atmosphere(color: string, scale: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(color).lerp(new THREE.Color('#9fd0ff'), 0.6) }, uLimb: { value: Math.sqrt(1 - 1 / (scale * scale)) } },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uLimb;
        varying vec3 vNormal;
        void main() {
          float g = clamp(-normalize(vNormal).z / uLimb, 0.0, 1.0);
          gl_FragColor = vec4(uColor * g * g * 0.7, 1.0);
        }`,
    }),
  );
  mesh.scale.setScalar(scale);
  return mesh;
}
