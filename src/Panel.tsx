import { useEffect, useRef, useState } from 'react';
import type { BodyType, Integrator } from './physics/engine';
import { generator, GENERATOR_PRESET, PRESETS } from './physics/presets';
import {
  addBody, AUTO_WORKER_BODIES, bump, cursor, ghost, history, launchProbe, loadPreset, loadSave, removeBody, rewindTo, SERIES, startTwin, stopTwin,
  timeline, toSave, touch, TYPE_NAMES, useStore, world, type CollisionMode, type PhysicsThread, type SeriesKey,
} from './sim';
import { deleteSave, getSave, listSaves, putSave } from './storage';

const fmt = (n: number) =>
  !Number.isFinite(n) ? '–' : n === 0 ? '0' : Math.abs(n) >= 1e4 || Math.abs(n) < 1e-2 ? n.toExponential(3) : n.toPrecision(5);

function Num(p: { label: string; value: number; min?: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="row">
      <span>{p.label}</span>
      <input
        type="number"
        value={p.value}
        step={p.step ?? 'any'}
        min={p.min}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          // reject NaN and out-of-range input rather than feeding it to the integrator
          if (Number.isFinite(v) && (p.min === undefined || v >= p.min)) p.onChange(v);
        }}
      />
    </label>
  );
}

function Check(p: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row check">
      <input type="checkbox" checked={p.checked} onChange={(e) => p.onChange(e.target.checked)} />
      <span>{p.label}</span>
    </label>
  );
}

function Chart() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [key, setKey] = useState<SeriesKey>('drift');
  const stats = useStore((s) => s.stats);
  const finite = history[key].filter(Number.isFinite);
  const lo = Math.min(...finite), hi = Math.max(...finite);

  useEffect(() => {
    const c = ref.current!, g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = '#6fd3ff';
    g.lineWidth = 1.5;
    g.beginPath();
    let pen = false;
    history[key].forEach((d, i) => {
      if (!Number.isFinite(d)) return void (pen = false); // gap where the series has no value
      const x = (i / 239) * c.width;
      const y = hi > lo ? c.height - 3 - ((d - lo) / (hi - lo)) * (c.height - 6) : c.height / 2;
      pen ? g.lineTo(x, y) : g.moveTo(x, y);
      pen = true;
    });
    g.stroke();
  }, [stats, key, lo, hi]);

  return (
    <>
      <select value={key} onChange={(e) => setKey(e.target.value as SeriesKey)} aria-label="Chart quantity">
        {Object.entries(SERIES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      <canvas ref={ref} width={264} height={64} className="chart" aria-label={`${SERIES[key]} over the last 60 seconds`} />
      <div className="hint">
        {finite.length
          ? `last 60 s · min ${fmt(lo)} · max ${fmt(hi)}`
          : key === 'distance' ? 'Select a body other than the reference to plot this.' : 'Select a body to plot this.'}
      </div>
    </>
  );
}

function Inspector() {
  const id = useStore((s) => s.selectedId);
  const refId = useStore((s) => s.refId);
  const stats = useStore((s) => s.stats); // re-read live values at the 4 Hz sample rate
  const b = world.bodies.find((x) => x.id === id);
  if (!b) return <div className="hint">Click a body or pick one from the list.</div>;
  const edit = (f: () => void) => { f(); touch(); };
  return (
    <>
      <label className="row">
        <span>Name</span>
        {/* bump: a worker result in flight carries the old name and would overwrite this */}
        <input value={b.name} onChange={(e) => { b.name = e.target.value; bump(); }} />
      </label>
      <div className="row"><span>Type</span><b>{b.type}</b></div>
      <Num label="Mass" value={b.mass} min={1e-12} onChange={(v) => edit(() => (b.mass = v))} />
      <Num label="Radius" value={b.radius} min={0.01} onChange={(v) => edit(() => (b.radius = v))} />
      {(['x', 'y', 'z'] as const).map((ax, k) => (
        <Num key={ax} label={`v${ax}`} value={+b.vel[k].toPrecision(6)} onChange={(v) => edit(() => (b.vel[k] = v))} />
      ))}
      <div className="row"><span>Speed</span><b>{fmt(Math.hypot(...b.vel))}</b></div>
      <div className="row"><span>Position</span><b>{b.pos.map((x) => x.toFixed(1)).join(', ')}</b></div>
      <label className="row">
        <span>Reference</span>
        <select value={refId ?? ''} onChange={(e) => useStore.setState({ refId: e.target.value ? +e.target.value : null })}>
          <option value="">Heaviest body</option>
          {world.bodies.filter((x) => x !== b).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <div className="row"><span>Distance to ref.</span><b>{fmt(stats?.distance ?? NaN)}</b></div>
      <div className="row"><span>Speed rel. to ref.</span><b>{fmt(stats?.speed ?? NaN)}</b></div>
      <div className="hint">Pause before typing velocities; they change every step.</div>
      <button className="danger" onClick={() => removeBody(b.id)}>Remove body</button>
    </>
  );
}

/** Controls for the random-system preset. Every change rebuilds the system from the seed. */
function Generator() {
  const regen = (patch: Partial<typeof generator>) => {
    Object.assign(generator, patch);
    loadPreset(GENERATOR_PRESET);
  };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return (
    <div className="sub">
      <Num label="Seed" value={generator.seed} step={1} onChange={(v) => regen({ seed: Math.round(v) })} />
      <Num label="Planets (1–12)" value={generator.planets} min={1} step={1} onChange={(v) => regen({ planets: clamp(Math.round(v), 1, 12) })} />
      <Num label="Max eccentricity" value={generator.eccentricity} min={0} step={0.05} onChange={(v) => regen({ eccentricity: clamp(v, 0, 0.8) })} />
      <Num label="Max tilt (deg)" value={generator.inclination} min={0} step={1} onChange={(v) => regen({ inclination: clamp(v, 0, 45) })} />
      <Num label="Asteroids (0–1000)" value={generator.asteroids} min={0} step={50} onChange={(v) => regen({ asteroids: clamp(Math.round(v), 0, 1000) })} />
      <button onClick={() => regen({ seed: Math.floor(Math.random() * 1e6) })}>New random seed</button>
    </div>
  );
}

function ChaosLab() {
  const [eps, setEps] = useState(1e-6);
  const stats = useStore((s) => s.stats);
  const sep = stats ? 10 ** stats.twin : NaN;
  return (
    <details>
      <summary>Chaos lab: twin run</summary>
      <div className="hint">
        Runs a second copy of the system with one velocity nudged by a relative ε. White dots are the twin; white
        lines join each body to its twin. Plot “Twin runs” in the chart: a straight rising line is exponential divergence.
      </div>
      <Num label="Nudge ε" value={eps} min={1e-15} onChange={setEps} />
      <div className="row"><span>Separation now</span><b>{ghost ? fmt(sep) : '–'}</b></div>
      <div className="buttons">
        {/* setState({}) re-renders so the button label follows the module-level twin */}
        <button onClick={() => { ghost ? stopTwin() : startTwin(eps); useStore.setState({}); }}>
          {ghost ? 'Stop twin run' : 'Start twin run'}
        </button>
      </div>
      <div className="hint">The nudge goes to the selected body, or the first body if none is selected. Doubles the physics cost.</div>
    </details>
  );
}

function Launcher() {
  const id = useStore((s) => s.selectedId);
  const [speed, setSpeed] = useState(3);
  const [heading, setHeading] = useState(0);
  const from = world.bodies.find((b) => b.id === id);
  return (
    <details>
      <summary>Launch probe</summary>
      <div className="hint">
        Fires a near-massless probe from the selected body. Heading 0° is along the body’s orbital motion, 180° against it.
        Or <b>Shift-drag from any body</b> in the view: the arrow sets direction and speed, and a green line predicts
        the path (approximate; Esc cancels). Then plot “Selected: speed relative to reference” to see what a flyby does.
      </div>
      <Num label="Speed (rel. to body)" value={speed} min={0} step={0.5} onChange={setSpeed} />
      <Num label="Heading (deg)" value={heading} step={15} onChange={setHeading} />
      <div className="buttons">
        <button disabled={!from} onClick={() => from && launchProbe(from.id, speed, heading)}>
          {from ? `Launch from ${from.name}` : 'Select a body first'}
        </button>
      </div>
    </details>
  );
}

function Saves() {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  // every storage call funnels through here so a failure is shown, never swallowed
  const act = (job: () => Promise<string>) =>
    job().then(setMsg, (e) => setMsg(`Storage error: ${e?.message ?? e}`)).then(() => listSaves().then(setNames, () => {}));
  useEffect(() => { act(async () => ''); }, []);

  const key = name.trim();
  return (
    <>
      <div className="buttons">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this setup" aria-label="Save name" maxLength={40} />
        <button
          disabled={!key}
          onClick={() => act(async () => {
            await putSave(toSave(key));
            return `Saved "${key}"${names.includes(key) ? ' (replaced)' : ''}.`;
          })}
        >
          Save
        </button>
      </div>
      <ul className="saves">
        {names.map((n) => (
          <li key={n}>
            <span>{n}</span>
            <button onClick={() => act(async () => {
              const s = await getSave(n);
              if (!s) throw new Error(`"${n}" no longer exists.`);
              loadSave(s);
              return `Loaded "${n}" paused at t = ${s.time.toFixed(1)}.`;
            })}>Load</button>
            <button className="danger" aria-label={`Delete ${n}`} onClick={() => act(async () => { await deleteSave(n); return `Deleted "${n}".`; })}>×</button>
          </li>
        ))}
      </ul>
      <div className="hint" role="status">{msg || (names.length ? '' : 'Saves the current bodies and settings in this browser.')}</div>
    </>
  );
}

export function Panel() {
  const s = useStore();
  const [type, setType] = useState<BodyType>('planet');
  const set = useStore.setState;
  const st = s.stats;

  return (
    <aside className="panel">
      <h1>ORBITAL</h1>

      <section>
        <h2>Experiment</h2>
        <select value={s.preset} onChange={(e) => loadPreset(+e.target.value)} aria-label="Experiment preset">
          {PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
        </select>
        <div className="hint">{PRESETS[s.preset].note}</div>
        {s.preset === GENERATOR_PRESET && <Generator />}
        <div className="buttons">
          <button onClick={() => set({ running: !s.running })} disabled={s.unstable}>{s.running ? 'Pause' : 'Resume'}</button>
          <button onClick={() => loadPreset(s.preset)}>Reset</button>
        </div>
        <label className="row scrub">
          <span>Rewind</span>
          <input
            type="range"
            min={0}
            max={Math.max(timeline.length - 1, 0)}
            value={cursor ?? timeline.length - 1}
            disabled={timeline.length < 2}
            onChange={(e) => rewindTo(+e.target.value)}
          />
        </label>
        <div className="hint">
          {cursor === null
            ? `Recorded t = ${timeline[0]?.time.toFixed(1)} to ${timeline.at(-1)?.time.toFixed(1)}`
            : `At t = ${timeline[cursor].time.toFixed(1)}. Resume to continue from here; the later recording is discarded.`}
        </div>
      </section>

      <section>
        <h2>Simulation</h2>
        <label className="row">
          <span>Integrator</span>
          <select value={s.integrator} onChange={(e) => set({ integrator: e.target.value as Integrator })}>
            <option value="verlet">Velocity Verlet</option>
            <option value="euler">Euler (for comparison)</option>
          </select>
        </label>
        <Num label="Time step dt" value={s.dt} min={1e-6} step={0.001} onChange={(dt) => set({ dt })} />
        <label className="row">
          <span>Steps / frame</span>
          <input type="range" min={1} max={100} value={s.speed} onChange={(e) => set({ speed: +e.target.value })} />
          <b className="narrow">{s.speed}</b>
        </label>
        <Num label="G" value={s.G} min={0} step={0.1} onChange={(G) => { set({ G }); touch(); }} />
        <Num label="Softening ε" value={s.softening} min={0} step={0.01} onChange={(softening) => { set({ softening }); touch(); }} />
        <label className="row">
          <span>Collisions</span>
          <select value={s.collisions} onChange={(e) => set({ collisions: e.target.value as CollisionMode })}>
            <option value="merge">Merge (inelastic)</option>
            <option value="bounce">Bounce (elastic)</option>
            <option value="off">Off (pass through)</option>
          </select>
        </label>
        <label className="row">
          <span>Physics thread</span>
          <select value={s.thread} onChange={(e) => set({ thread: e.target.value as PhysicsThread })}>
            <option value="auto">Auto (worker from {AUTO_WORKER_BODIES} bodies)</option>
            <option value="main">Main thread</option>
            <option value="worker">Web Worker</option>
          </select>
        </label>
        <Check label="Orbit trails" checked={s.showTrails} onChange={(showTrails) => set({ showTrails })} />
        <Check label="Velocity vectors (green)" checked={s.showVelocity} onChange={(showVelocity) => set({ showVelocity })} />
        <Check label="Gravity vectors (orange, log length)" checked={s.showForce} onChange={(showForce) => set({ showForce })} />
        <Check label="Bloom (turn off if FPS drops)" checked={s.bloom} onChange={(bloom) => set({ bloom })} />
      </section>

      <section>
        <h2>Analytics</h2>
        {s.unstable && <div className="warn">Non-finite state: simulation halted. Reset, then lower dt or raise softening.</div>}
        {st && st.drift > 0.01 && !s.unstable && (
          <div className="warn">Energy error above 1%. Results are not trustworthy at this dt / integrator.</div>
        )}
        {st && (
          <dl>
            <dt>Kinetic</dt><dd>{fmt(st.kinetic)}</dd>
            <dt>Potential</dt><dd>{fmt(st.potential)}</dd>
            <dt>Total energy</dt><dd>{fmt(st.energy)}</dd>
            <dt>|Momentum|</dt><dd>{fmt(st.momentum)}</dd>
            <dt>|Angular mom.|</dt><dd>{fmt(st.angularMomentum)}</dd>
            <dt>Energy error</dt><dd>{fmt(st.drift)}</dd>
            <dt>Sim time</dt><dd>{st.time.toFixed(1)}</dd>
            <dt>FPS · physics</dt><dd>{st.fps.toFixed(0)} · {st.stepMs.toFixed(2)} ms {st.onWorker ? '(worker)' : '(main)'}</dd>
          </dl>
        )}
        <Chart />
      </section>

      <section>
        <h2>Bodies ({world.bodies.length})</h2>
        <ul className="bodies">
          {world.bodies.map((b) => (
            <li key={b.id}>
              <button className={b.id === s.selectedId ? 'on' : ''} onClick={() => set({ selectedId: b.id })}>
                <i style={{ background: b.color }} />{b.name}<small>{b.type}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="buttons">
          <select value={type} onChange={(e) => setType(e.target.value as BodyType)} aria-label="New body type">
            {TYPE_NAMES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <button onClick={() => addBody(type)}>Add</button>
        </div>
      </section>

      <section>
        <h2>Inspector</h2>
        <Inspector />
      </section>

      <section>
        <h2>Labs</h2>
        <ChaosLab />
        <Launcher />
      </section>

      <section>
        <h2>Saved setups</h2>
        <Saves />
      </section>
    </aside>
  );
}
