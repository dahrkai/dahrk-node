/**
 * The node's admission bound (DHK-1137): a node accepts at most a CPU-derived number of concurrent
 * stage jobs and queues the rest, rather than taking whatever the hub dispatches into contention.
 *
 * Two seams live here, both pure and socket-free:
 *  - `resolveMaxConcurrentStages` - what the bound IS: derived from cores, tunable by env var.
 *  - `createStageLimiter` - the bound ITSELF: a FIFO admission semaphore with observable load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveMaxConcurrentStages, createStageLimiter } from "../src/concurrency.js";

// --- resolveMaxConcurrentStages: what the bound is ------------------------------------------------

// The default is derived from the host so a laptop and a server get different, sensible bounds without
// any configuration: floor(cores / 4), never below 2. On the 8-10 core laptop that piled four agent
// stages plus checks into one window, this is 2 - which would have stopped the pile-up.
test("the default is floor(cores / 4), across a range of hosts", () => {
  assert.equal(resolveMaxConcurrentStages({}, 8), 2);
  assert.equal(resolveMaxConcurrentStages({}, 16), 4);
  assert.equal(resolveMaxConcurrentStages({}, 32), 8);
});

// The floor of 2 keeps ordinary single- and multi-run overlap working unchanged on a tiny box; a
// 1- or 2-core host must still run two stages at once, not serialise everything.
test("the derived default never drops below a floor of 2", () => {
  assert.equal(resolveMaxConcurrentStages({}, 1), 2);
  assert.equal(resolveMaxConcurrentStages({}, 2), 2);
  assert.equal(resolveMaxConcurrentStages({}, 4), 2);
});

// An operator on a tiny box can take the bound below the floor, and one on a big box can raise it: the
// env var is the escape hatch the ticket asks for.
test("DAHRK_MAX_CONCURRENT_STAGES overrides the derived default", () => {
  assert.equal(resolveMaxConcurrentStages({ DAHRK_MAX_CONCURRENT_STAGES: "1" }, 32), 1);
  assert.equal(resolveMaxConcurrentStages({ DAHRK_MAX_CONCURRENT_STAGES: "10" }, 8), 10);
});

// A garbage override is ignored rather than obeyed: a `0`, a negative, or an unparseable value must not
// wedge a node at zero capacity (which would accept nothing) or crash it - it falls back to the derived
// default, the safe thing.
test("a non-positive or unparseable override falls back to the derived default", () => {
  assert.equal(resolveMaxConcurrentStages({ DAHRK_MAX_CONCURRENT_STAGES: "0" }, 8), 2);
  assert.equal(resolveMaxConcurrentStages({ DAHRK_MAX_CONCURRENT_STAGES: "-4" }, 8), 2);
  assert.equal(resolveMaxConcurrentStages({ DAHRK_MAX_CONCURRENT_STAGES: "abc" }, 8), 2);
  assert.equal(resolveMaxConcurrentStages({ DAHRK_MAX_CONCURRENT_STAGES: "" }, 8), 2);
  assert.equal(resolveMaxConcurrentStages({ DAHRK_MAX_CONCURRENT_STAGES: "2.5" }, 16), 4);
});

// --- createStageLimiter: the bound itself ---------------------------------------------------------

/** A microtask flush: enough to settle any `acquire()` that resolves synchronously, so a test can tell
 *  "resolved immediately" from "still queued" without an arbitrary timer. */
const tick = (): Promise<void> => Promise.resolve();

// Below the bound, admission is free: the first `max` acquires resolve without ever queuing, which is
// the property "existing single- and multi-stage behaviour is unchanged below the bound" turns on.
test("the first `max` acquires resolve immediately and never queue", async () => {
  const limiter = createStageLimiter({ max: 2 });
  await limiter.acquire();
  await limiter.acquire();
  assert.equal(limiter.inUse(), 2);
  assert.equal(limiter.queued(), 0);
  assert.equal(limiter.max, 2);
});

// The (max+1)th acquire does not resolve - it waits for a slot. That is the whole point: work past the
// bound queues rather than piling into contention.
test("an acquire past the bound stays pending until a slot frees", async () => {
  const limiter = createStageLimiter({ max: 1 });
  await limiter.acquire();

  let admitted = false;
  const pending = limiter.acquire().then(() => {
    admitted = true;
  });
  await tick();
  assert.equal(admitted, false, "the over-cap acquire is still waiting");
  assert.equal(limiter.inUse(), 1);
  assert.equal(limiter.queued(), 1);

  limiter.release();
  await pending;
  assert.equal(admitted, true, "releasing a slot woke the waiter");
  assert.equal(limiter.inUse(), 1, "the woken waiter now holds the slot");
  assert.equal(limiter.queued(), 0);
});

// A release wakes exactly ONE waiter, in arrival order. FIFO is what keeps a queued job from being
// starved by a burst of newer arrivals, and waking only one is what keeps the bound a bound.
test("release wakes exactly one waiter, in FIFO order", async () => {
  const limiter = createStageLimiter({ max: 1 });
  await limiter.acquire();

  const order: number[] = [];
  const first = limiter.acquire().then(() => order.push(1));
  const second = limiter.acquire().then(() => order.push(2));
  await tick();
  assert.equal(limiter.queued(), 2);

  limiter.release();
  await first;
  assert.deepEqual(order, [1], "only the oldest waiter woke");
  assert.equal(limiter.queued(), 1, "the newer waiter is still queued");

  limiter.release();
  await second;
  assert.deepEqual(order, [1, 2], "the waiters ran oldest-first");
});
