// Glue between the pure engine and the UI. The world is a plain mutable object the render
// loop reads every frame; only low-rate summaries (4 Hz) go through React state.
import { create } from 'zustand';
import {
  diagnostics, isFiniteState, run, step,
  type Body, type BodyType, type CollisionMode, type Integrator, type Job, type JobResult, type RunParams, type Vec3, type World,
} from './physics/engine';
export type { CollisionMode };
import { BODY_TYPES, make, newId, orbiting, PRESETS } from './physics/presets';

/** Quantities sampled at 4 Hz and available as charts. */
export const SERIES = {
  drift: 'Energy error |ΔE/E₀|',
  kinetic: 'Kinetic energy',
  potential: 'Potential energy',
  energy: 'Total energy',
  momentum: '|Total momentum|',
  angularMomentum: '|Total angular momentum|',
  speed: 'Selected: speed relative to reference',
  distance: 'Selected: distance to reference',
  twin: 'Twin runs: log₁₀ separation',
} as const;
export type SeriesKey = keyof typeof SERIES;
const SERIES_KEYS = Object.keys(SERIES) as SeriesKey[];

export type Stats = Record<SeriesKey, number> & { time: number; count: number; fps: number; stepMs: number; onWorker: boolean };

/** Where physics runs. 'auto' uses the worker once the system has AUTO_WORKER_BODIES bodies. */
export type PhysicsThread = 'auto' | 'main' | 'worker';
// Measured on an Intel Arc laptop: the main thread holds 60 fps at ~160 bodies (8.8 ms/frame) but
// not at ~310 (16.8 ms). The worker keeps frames at 3.5–20 ms up to 1000 bodies but simulated
// faster than the main thread only at ~160 bodies, so switch where smoothness starts to suffer.
export const AUTO_WORKER_BODIES = 250;

interface State {
  running: boolean;
  unstable: boolean;
  preset: number;
  dt: number;
  speed: number; // physics steps per rendered frame
  G: number;
  softening: number;
  integrator: Integrator;
  collisions: CollisionMode;
  thread: PhysicsThread;
  showTrails: boolean;
  showVelocity: boolean;
  showForce: boolean;
  bloom: boolean;
  selectedId: number | null;
  refId: number | null; // reference body for distance / relative speed; null = heaviest
  stats: Stats | null;
  trailEpoch: number; // bumped when trails must be cleared (rewind, load)
}

export const useStore = create<State>(() => ({
  running: true, unstable: false, preset: 0, dt: 0.005, speed: 10, G: 1, softening: 0.05,
  integrator: 'verlet', collisions: 'merge', thread: 'auto', showTrails: true, showVelocity: false, showForce: false, bloom: true,
  selectedId: null, refId: null, stats: null, trailEpoch: 0,
}));

export const world: World = { bodies: [], time: 0, acc: null };
/** Last 240 samples (60 s) per series. NaN where a series has no value (nothing selected). */
export const history = Object.fromEntries(SERIES_KEYS.map((k) => [k, [] as number[]])) as Record<SeriesKey, number[]>;
let e0: number | null = null;
let lastPair = '';

const clearHistory = () => SERIES_KEYS.forEach((k) => (history[k].length = 0));
const heaviest = (): Body | undefined => world.bodies.reduce<Body | undefined>((a, b) => (!a || b.mass > a.mass ? b : a), undefined);
const clone = (bodies: Body[]): Body[] => bodies.map((b) => ({ ...b, pos: [...b.pos], vel: [...b.vel] }));

/**
 * Chaos lab: a second copy of the system, started from the current state with one velocity
 * nudged by a relative epsilon and integrated with identical settings. Edits made to the main
 * run afterwards are not mirrored. Null when no twin is running.
 */
export let ghost: World | null = null;

export function startTwin(epsilon: number): void {
  const bodies = clone(world.bodies);
  const target = bodies.find((b) => b.id === useStore.getState().selectedId) ?? bodies[0];
  if (!target) return;
  target.vel[0] += epsilon * (Math.hypot(...target.vel) || 1);
  ghost = { bodies, time: world.time, acc: null };
  history.twin.length = 0;
  version++;
}

export function stopTwin(): void {
  ghost = null;
  version++;
}

/** Root-sum-square position difference over bodies that still exist in both runs. */
function twinSeparation(): number {
  if (!ghost) return NaN;
  const twins = new Map(ghost.bodies.map((b) => [b.id, b]));
  let sum = 0;
  for (const b of world.bodies) {
    const g = twins.get(b.id);
    if (g) for (let k = 0; k < 3; k++) sum += (b.pos[k] - g.pos[k]) ** 2;
  }
  return Math.sqrt(sum);
}

/**
 * Bumped by every change to the world made outside the integrator. A worker result computed
 * from an older version is discarded instead of overwriting the change.
 */
let version = 0;
export const bump = (): void => void version++;

/** Call after any edit to bodies, G or softening: drops cached accelerations and re-baselines energy. */
export function touch(): void {
  world.acc = null;
  e0 = null;
  version++;
}

// Rewind: recorded states, not reverse integration, so it is exact for any integrator and
// survives collisions. One snapshot every SNAP_EVERY frames, oldest dropped past MAX_SNAPS.
const SNAP_EVERY = 10, MAX_SNAPS = 600;
interface Snapshot { time: number; bodies: Body[]; e0: number | null }
export const timeline: Snapshot[] = [];
/** Index the user scrubbed to, or null when at the live end. */
export let cursor: number | null = null;
let framesSinceSnap = 0;

function record(): void {
  if (cursor !== null) {
    timeline.length = cursor + 1; // resuming from the past discards the old future
    cursor = null;
  }
  timeline.push({ time: world.time, bodies: clone(world.bodies), e0 });
  if (timeline.length > MAX_SNAPS) timeline.shift();
  framesSinceSnap = 0;
}

export function rewindTo(i: number): void {
  const snap = timeline[i];
  if (!snap) return;
  ghost = null; // the twin is not recorded, so it cannot be rewound with the main run
  cursor = i;
  world.bodies = clone(snap.bodies);
  world.time = snap.time;
  world.acc = null;
  version++;
  e0 = snap.e0; // keep the energy baseline of that moment so the error readout stays meaningful
  clearHistory();
  useStore.setState((s) => ({ running: false, unstable: false, trailEpoch: s.trailEpoch + 1 }));
}

function restart(bodies: Body[], time: number): void {
  world.bodies = bodies;
  world.time = time;
  ghost = null;
  touch();
  clearHistory();
  timeline.length = 0;
  cursor = null;
  record();
}

export function loadPreset(i: number): void {
  const p = PRESETS[i];
  restart(p.build(), 0);
  useStore.setState({
    preset: i, dt: p.dt, G: 1, softening: p.softening ?? 0.05, collisions: p.collisions ?? 'merge',
    selectedId: null, refId: null, unstable: false, running: true,
  });
}

// Web Worker pipeline: while the worker computes frame k+1, the main thread renders frame k.
// At most one job is in flight; a frame that finds it unfinished renders the same state again.
let worker: Worker | null = null;
let workerBroken = false;
let inflight = false;
let workerMs = 0;

/** True when the next advance() will use the worker. */
export function onWorker(): boolean {
  const { thread } = useStore.getState();
  const wanted = thread === 'worker' || (thread === 'auto' && world.bodies.length >= AUTO_WORKER_BODIES);
  return wanted && !workerBroken && typeof Worker !== 'undefined';
}

function receive(r: JobResult): void {
  inflight = false;
  workerMs = r.ms;
  // stale: the world was edited after the job was sent, or physics moved back to the main thread
  if (r.version !== version || !onWorker()) return;
  world.bodies = r.world.bodies;
  world.time = r.world.time;
  world.acc = r.world.acc;
  ghost = r.twin;
  settle(r.merged);
}

/** Bookkeeping after a batch of steps, wherever they ran. */
function settle(merged: boolean): void {
  if (merged) e0 = null; // merging is inelastic, so energy legitimately changes
  if (ghost && !isFiniteState(ghost.bodies)) ghost = null;
  if (!isFiniteState(world.bodies)) {
    useStore.setState({ running: false, unstable: true });
    return; // never record a broken state
  }
  if (++framesSinceSnap >= SNAP_EVERY || cursor !== null) record();
}

/** Advances one rendered frame of physics. Returns the physics cost in ms for the stats readout. */
export function advance(): number {
  const s = useStore.getState();
  const params: RunParams = { G: s.G, softening: s.softening, integrator: s.integrator, dt: s.dt, steps: s.speed, collisions: s.collisions };
  if (onWorker()) {
    if (!inflight) {
      if (!worker) {
        worker = new Worker(new URL('./physics/worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<JobResult>) => receive(e.data);
        worker.onerror = (e) => {
          console.error('Physics worker failed; continuing on the main thread.', e);
          inflight = false;
          workerBroken = true;
        };
      }
      inflight = true;
      worker.postMessage({ version, world, twin: ghost, params } satisfies Job);
    }
    return workerMs;
  }
  const t0 = performance.now();
  settle(run(world, ghost, params));
  return performance.now() - t0;
}

export function sample(fps: number, stepMs: number): void {
  const s = useStore.getState();
  const d = diagnostics(world.bodies, s.G, s.softening);
  if (e0 === null) {
    e0 = d.energy;
    history.drift.length = 0;
  }

  const sel = world.bodies.find((b) => b.id === s.selectedId);
  const ref = world.bodies.find((b) => b.id === s.refId) ?? heaviest();
  const other = sel && ref && ref !== sel ? ref : undefined;
  const pair = `${sel?.id}:${other?.id}`;
  if (pair !== lastPair) {
    history.speed.length = history.distance.length = 0;
    lastPair = pair;
  }

  const stats: Stats = {
    time: world.time, count: world.bodies.length, fps, stepMs, onWorker: onWorker(),
    drift: e0 !== 0 ? Math.abs((d.energy - e0) / e0) : 0,
    kinetic: d.kinetic, potential: d.potential, energy: d.energy,
    momentum: Math.hypot(...d.momentum), angularMomentum: Math.hypot(...d.angularMomentum),
    speed: sel ? Math.hypot(...sel.vel.map((v, k) => v - (other?.vel[k] ?? 0))) : NaN,
    distance: sel && other ? Math.hypot(...sel.pos.map((x, k) => x - other.pos[k])) : NaN,
    twin: Math.log10(twinSeparation()), // log scale: a straight rising line is exponential divergence
  };
  for (const k of SERIES_KEYS) {
    history[k].push(stats[k]);
    if (history[k].length > 240) history[k].shift();
  }
  useStore.setState({ stats });
}

export function addBody(type: BodyType): void {
  const { G } = useStore.getState();
  const parent = heaviest();
  const name = `${type} ${world.bodies.length + 1}`;
  const body = parent
    ? orbiting(parent, type, name, parent.radius * 4 + 10 + Math.random() * 70, Math.random() * 2 * Math.PI, {}, G)
    : make(type, name, [0, 0, 0], [0, 0, 0]);
  world.bodies.push(body);
  touch();
  useStore.setState({ selectedId: body.id });
}

/**
 * Launches a near-massless probe from just above a body's surface. `heading` is degrees in
 * the xz-plane measured from the body's direction of travel relative to the reference body
 * (0 = prograde, 180 = retrograde; other angles turn within the xz-plane); `speed` is
 * relative to the launching body. Returns the probe, or undefined if the body is gone.
 */
export function launchProbe(fromId: number, speed: number, heading: number): Body | undefined {
  const from = world.bodies.find((b) => b.id === fromId);
  if (!from) return;
  const ref = world.bodies.find((b) => b.id === useStore.getState().refId) ?? heaviest();
  const rel = ref && ref !== from ? [from.vel[0] - ref.vel[0], from.vel[2] - ref.vel[2]] : [from.vel[0], from.vel[2]];
  const a = Math.atan2(rel[1], rel[0]) + (heading * Math.PI) / 180; // (1, 0) if the body is at rest
  return launchWithVelocity(fromId, [Math.cos(a) * speed, 0, Math.sin(a) * speed]);
}

/** A 1e-6-mass probe leaving `from` with velocity `rel` relative to it, placed just clear of its surface. */
function probeFrom(from: Body, rel: Vec3, id?: number): Body {
  const s = Math.hypot(...rel);
  const dir = s > 0 ? rel.map((v) => v / s) : [1, 0, 0];
  const gap = from.radius * 1.5 + 0.3; // clear of the surface, or it would merge on the first step
  return make('asteroid', `Probe ${world.bodies.length + 1}`,
    [from.pos[0] + dir[0] * gap, from.pos[1] + dir[1] * gap, from.pos[2] + dir[2] * gap],
    [from.vel[0] + rel[0], from.vel[1] + rel[1], from.vel[2] + rel[2]],
    { mass: 1e-6, radius: 0.1, color: '#ffffff', ...(id === undefined ? {} : { id }) });
}

/** Launches a probe from a body with any velocity relative to it (drag-to-launch uses this). */
export function launchWithVelocity(fromId: number, rel: Vec3): Body | undefined {
  const from = world.bodies.find((b) => b.id === fromId);
  if (!from) return;
  const probe = probeFrom(from, rel);
  world.bodies.push(probe);
  touch();
  useStore.setState({ selectedId: probe.id });
  return probe;
}

// shortcut: the preview ignores bodies lighter than 1e-5 of the heaviest (asteroids, comets) and is
// skipped above PREVIEW_MAX remaining bodies, because it re-integrates every frame while dragging
const PREVIEW_MAX = 40, PREVIEW_STEPS = 1000, PREVIEW_EVERY = 4;

/**
 * Predicted path of a probe launched from `fromId` with velocity `rel`, written into `out` as
 * xyz triples. Integrates a throwaway copy at 4x the current dt with no collisions, so it is an
 * approximation that drifts from the real run after close encounters. Returns the point count.
 */
export function predictLaunch(fromId: number, rel: Vec3, out: Float32Array): number {
  const from = world.bodies.find((b) => b.id === fromId);
  const top = heaviest();
  if (!from || !top) return 0;
  const bodies = clone(world.bodies.filter((b) => b.mass >= top.mass * 1e-5 || b === from));
  if (bodies.length > PREVIEW_MAX) return 0;
  bodies.push(probeFrom(from, rel, -1)); // id -1: never collides with a real id, and never shown
  const s = useStore.getState(), w: World = { bodies, time: 0, acc: null }, probe = bodies[bodies.length - 1];
  let n = 0;
  for (let i = 0; i < PREVIEW_STEPS && (n + 1) * 3 <= out.length; i++) {
    step(w, s.dt * 4, s);
    if (i % PREVIEW_EVERY === 0) out.set(probe.pos, 3 * n++);
  }
  return n;
}

export function removeBody(id: number): void {
  world.bodies = world.bodies.filter((b) => b.id !== id);
  touch();
  useStore.setState({ selectedId: null });
}

export interface Save {
  name: string;
  savedAt: number;
  time: number;
  bodies: Body[];
  /** `preset` is the experiment the save started from: what the selector shows and Reset returns to. */
  settings: Pick<State, 'G' | 'dt' | 'softening' | 'integrator' | 'speed' | 'preset' | 'collisions'>;
}

export function toSave(name: string): Save {
  const { G, dt, softening, integrator, speed, preset, collisions } = useStore.getState();
  return {
    name, savedAt: Date.now(), time: world.time, bodies: clone(world.bodies),
    settings: { G, dt, softening, integrator, speed, preset, collisions },
  };
}

/** Loads paused. Throws on data that would poison the integrator. */
export function loadSave(s: Save): void {
  const ok = Array.isArray(s?.bodies) && s.bodies.every((b) => b.mass > 0 && b.radius > 0 && b.pos?.length === 3 && b.vel?.length === 3)
    && isFiniteState(s.bodies) && s.settings?.dt > 0 && Number.isFinite(s.time) && !!PRESETS[s.settings.preset];
  if (!ok) throw new Error(`Save "${s?.name}" is corrupt and was not loaded.`);
  // fresh ids: saved ids could collide with bodies created later in this session
  restart(clone(s.bodies).map((b) => ({ ...b, id: newId() })), s.time);
  useStore.setState((st) => ({ ...s.settings, selectedId: null, refId: null, unstable: false, running: false, trailEpoch: st.trailEpoch + 1 }));
}

export const TYPE_NAMES = Object.keys(BODY_TYPES) as BodyType[];
