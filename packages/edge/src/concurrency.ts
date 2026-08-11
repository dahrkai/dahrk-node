/**
 * A node's concurrent-stage admission bound (DHK-1137).
 *
 * A node used to take whatever the hub dispatched to it: nothing capped how many stages ran at once,
 * and nothing said "I am full". On a laptop - the default node - that is invisible until everything is
 * slow together: four agent stages plus check stages in one five-minute window saturate CPU and disk,
 * every turn drifts longer, and a stage that would have finished comfortably drifts into a watchdog
 * window. This module gives a node a bounded, observable capacity so it queues work past the bound
 * rather than degrading silently.
 *
 * Two pieces, both pure and free of the socket:
 *  - {@link resolveMaxConcurrentStages} decides what the bound is (CPU-derived, env-tunable).
 *  - {@link createStageLimiter} is the bound itself: a FIFO admission semaphore with observable load.
 *
 * The bound is node-wide and counts EVERY stage job as one slot - agent and check alike - because both
 * saturate a laptop and the evidence was a mix of the two. Pushes and control frames are cheap and stay
 * unbounded (see the wiring in `ws-client.ts`).
 */

/** The operator's override. Read directly from `process.env` in the package, the same way
 *  `DAHRK_BATCH_STALL_MS` and `DAHRK_REAPER_DRY_RUN` are, so it needs no plumbing through the CLI. */
export const MAX_CONCURRENT_STAGES_ENV = "DAHRK_MAX_CONCURRENT_STAGES";

/** The lowest the derived default is allowed to fall: two stages at once keeps ordinary single- and
 *  multi-run overlap working unchanged, even on a 1- or 2-core box. The env var can still go lower. */
export const MIN_CONCURRENT_STAGES = 2;

/**
 * Resolve the node's stage-concurrency bound.
 *
 * A positive-integer `DAHRK_MAX_CONCURRENT_STAGES` wins outright - the operator's escape hatch, allowed
 * both below the floor (a tiny box) and above the derived default (a big one). Anything else - absent,
 * zero, negative, fractional, unparseable - is ignored in favour of the derived default
 * `max(2, floor(cores / 4))`: a garbage value must never wedge a node at zero capacity or crash it.
 */
export function resolveMaxConcurrentStages(env: NodeJS.ProcessEnv, cpuCount: number): number {
  const raw = env[MAX_CONCURRENT_STAGES_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const override = Number(raw);
    if (Number.isInteger(override) && override > 0) return override;
  }
  return Math.max(MIN_CONCURRENT_STAGES, Math.floor(cpuCount / 4));
}

/** A FIFO admission semaphore: the first `max` `acquire()`s resolve at once, the rest wait for a slot. */
export interface StageLimiter {
  /** Take a slot. Resolves immediately while `inUse() < max`; otherwise queues and resolves when a
   *  later `release()` frees a slot, oldest waiter first. */
  acquire(): Promise<void>;
  /** Give a slot back. Wakes the oldest waiter if any is queued, else lowers the in-use count. */
  release(): void;
  /** Slots currently held (running stages). */
  inUse(): number;
  /** Callers waiting for a slot (stages queued past the bound). */
  queued(): number;
  /** The bound this limiter enforces. */
  readonly max: number;
}

/**
 * Build the node's admission semaphore.
 *
 * `acquire()` while below the bound resolves synchronously, so a node under its cap behaves exactly as
 * it did before this existed. At the bound, `acquire()` parks the caller in a FIFO queue; `release()`
 * hands the freed slot to the oldest waiter, which keeps a queued job from being starved by a burst of
 * newer arrivals. Waking exactly one waiter per release is what keeps the bound a bound.
 */
export function createStageLimiter({ max }: { max: number }): StageLimiter {
  let inUse = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (inUse < max) {
        inUse++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release(): void {
      const next = waiters.shift();
      if (next) next();
      // The slot stays held: it passes straight to the woken waiter, so `inUse` is unchanged. Only when
      // nobody is queued does a release actually lower the count.
      else if (inUse > 0) inUse--;
    },
    inUse: () => inUse,
    queued: () => waiters.length,
    max,
  };
}
