// Physics off the main thread. Runs the same `run` as the main thread, so results match exactly.
import { run, type Job, type JobResult } from './engine';

// typed structurally: the DOM lib's `self` is a Window, whose postMessage needs a target origin
const scope = self as unknown as { onmessage: (e: MessageEvent<Job>) => void; postMessage: (r: JobResult) => void };

scope.onmessage = ({ data: job }) => {
  const t0 = performance.now();
  const merged = run(job.world, job.twin, job.params);
  scope.postMessage({ ...job, merged, ms: performance.now() - t0 });
};
