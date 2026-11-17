import type { Body, BodyType, CollisionMode, Vec3 } from './engine';

// Simulation units: G = 1 by default; mass, length and time are dimensionless.
export const BODY_TYPES: Record<BodyType, { mass: number; radius: number; color: string }> = {
  star: { mass: 1000, radius: 3, color: '#ffd27a' },
  planet: { mass: 1, radius: 0.6, color: '#5b8def' },
  'gas giant': { mass: 10, radius: 1.4, color: '#d9a066' },
  moon: { mass: 0.01, radius: 0.25, color: '#b8b8b8' },
  asteroid: { mass: 1e-4, radius: 0.12, color: '#8a7f72' },
  comet: { mass: 1e-5, radius: 0.1, color: '#aee9ff' },
  // radius doubles as the drawn horizon radius; anything inside it merges (is swallowed)
  'black hole': { mass: 4000, radius: 2.5, color: '#ff7a2a' },
};

let nextId = 1;
export const newId = (): number => nextId++;

export function make(type: BodyType, name: string, pos: Vec3, vel: Vec3, over: Partial<Body> = {}): Body {
  return { id: nextId++, name, type, ...BODY_TYPES[type], pos, vel, ...over };
}

/** Circular orbit of radius r around `parent` in the xz-plane (two-body approximation, G = 1 unless given). */
export function orbiting(
  parent: Body, type: BodyType, name: string, r: number, angle = 0, over: Partial<Body> = {}, G = 1, speedFactor = 1,
): Body {
  const v = Math.sqrt((G * parent.mass) / r) * speedFactor;
  const c = Math.cos(angle), s = Math.sin(angle);
  return make(
    type, name,
    [parent.pos[0] + r * c, parent.pos[1], parent.pos[2] + r * s],
    [parent.vel[0] - v * s, parent.vel[1], parent.vel[2] + v * c],
    over,
  );
}

/** Shift to the centre-of-momentum frame so the system does not drift out of view. */
function zeroMomentum(bodies: Body[]): Body[] {
  const M = bodies.reduce((s, b) => s + b.mass, 0);
  for (let k = 0; k < 3; k++) {
    const vcm = bodies.reduce((s, b) => s + b.mass * b.vel[k], 0) / M;
    for (const b of bodies) b.vel[k] -= vcm;
  }
  return bodies;
}

/** mulberry32: seeded so a preset builds the same system every time (Reset and rewind stay comparable). */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Probe leaves r=28 on a transfer ellipse reaching out to r=80; the giant (r=70) starts at
 * `giantAngle`. The default was found by scanning the angle for the largest energy gain
 * that sits in a broad plateau (see engine.test.ts).
 */
export function slingshot(giantAngle = SLINGSHOT_ANGLE): Body[] {
  const sun = make('star', 'Sol', [0, 0, 0], [0, 0, 0]);
  const hohmann = Math.sqrt((2 * 80) / (28 + 80)); // perihelion speed / circular speed
  return zeroMomentum([
    sun,
    orbiting(sun, 'gas giant', 'Jove', 70, giantAngle, { mass: 30, radius: 1.6 }),
    orbiting(sun, 'asteroid', 'Probe', 28, 0, { mass: 1e-6, radius: 0.1, color: '#ffffff' }, 1, hohmann),
  ]);
}
// Closest approach ~4 (2.5 giant radii); probe specific energy goes from about -9 to +3 (escape).
export const SLINGSHOT_ANGLE = 1.44;

/** Settings for the random-system preset. Mutate, then reload that preset. */
export const generator = { seed: 1, planets: 6, eccentricity: 0.1, inclination: 5, asteroids: 0 };
const ROCK_COLORS = ['#5b8def', '#c98a5e', '#c1553b', '#7fb77e', '#b9a7d6', '#d8c690'];

/**
 * One star, planets on geometrically spaced orbits (rocky inside, mostly giants outside),
 * moons kept well inside each giant's Hill sphere, optional asteroid belt in the middle gap.
 * `eccentricity` is the maximum e (each body starts at pericentre); `inclination` is the
 * maximum tilt in degrees. Deterministic for a given set of options.
 */
export function generateSystem(o = generator): Body[] {
  const rand = rng(o.seed);
  const sun = make('star', 'Star', [0, 0, 0], [0, 0, 0]);
  const bodies = [sun], radii: number[] = [];
  let r = 12 + rand() * 4;

  const place = (type: BodyType, name: string, radius: number, over: Partial<Body> = {}): Body => {
    const e = rand() * o.eccentricity;
    const b = orbiting(sun, type, name, radius, rand() * 2 * Math.PI, over, 1, Math.sqrt(1 + e)); // pericentre speed
    // tilt the orbit about the star-body line: position stays put, velocity gains a y component
    const tilt = ((rand() - 0.5) * 2 * o.inclination * Math.PI) / 180;
    const speed = Math.hypot(b.vel[0], b.vel[2]);
    b.vel = [b.vel[0] * Math.cos(tilt), speed * Math.sin(tilt), b.vel[2] * Math.cos(tilt)];
    return b;
  };

  for (let i = 0; i < o.planets; i++) {
    const giant = i >= o.planets / 2 && rand() < 0.6;
    const p = giant
      ? place('gas giant', `P${i + 1}`, r)
      : place('planet', `P${i + 1}`, r, { mass: 0.2 + rand() * 1.3, radius: 0.4 + rand() * 0.3, color: ROCK_COLORS[Math.floor(rand() * ROCK_COLORS.length)] });
    bodies.push(p);
    radii.push(r);
    if (giant) {
      const hill = r * Math.cbrt(p.mass / (3 * sun.mass)), moons = Math.floor(rand() * 3);
      for (let m = 0; m < moons; m++) {
        const mr = p.radius + 1 + m * 0.9;
        if (mr < 0.4 * hill) bodies.push(orbiting(p, 'moon', `P${i + 1}-${m + 1}`, mr, rand() * 2 * Math.PI));
      }
    }
    r *= 1.35 + rand() * 0.35;
  }

  const k = Math.max(0, Math.floor(o.planets / 2) - 1);
  const inner = radii[k] * 1.12, outer = (radii[k + 1] ?? radii[k] * 1.5) * 0.9;
  // random placement can land two bodies on top of each other; retry a few times, then give up on that one
  const overlaps = (b: Body) => bodies.some((x) => Math.hypot(x.pos[0] - b.pos[0], x.pos[1] - b.pos[1], x.pos[2] - b.pos[2]) < (x.radius + b.radius) * 1.5);
  for (let a = 0; a < o.asteroids && outer > inner; a++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const rock = place('asteroid', `A${a + 1}`, inner + rand() * (outer - inner));
      if (!overlaps(rock)) {
        bodies.push(rock);
        break;
      }
    }
  }
  return zeroMomentum(bodies);
}

export interface Preset {
  name: string;
  dt: number;
  note: string;
  build: () => Body[];
  /** Applied on load; defaults are 0.05 and 'merge'. */
  softening?: number;
  collisions?: CollisionMode;
}

export const PRESETS: Preset[] = [
  {
    name: 'Stable solar system',
    note: 'Near-circular orbits around one dominant mass. The baseline for every comparison.',
    dt: 0.005,
    build: () => {
      const sun = make('star', 'Sol', [0, 0, 0], [0, 0, 0]);
      const giant = orbiting(sun, 'gas giant', 'Jove', 70, 4);
      return zeroMomentum([
        sun,
        orbiting(sun, 'planet', 'Ember', 15, 0, { color: '#c98a5e', radius: 0.4, mass: 0.2 }),
        orbiting(sun, 'planet', 'Terra', 28, 2),
        orbiting(sun, 'planet', 'Rust', 42, 5, { color: '#c1553b', radius: 0.5, mass: 0.5 }),
        giant,
        orbiting(giant, 'moon', 'Io', 3, 1),
        orbiting(sun, 'comet', 'Halley', 110, 3, {}, 1, 0.45), // sub-circular speed -> eccentric orbit
      ]);
    },
  },
  {
    name: 'Binary star system',
    note: 'Two equal stars orbit their barycentre; the planet orbits both.',
    dt: 0.005,
    build: () => {
      // equal masses m separated by d orbit their barycentre at v = sqrt(G m / 2d)
      const m = 500, d = 20, v = Math.sqrt(m / (2 * d));
      const a = make('star', 'Alpha', [-d / 2, 0, 0], [0, 0, -v], { mass: m, radius: 2 });
      const b = make('star', 'Beta', [d / 2, 0, 0], [0, 0, v], { mass: m, radius: 2, color: '#9ecbff' });
      const centre = { ...a, mass: 2 * m, pos: [0, 0, 0] as Vec3, vel: [0, 0, 0] as Vec3 };
      return zeroMomentum([a, b, orbiting(centre, 'planet', 'Tatooine', 80, 1)]);
    },
  },
  {
    name: 'Three-body figure-8',
    note: 'A periodic three-body orbit. Nudge one velocity by 1% and it falls apart.',
    dt: 0.002,
    build: () => {
      // Chenciner-Montgomery choreography (G = m = 1), rescaled to length L and mass M.
      const L = 20, M = 100, V = Math.sqrt(M / L);
      const x = 0.97000436 * L, z = -0.24308753 * L;
      const vx = -0.93240737 * V, vz = -0.86473146 * V;
      const o = { mass: M, radius: 0.8 };
      return [
        make('star', 'A', [x, 0, z], [-vx / 2, 0, -vz / 2], { ...o, color: '#ff8a7a' }),
        make('star', 'B', [-x, 0, -z], [-vx / 2, 0, -vz / 2], { ...o, color: '#8affc1' }),
        make('star', 'C', [0, 0, 0], [vx, 0, vz], { ...o, color: '#8ab4ff' }),
      ];
    },
  },
  {
    name: 'Rogue planet encounter',
    note: 'A massive interloper on a hyperbolic path crosses the system at about t = 25.',
    dt: 0.005,
    build: () => {
      const sun = make('star', 'Sol', [0, 0, 0], [0, 0, 0]);
      const system = zeroMomentum([
        sun,
        orbiting(sun, 'planet', 'Ember', 15, 0, { color: '#c98a5e', radius: 0.4, mass: 0.2 }),
        orbiting(sun, 'planet', 'Terra', 28, 2),
        orbiting(sun, 'planet', 'Rust', 42, 5, { color: '#c1553b', radius: 0.5, mass: 0.5 }),
        orbiting(sun, 'gas giant', 'Jove', 70, 4),
      ]);
      // speed 6 at r~155 is well above escape speed sqrt(2GM/r) ~ 3.6: unbound flyby
      return [...system, make('gas giant', 'Rogue', [-150, 0, 40], [6, 0, 0], { mass: 100, radius: 2, color: '#b18cff' })];
    },
  },
  {
    name: 'Asteroid belt',
    note: '150 asteroids between an inner planet and a giant. All pairs interact; watch step time.',
    dt: 0.005,
    build: () => {
      const rand = rng(7);
      const sun = make('star', 'Sol', [0, 0, 0], [0, 0, 0]);
      const bodies = [sun, orbiting(sun, 'planet', 'Terra', 24, 2), orbiting(sun, 'gas giant', 'Jove', 80, 4)];
      for (let i = 0; i < 150; i++) {
        const a = orbiting(sun, 'asteroid', `A${i + 1}`, 38 + rand() * 18, rand() * 2 * Math.PI, {}, 1, 0.97 + rand() * 0.06);
        a.pos[1] = (rand() - 0.5) * 2; // thin disc, slightly inclined orbits
        bodies.push(a);
      }
      return zeroMomentum(bodies);
    },
  },
  {
    name: 'Gravitational slingshot',
    note: 'Select Probe: its speed jumps from about 4.5 to 6.7 as it swings past Jove near t = 19, enough to escape the star.',
    dt: 0.002,
    build: () => slingshot(),
  },
  {
    name: 'Black hole (visual)',
    note: 'Light bending is ray-traced for a non-rotating hole and is visual only. Orbits here are still Newtonian: this is not a general-relativistic simulation.',
    dt: 0.002,
    build: () => {
      const hole = make('black hole', 'Gargantua', [0, 0, 0], [0, 0, 0]);
      return zeroMomentum([
        hole,
        orbiting(hole, 'planet', 'Miller', 38, 0.5),
        orbiting(hole, 'star', 'Companion', 75, 3.4, { mass: 40, radius: 2, color: '#9ecbff' }),
        orbiting(hole, 'gas giant', 'Mann', 110, 5.2),
        orbiting(hole, 'comet', 'Plunger', 150, 1.8, {}, 1, 0.35), // deep eccentric dive past the disk
      ]);
    },
  },
  {
    name: 'Unstable planetary system',
    note: 'Three giants packed inside each other’s Hill spheres. Expect ejections or mergers.',
    dt: 0.002,
    build: () => {
      const sun = make('star', 'Sol', [0, 0, 0], [0, 0, 0]);
      const giant = { mass: 20, radius: 1.2 };
      return zeroMomentum([
        sun,
        orbiting(sun, 'planet', 'Ember', 14, 1, { color: '#c98a5e', radius: 0.4, mass: 0.2 }),
        orbiting(sun, 'gas giant', 'Uno', 30, 0, giant),
        orbiting(sun, 'gas giant', 'Dos', 36, 2.2, { ...giant, color: '#8fd1c0' }),
        orbiting(sun, 'gas giant', 'Tres', 43, 4.1, { ...giant, color: '#d98fb8' }),
      ]);
    },
  },
  {
    name: 'Random system (generator)',
    note: 'Seeded: the same seed and settings always build the same system. High eccentricity or tilt makes it unstable.',
    dt: 0.004,
    build: () => generateSystem(),
  },
  {
    // Burrau's Pythagorean problem: masses 3, 4, 5 released from rest at the corners of a 3-4-5
    // right triangle (centre of mass already at the origin). Only append new presets: saves store indices.
    name: 'Three-body chaos (Pythagorean)',
    note: 'Start a twin run with ε = 1e-9: within about 60 time units the copies follow completely different paths. Softening is raised to 0.3 and collisions are off so the close encounters stay integrable.',
    dt: 0.002,
    softening: 0.3,
    collisions: 'off',
    build: () => {
      const L = 6, M = 100, o = { radius: 0.5 };
      return [
        make('star', 'Three', [L, 0, 3 * L], [0, 0, 0], { ...o, mass: 3 * M, color: '#ff8a7a' }),
        make('star', 'Four', [-2 * L, 0, -L], [0, 0, 0], { ...o, mass: 4 * M, color: '#8affc1' }),
        make('star', 'Five', [L, 0, -L], [0, 0, 0], { ...o, mass: 5 * M, color: '#8ab4ff' }),
      ];
    },
  },
];
export const GENERATOR_PRESET = PRESETS.findIndex((p) => p.build === generateSystem || p.name.startsWith('Random system'));
