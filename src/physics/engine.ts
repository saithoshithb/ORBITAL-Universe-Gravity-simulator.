// Pure N-body engine: no DOM, no three.js, no React. Direct O(n^2) pairwise summation.

export type Vec3 = [number, number, number];
/** 'black hole' is a Newtonian point mass like every other type; only its rendering differs. */
export type BodyType = 'star' | 'planet' | 'gas giant' | 'moon' | 'asteroid' | 'comet' | 'black hole';
export type Integrator = 'verlet' | 'euler';
export type CollisionMode = 'merge' | 'bounce' | 'off';

export interface Body {
  id: number;
  name: string;
  type: BodyType;
  mass: number;
  radius: number;
  pos: Vec3;
  vel: Vec3;
  color: string;
}

export interface World {
  bodies: Body[];
  time: number;
  /** Accelerations cached from the last Verlet step. Set to null after editing bodies, G or softening. */
  acc: Vec3[] | null;
}

export interface Params {
  G: number;
  softening: number;
  integrator: Integrator;
}

/** a_i = sum_j G m_j (r_j - r_i) / (|r|^2 + eps^2)^(3/2)  (Plummer softening) */
export function accelerations(bodies: Body[], G: number, eps: number): Vec3[] {
  const acc = bodies.map((): Vec3 => [0, 0, 0]);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], dz = b.pos[2] - a.pos[2];
      const r2 = dx * dx + dy * dy + dz * dz + eps * eps;
      const k = G / (r2 * Math.sqrt(r2));
      // Newton's third law: equal and opposite, so momentum is conserved to round-off
      acc[i][0] += k * b.mass * dx; acc[i][1] += k * b.mass * dy; acc[i][2] += k * b.mass * dz;
      acc[j][0] -= k * a.mass * dx; acc[j][1] -= k * a.mass * dy; acc[j][2] -= k * a.mass * dz;
    }
  }
  return acc;
}

export function step(w: World, dt: number, p: Params): void {
  const b = w.bodies;
  const a0 = w.acc ?? accelerations(b, p.G, p.softening);
  if (p.integrator === 'euler') {
    // explicit Euler: first order, not symplectic, energy drifts systematically
    for (let i = 0; i < b.length; i++) {
      for (let k = 0; k < 3; k++) {
        b[i].pos[k] += b[i].vel[k] * dt;
        b[i].vel[k] += a0[i][k] * dt;
      }
    }
    w.acc = null;
  } else {
    // velocity Verlet: second order, symplectic, time-reversible
    for (let i = 0; i < b.length; i++) {
      for (let k = 0; k < 3; k++) b[i].pos[k] += b[i].vel[k] * dt + 0.5 * a0[i][k] * dt * dt;
    }
    const a1 = accelerations(b, p.G, p.softening);
    for (let i = 0; i < b.length; i++) {
      for (let k = 0; k < 3; k++) b[i].vel[k] += 0.5 * (a0[i][k] + a1[i][k]) * dt;
    }
    w.acc = a1;
  }
  w.time += dt;
}

/**
 * Perfectly inelastic merge of overlapping spheres. Conserves mass and linear momentum;
 * kinetic energy is NOT conserved (it would go to heat in reality). Volume is conserved.
 * Returns the number of merges.
 */
export function mergeCollisions(w: World): number {
  const b = w.bodies;
  let merged = 0;
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const A = b[i], B = b[j];
      // squared distances: this runs for every pair every step, and Math.hypot is slow
      const dx = A.pos[0] - B.pos[0], dy = A.pos[1] - B.pos[1], dz = A.pos[2] - B.pos[2];
      const reach = A.radius + B.radius;
      if (dx * dx + dy * dy + dz * dz >= reach * reach) continue;
      const m = A.mass + B.mass;
      const mix = (x: Vec3, y: Vec3): Vec3 => [
        (A.mass * x[0] + B.mass * y[0]) / m,
        (A.mass * x[1] + B.mass * y[1]) / m,
        (A.mass * x[2] + B.mass * y[2]) / m,
      ];
      b[i] = {
        ...(A.mass >= B.mass ? A : B), // survivor keeps the heavier body's identity
        mass: m,
        radius: Math.cbrt(A.radius ** 3 + B.radius ** 3),
        pos: mix(A.pos, B.pos),
        vel: mix(A.vel, B.vel),
      };
      b.splice(j, 1);
      j--;
      merged++;
    }
  }
  if (merged) w.acc = null;
  return merged;
}

/**
 * Perfectly elastic bounce of overlapping, approaching spheres: an impulse along the line of
 * centres. Conserves linear momentum and kinetic energy. Bodies are treated as rigid, smooth
 * spheres (no spin, no friction, no deformation). Returns the number of bounces.
 */
export function bounceCollisions(w: World): number {
  const b = w.bodies;
  let bounced = 0;
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const A = b[i], B = b[j];
      const dx = B.pos[0] - A.pos[0], dy = B.pos[1] - A.pos[1], dz = B.pos[2] - A.pos[2];
      const reach = A.radius + B.radius, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= reach * reach || d2 === 0) continue;
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d;
      const closing = (B.vel[0] - A.vel[0]) * nx + (B.vel[1] - A.vel[1]) * ny + (B.vel[2] - A.vel[2]) * nz;
      if (closing >= 0) continue; // already separating: do not bounce twice while still overlapping
      const impulse = (-2 * closing) / (1 / A.mass + 1 / B.mass);
      const ka = impulse / A.mass, kb = impulse / B.mass;
      A.vel[0] -= ka * nx; A.vel[1] -= ka * ny; A.vel[2] -= ka * nz;
      B.vel[0] += kb * nx; B.vel[1] += kb * ny; B.vel[2] += kb * nz;
      bounced++;
    }
  }
  return bounced; // positions are unchanged, so cached accelerations stay valid
}

export interface RunParams extends Params { dt: number; steps: number; collisions: CollisionMode }

/**
 * Advances `w` (and the optional twin run) by `p.steps` steps, resolving collisions after each.
 * The main thread and the Web Worker both call this, so they produce identical trajectories.
 * Returns whether anything merged in `w`.
 */
export function run(w: World, twin: World | null, p: RunParams): boolean {
  const collide = (x: World): number => {
    if (p.collisions === 'merge') return mergeCollisions(x);
    if (p.collisions === 'bounce') bounceCollisions(x); // bounces keep every body, so report no merges
    return 0;
  };
  let merged = false;
  for (let i = 0; i < p.steps; i++) {
    step(w, p.dt, p);
    if (collide(w)) merged = true;
    if (twin) {
      step(twin, p.dt, p);
      collide(twin);
    }
  }
  return merged;
}

/** Message to the physics worker; `version` lets the main thread discard results made stale by an edit. */
export interface Job { version: number; world: World; twin: World | null; params: RunParams }
export interface JobResult extends Job { merged: boolean; ms: number }

export interface Diagnostics {
  kinetic: number;
  potential: number;
  energy: number;
  momentum: Vec3;
  angularMomentum: Vec3;
}

/** Potential uses the same softening as the force, so E = K + U is the quantity the integrator conserves. */
export function diagnostics(bodies: Body[], G: number, eps: number): Diagnostics {
  let kinetic = 0, potential = 0;
  const p: Vec3 = [0, 0, 0], L: Vec3 = [0, 0, 0];
  for (let i = 0; i < bodies.length; i++) {
    const { mass: m, pos: r, vel: v } = bodies[i];
    kinetic += 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    p[0] += m * v[0]; p[1] += m * v[1]; p[2] += m * v[2];
    L[0] += m * (r[1] * v[2] - r[2] * v[1]);
    L[1] += m * (r[2] * v[0] - r[0] * v[2]);
    L[2] += m * (r[0] * v[1] - r[1] * v[0]);
    for (let j = i + 1; j < bodies.length; j++) {
      const q = bodies[j].pos;
      const d2 = (r[0] - q[0]) ** 2 + (r[1] - q[1]) ** 2 + (r[2] - q[2]) ** 2 + eps * eps;
      potential -= (G * m * bodies[j].mass) / Math.sqrt(d2);
    }
  }
  return { kinetic, potential, energy: kinetic + potential, momentum: p, angularMomentum: L };
}

/** False once any coordinate is NaN/Infinity (e.g. zero-distance encounter with no softening). */
export const isFiniteState = (bodies: Body[]): boolean =>
  bodies.every((b) => b.pos.every(Number.isFinite) && b.vel.every(Number.isFinite));
