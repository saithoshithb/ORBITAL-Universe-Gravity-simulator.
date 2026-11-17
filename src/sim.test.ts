import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bounceCollisions, diagnostics, isFiniteState, mergeCollisions, run, step, type Job, type JobResult, type World,
} from './physics/engine';
import { generateSystem, make, PRESETS, slingshot } from './physics/presets';
import {
  advance, AUTO_WORKER_BODIES, cursor, ghost, history, launchProbe, launchWithVelocity, loadPreset, loadSave, predictLaunch,
  rewindTo, sample, startTwin, timeline, toSave, touch, useStore, world,
} from './sim';

const snapshot = () => JSON.stringify(world.bodies.map((b) => [b.id, b.mass, b.pos, b.vel]));

describe('presets', () => {
  it.each(PRESETS.map((p, i) => [p.name, i] as const))('%s builds and stays finite', (_, i) => {
    const w: World = { time: 0, acc: null, bodies: PRESETS[i].build() };
    for (let k = 0; k < 300; k++) step(w, PRESETS[i].dt, { G: 1, softening: 0.05, integrator: 'verlet' });
    expect(isFiniteState(w.bodies)).toBe(true);
  });

  it('builds identically every time (seeded)', () => {
    const strip = (i: number) => PRESETS[i].build().map((b) => [b.pos, b.vel]);
    expect(strip(4)).toEqual(strip(4));
  });

  /** Probe's specific orbital energy relative to the star after 80 time units; > 0 means escape. */
  function probeEnergy(giantAngle?: number): number {
    const w: World = { time: 0, acc: null, bodies: slingshot(giantAngle) };
    for (let k = 0; k < 40000; k++) {
      step(w, 0.002, { G: 1, softening: 0.05, integrator: 'verlet' });
      mergeCollisions(w);
    }
    expect(w.bodies).toHaveLength(3); // no impact
    const [s, , p] = w.bodies;
    const v2 = p.vel.reduce((a, v, k) => a + (v - s.vel[k]) ** 2, 0);
    return v2 / 2 - 1000 / Math.hypot(...p.pos.map((x, k) => x - s.pos[k]));
  }

  it('slingshot: flyby turns a bound probe orbit into an escape', () => {
    expect(probeEnergy(4)).toBeLessThan(-7); // giant far away: probe stays bound
    expect(probeEnergy()).toBeGreaterThan(1); // tuned flyby: unbound
  });
});

describe('save / load', () => {
  it('round-trips through JSON, loads paused, and assigns fresh ids', () => {
    loadPreset(1);
    for (let f = 0; f < 50; f++) advance();
    useStore.setState({ G: 2, integrator: 'euler' });
    const strip = () => JSON.stringify(world.bodies.map((b) => [b.name, b.mass, b.pos, b.vel]));
    const before = strip(), ids = world.bodies.map((b) => b.id), t = world.time;
    const save = JSON.parse(JSON.stringify(toSave('x')));

    loadPreset(0);
    loadSave(save);
    expect(strip()).toBe(before);
    expect(world.time).toBe(t);
    expect(useStore.getState()).toMatchObject({ G: 2, integrator: 'euler', running: false, preset: 1 });
    expect(world.bodies.some((b) => ids.includes(b.id))).toBe(false);
    expect(timeline.length).toBe(1);
  });

  it('rejects corrupt saves without touching the world', () => {
    loadPreset(0);
    const before = snapshot();
    const bad = toSave('bad');
    bad.bodies[0].pos[0] = NaN;
    expect(() => loadSave(bad)).toThrow(/corrupt/);
    expect(() => loadSave({ ...toSave('bad2'), bodies: [{ ...world.bodies[0], mass: 0 }] })).toThrow(/corrupt/);
    expect(snapshot()).toBe(before);
  });
});

describe('analytics series', () => {
  it('tracks distance and relative speed of the selected body against the reference', () => {
    loadPreset(0);
    const [sun, , terra] = world.bodies;
    sample(60, 0);
    expect(useStore.getState().stats!.distance).toBeNaN(); // nothing selected
    useStore.setState({ selectedId: terra.id });
    sample(60, 0);
    const st = useStore.getState().stats!;
    expect(st.distance).toBeCloseTo(28, 6); // Terra's orbit radius; reference defaults to the heaviest body
    expect(st.speed).toBeCloseTo(Math.sqrt(1000 / 28), 6); // circular speed sqrt(GM/r)
    expect(history.distance).toHaveLength(1); // series restarted when the selection changed
    useStore.setState({ selectedId: sun.id });
    sample(60, 0);
    expect(useStore.getState().stats!.distance).toBeNaN(); // a body has no distance to itself
  });
});

describe('collision modes', () => {
  const headOn = (): World => ({
    time: 0,
    acc: null,
    bodies: [
      make('planet', 'a', [0, 0, 0], [3, 0, 0], { mass: 2, radius: 1 }),
      make('planet', 'b', [1.5, 0, 0], [-1, 0, 0], { mass: 1, radius: 1 }),
    ],
  });

  it('elastic bounce conserves momentum and kinetic energy, and matches the 1D formula', () => {
    const w = headOn(), d0 = diagnostics(w.bodies, 0, 0);
    expect(bounceCollisions(w)).toBe(1);
    const d1 = diagnostics(w.bodies, 0, 0);
    expect(d1.momentum[0]).toBeCloseTo(d0.momentum[0], 12);
    expect(d1.kinetic).toBeCloseTo(d0.kinetic, 12);
    // v1' = ((m1-m2)v1 + 2 m2 v2)/(m1+m2) = 1/3, v2' = ((m2-m1)v2 + 2 m1 v1)/(m1+m2) = 13/3
    expect(w.bodies[0].vel[0]).toBeCloseTo(1 / 3, 12);
    expect(w.bodies[1].vel[0]).toBeCloseTo(13 / 3, 12);
    expect(bounceCollisions(w)).toBe(0); // now separating: no second bounce while still overlapping
  });

  it('the collision setting selects merge, bounce or pass-through', () => {
    const overlap = () => {
      loadPreset(0);
      useStore.setState({ speed: 1 });
      world.bodies[1].pos = [world.bodies[0].pos[0] + 1, 0, 0];
      world.bodies[1].vel = [-5, 0, 0]; // heading into the star
      return world.bodies.length;
    };
    let n = overlap();
    useStore.setState({ collisions: 'off' });
    advance();
    expect(world.bodies.length).toBe(n);
    expect(world.bodies[1].vel[0]).toBeLessThan(0); // still moving inward: passed through

    n = overlap();
    useStore.setState({ collisions: 'bounce' });
    advance();
    expect(world.bodies.length).toBe(n);
    expect(world.bodies[1].vel[0]).toBeGreaterThan(0); // reflected

    n = overlap();
    useStore.setState({ collisions: 'merge', speed: 10 });
    advance();
    expect(world.bodies.length).toBe(n - 1);
  });
});

describe('system generator', () => {
  it('is deterministic per seed, differs across seeds, and honours its options', () => {
    const o = { seed: 42, planets: 7, eccentricity: 0.2, inclination: 10, asteroids: 25 };
    const strip = (b: ReturnType<typeof generateSystem>) => b.map((x) => [x.type, x.mass, x.pos, x.vel]);
    const sys = generateSystem(o);
    expect(strip(generateSystem(o))).toEqual(strip(sys));
    expect(strip(generateSystem({ ...o, seed: 43 }))).not.toEqual(strip(sys));
    expect(sys.filter((b) => b.type === 'star')).toHaveLength(1);
    expect(sys.filter((b) => b.type === 'planet' || b.type === 'gas giant')).toHaveLength(7);
    expect(sys.filter((b) => b.type === 'asteroid')).toHaveLength(25);
    expect(sys.some((b) => b.vel[1] !== 0)).toBe(true); // inclined orbits leave the plane
    expect(generateSystem({ ...o, inclination: 0 }).filter((b) => b.type !== 'moon').every((b) => Math.abs(b.vel[1]) < 1e-12)).toBe(true);
  });

  it('starts with no overlapping bodies and zero net momentum, for many seeds', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const w: World = { time: 0, acc: null, bodies: generateSystem({ seed, planets: 9, eccentricity: 0.3, inclination: 20, asteroids: 40 }) };
      const n = w.bodies.length;
      expect(mergeCollisions(w), `seed ${seed}`).toBe(0);
      expect(w.bodies.length).toBe(n);
      expect(Math.hypot(...diagnostics(w.bodies, 1, 0).momentum)).toBeLessThan(1e-9);
    }
  });

  it('a circular, flat generated system survives 2000 steps intact', () => {
    const w: World = { time: 0, acc: null, bodies: generateSystem({ seed: 5, planets: 6, eccentricity: 0, inclination: 0, asteroids: 0 }) };
    const n = w.bodies.length, e0 = diagnostics(w.bodies, 1, 0.05).energy;
    for (let k = 0; k < 2000; k++) {
      step(w, 0.004, { G: 1, softening: 0.05, integrator: 'verlet' });
      mergeCollisions(w);
    }
    expect(w.bodies.length).toBe(n);
    expect(Math.abs((diagnostics(w.bodies, 1, 0.05).energy - e0) / e0)).toBeLessThan(1e-5);
  });
});

describe('twin run (chaos lab)', () => {
  it('starts from an identical copy apart from one nudged velocity, then diverges', () => {
    loadPreset(7); // unstable planetary system
    useStore.setState({ speed: 10 });
    startTwin(1e-6);
    expect(ghost!.bodies.map((b) => b.pos)).toEqual(world.bodies.map((b) => b.pos));
    expect(ghost!.bodies.filter((g, i) => g.vel[0] !== world.bodies[i].vel[0])).toHaveLength(1);

    sample(60, 0);
    expect(useStore.getState().stats!.twin).toBe(-Infinity); // log10(0): identical positions
    for (let f = 0; f < 50; f++) advance();
    sample(60, 0);
    const early = useStore.getState().stats!.twin;
    for (let f = 0; f < 1500; f++) advance();
    sample(60, 0);
    const late = useStore.getState().stats!.twin;
    expect(early).toBeLessThan(-3); // still tiny
    expect(late - early).toBeGreaterThan(2); // grew by more than 100x
  });

  it('Pythagorean preset: a 1e-9 nudge grows to a macroscopic gap while energy stays within 1%', () => {
    loadPreset(PRESETS.findIndex((p) => p.name.includes('Pythagorean')));
    expect(useStore.getState()).toMatchObject({ softening: 0.3, collisions: 'off' });
    useStore.setState({ speed: 10, integrator: 'verlet' }); // integrator survives preset loads by design
    startTwin(1e-9);
    for (let f = 0; f < 3000; f++) advance(); // t = 60
    sample(60, 0);
    const st = useStore.getState().stats!;
    expect(world.bodies).toHaveLength(3);
    expect(st.twin).toBeGreaterThan(0); // separation > 1 length unit: 9+ orders of magnitude of growth
    expect(st.drift).toBeLessThan(0.01);
  });

  it('loading a preset resets softening and collisions to its own settings', () => {
    useStore.setState({ softening: 1, collisions: 'bounce' });
    loadPreset(0);
    expect(useStore.getState()).toMatchObject({ softening: 0.05, collisions: 'merge' });
  });

  it('is dropped by rewind and by loading a preset; no twin reads as NaN', () => {
    loadPreset(0);
    startTwin(1e-6);
    advance();
    rewindTo(0);
    expect(ghost).toBe(null);
    startTwin(1e-6);
    loadPreset(1);
    expect(ghost).toBe(null);
    sample(60, 0);
    expect(useStore.getState().stats!.twin).toBeNaN();
  });
});

describe('probe launch', () => {
  it('launches prograde from above the surface with the requested relative speed', () => {
    loadPreset(0);
    const [sun, , terra] = world.bodies;
    const n = world.bodies.length;
    const probe = launchProbe(terra.id, 3, 0)!;
    expect(world.bodies.length).toBe(n + 1);
    expect(useStore.getState().selectedId).toBe(probe.id);

    const rel = probe.vel.map((v, k) => v - terra.vel[k]);
    expect(Math.hypot(...rel)).toBeCloseTo(3, 12);
    const orbital = terra.vel.map((v, k) => v - sun.vel[k]);
    const cos = (rel[0] * orbital[0] + rel[2] * orbital[2]) / (3 * Math.hypot(...orbital));
    expect(cos).toBeCloseTo(1, 9); // heading 0 = along the planet's orbital motion

    const gap = Math.hypot(...probe.pos.map((x, k) => x - terra.pos[k]));
    expect(gap).toBeGreaterThan(terra.radius + probe.radius);
    advance();
    expect(world.bodies.some((b) => b.id === probe.id)).toBe(true); // did not merge back on launch

    const retro = launchProbe(terra.id, 3, 180)!;
    const back = retro.vel.map((v, k) => v - terra.vel[k]);
    const now = terra.vel.map((v, k) => v - sun.vel[k]); // the planet has moved on since the first launch
    expect((back[0] * now[0] + back[2] * now[2]) / (3 * Math.hypot(...now))).toBeCloseTo(-1, 9);
    expect(launchProbe(-1, 3, 0)).toBeUndefined();
  });
});

describe('drag-to-launch', () => {
  it('launches with an arbitrary relative velocity, clear of the surface', () => {
    loadPreset(0);
    const terra = world.bodies[2];
    const p = launchWithVelocity(terra.id, [0, 2, 0])!; // straight up, out of the orbital plane
    expect(p.vel.map((v, k) => v - terra.vel[k])).toEqual([0, 2, 0]);
    expect(p.pos[1] - terra.pos[1]).toBeGreaterThan(terra.radius + p.radius);
    expect(launchWithVelocity(-1, [1, 0, 0])).toBeUndefined();
  });

  it('predicts the same path the launched probe then follows, without touching the world', () => {
    loadPreset(0);
    useStore.setState({ speed: 4, integrator: 'verlet', collisions: 'off' });
    const terra = world.bodies[2], before = snapshot();
    const out = new Float32Array(300 * 3);
    const n = predictLaunch(terra.id, [3, 0, 0], out);
    expect(n).toBeGreaterThan(100);
    expect(snapshot()).toBe(before); // preview integrates a copy

    // the preview steps at 4*dt; one real frame of `speed`=4 steps of dt covers one preview step,
    // so after 4*k frames the probe should be near preview point k (coarser step: close, not equal)
    const probe = launchWithVelocity(terra.id, [3, 0, 0])!;
    for (let f = 0; f < 4 * 40; f++) advance(); // 160 preview steps -> point 40
    const q = world.bodies.find((b) => b.id === probe.id)!.pos;
    const k = 40;
    const miss = Math.hypot(q[0] - out[3 * k], q[1] - out[3 * k + 1], q[2] - out[3 * k + 2]);
    expect(miss).toBeLessThan(0.5);
  });

  it('skips the preview for crowded systems instead of stalling the frame', () => {
    loadPreset(PRESETS.findIndex((p) => p.name.startsWith('Random')));
    Object.assign(world, { bodies: world.bodies.concat(Array.from({ length: 50 }, (_, i) => make('moon', `m${i}`, [200 + i * 3, 0, 0], [0, 0, 0]))) });
    expect(predictLaunch(world.bodies[1].id, [1, 0, 0], new Float32Array(900))).toBe(0);
  });
});

describe('physics worker', () => {
  // Stand-in for the browser Worker: runs the real `run` on a structured clone, asynchronously,
  // exactly as src/physics/worker.ts does.
  class FakeWorker {
    onmessage: ((e: { data: JobResult }) => void) | null = null;
    onerror = null;
    postMessage(job: Job) {
      const copy = structuredClone(job);
      setTimeout(() => this.onmessage?.({ data: { ...copy, merged: run(copy.world, copy.twin, copy.params), ms: 1 } }));
    }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const strip = () => JSON.stringify(world.bodies.map((b) => [b.mass, b.pos, b.vel]));
  beforeAll(() => vi.stubGlobal('Worker', FakeWorker));
  afterAll(() => {
    vi.unstubAllGlobals();
    useStore.setState({ thread: 'auto' });
  });

  it('produces bit-for-bit the same trajectory as the main thread', async () => {
    loadPreset(2);
    useStore.setState({ thread: 'main', speed: 10, integrator: 'verlet', collisions: 'merge' });
    for (let f = 0; f < 60; f++) advance();
    const reference = strip();

    loadPreset(2);
    useStore.setState({ thread: 'worker', speed: 10 });
    for (let f = 0; f < 60; f++) {
      advance();
      await flush();
    }
    expect(strip()).toBe(reference);
    expect(timeline.length).toBe(7); // rewind recording still happens on the worker path
  });

  it('discards a result computed before an edit, then continues from the edit', async () => {
    loadPreset(0);
    useStore.setState({ thread: 'worker' });
    advance(); // job in flight
    world.bodies[1].mass = 5;
    touch();
    const edited = strip();
    await flush();
    expect(strip()).toBe(edited); // stale result dropped, edit kept
    expect(world.time).toBe(0);
    advance();
    await flush();
    expect(world.bodies[1].mass).toBe(5);
    expect(world.time).toBeGreaterThan(0);
  });

  it('auto mode keeps small systems on the main thread and moves big ones to the worker', async () => {
    useStore.setState({ thread: 'auto' });
    loadPreset(0);
    advance();
    expect(world.time).toBeGreaterThan(0); // stepped synchronously
    loadPreset(4); // 153 bodies: below the threshold, still main thread
    advance();
    expect(world.time).toBeGreaterThan(0);
    loadPreset(PRESETS.findIndex((p) => p.name.startsWith('Random')));
    world.bodies.push(...Array.from({ length: AUTO_WORKER_BODIES }, (_, i) => make('asteroid', `x${i}`, [500 + i, 0, 0], [0, 0, 0])));
    touch();
    expect(world.bodies.length).toBeGreaterThanOrEqual(AUTO_WORKER_BODIES);
    advance();
    expect(world.time).toBe(0); // handed to the worker
    await flush();
    expect(world.time).toBeGreaterThan(0);
  });
});

describe('rewind', () => {
  it('restores a recorded state exactly and replays deterministically', () => {
    loadPreset(2);
    const start = snapshot();
    for (let f = 0; f < 100; f++) advance();
    const later = snapshot();
    expect(later).not.toBe(start);
    expect(timeline.length).toBe(11); // initial + one per 10 frames

    rewindTo(0);
    expect(snapshot()).toBe(start);
    expect(world.time).toBe(0);
    expect(useStore.getState().running).toBe(false);
    expect(cursor).toBe(0);

    for (let f = 0; f < 100; f++) advance();
    expect(snapshot()).toBe(later); // same initial state, same steps, same floats
    expect(cursor).toBe(null);
  });

  it('resuming from the past discards the recorded future', () => {
    loadPreset(0);
    for (let f = 0; f < 100; f++) advance();
    rewindTo(3);
    advance();
    expect(timeline.length).toBe(5);
  });

  it('brings back bodies lost in a later collision', () => {
    loadPreset(0);
    const n = world.bodies.length;
    world.bodies[1].pos = [...world.bodies[0].pos];
    advance();
    expect(world.bodies.length).toBe(n - 1);
    rewindTo(0);
    expect(world.bodies.length).toBe(n);
  });
});
