import { describe, expect, it } from 'vitest';
import { accelerations, diagnostics, mergeCollisions, step, type Integrator, type World } from './engine';
import { make, PRESETS } from './presets';

const twoBody = (): World => ({
  time: 0,
  acc: null,
  // star M=1 at rest, test planet on a circular orbit r=1, v=sqrt(GM/r)=1, period 2*pi
  bodies: [
    make('star', 'S', [0, 0, 0], [0, 0, 0], { mass: 1, radius: 0.01 }),
    make('planet', 'P', [1, 0, 0], [0, 0, 1], { mass: 1e-9, radius: 0.001 }),
  ],
});

function driftAfterOrbit(integrator: Integrator, dt: number) {
  const w = twoBody();
  const e0 = diagnostics(w.bodies, 1, 0).energy;
  const steps = Math.round((2 * Math.PI) / dt);
  for (let i = 0; i < steps; i++) step(w, dt, { G: 1, softening: 0, integrator });
  const [s, p] = w.bodies;
  return {
    drift: Math.abs((diagnostics(w.bodies, 1, 0).energy - e0) / e0),
    r: Math.hypot(p.pos[0] - s.pos[0], p.pos[1] - s.pos[1], p.pos[2] - s.pos[2]),
    // distance from the analytic solution (cos t, 0, sin t) at the actual end time
    closure: Math.hypot(p.pos[0] - Math.cos(w.time), p.pos[2] - Math.sin(w.time)),
  };
}

describe('gravity', () => {
  it('matches Newton: a = G m / r^2, directed at the other body', () => {
    const b = [
      make('star', 'a', [0, 0, 0], [0, 0, 0], { mass: 5 }),
      make('planet', 'b', [0, 2, 0], [0, 0, 0], { mass: 3 }),
    ];
    const acc = accelerations(b, 2, 0);
    expect(acc[0]).toEqual([0, (2 * 3) / 4, 0]);
    expect(acc[1]).toEqual([0, -(2 * 5) / 4, 0]);
  });

  it('softening caps the force at zero separation', () => {
    const b = [make('star', 'a', [0, 0, 0], [0, 0, 0]), make('star', 'b', [0, 0, 0], [0, 0, 0])];
    expect(accelerations(b, 1, 0.1)[0]).toEqual([0, 0, 0]);
  });
});

describe('integrators', () => {
  it('velocity Verlet closes a circular orbit and conserves energy', () => {
    const { drift, r, closure } = driftAfterOrbit('verlet', 0.001);
    expect(drift).toBeLessThan(1e-6);
    expect(Math.abs(r - 1)).toBeLessThan(1e-5);
    expect(closure).toBeLessThan(1e-4);
  });

  it('Verlet is second order: halving dt cuts the phase error ~4x', () => {
    const ratio = driftAfterOrbit('verlet', 0.02).closure / driftAfterOrbit('verlet', 0.01).closure;
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.5);
  });

  it('Euler drifts far more than Verlet at the same dt', () => {
    expect(driftAfterOrbit('euler', 0.001).drift).toBeGreaterThan(100 * driftAfterOrbit('verlet', 0.001).drift);
  });

  it('conserves linear and angular momentum in the three-body preset', () => {
    const w: World = { time: 0, acc: null, bodies: PRESETS[2].build() };
    const d0 = diagnostics(w.bodies, 1, 0);
    for (let i = 0; i < 5000; i++) step(w, 0.002, { G: 1, softening: 0, integrator: 'verlet' });
    const d1 = diagnostics(w.bodies, 1, 0);
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(d1.momentum[k] - d0.momentum[k])).toBeLessThan(1e-9);
      expect(Math.abs(d1.angularMomentum[k] - d0.angularMomentum[k])).toBeLessThan(1e-8);
    }
    expect(Math.abs((d1.energy - d0.energy) / d0.energy)).toBeLessThan(1e-5);
  });
});

describe('collisions', () => {
  it('merge conserves mass and momentum and removes one body', () => {
    const w: World = {
      time: 0,
      acc: null,
      bodies: [
        make('planet', 'a', [0, 0, 0], [2, 0, 0], { mass: 3, radius: 1 }),
        make('planet', 'b', [1, 0, 0], [-1, 0, 0], { mass: 1, radius: 1 }),
        make('planet', 'far', [100, 0, 0], [0, 0, 0]),
      ],
    };
    const p0 = diagnostics(w.bodies, 1, 0).momentum;
    expect(mergeCollisions(w)).toBe(1);
    expect(w.bodies).toHaveLength(2);
    expect(w.bodies[0].mass).toBe(4);
    expect(w.bodies[0].name).toBe('a');
    expect(w.bodies[0].vel).toEqual([1.25, 0, 0]);
    expect(diagnostics(w.bodies, 1, 0).momentum).toEqual(p0);
  });
});
