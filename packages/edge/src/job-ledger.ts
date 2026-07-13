/**
 * The node's durable record of what it is currently running (DHK-416).
 *
 * Until this existed the node held its in-flight set (`running`) and its finished-result cache
 * (`lastResults`) in process memory ONLY, so a node restart mid-stage lost the work outright: the agent
 * was killed, the result was never sent, and the hub's next re-arm tick re-dispatched the same jobId to
 * a node that had neither the de-dup guard nor the cached result. The stage silently re-ran from
 * scratch, re-billing hours of agent work. Boot already reclaimed leaked worktrees (DHK-371), which
 * recovered disk but never jobs.
 *
 * The ledger closes that hole from the edge side. It is written through on every job/push start and
 * finish, so after a crash the next boot can read what the previous process owned and act on it:
 *
 *  - announce the jobs that are genuinely still running in `hello.inFlightJobs`, so the hub ADOPTS them
 *    instead of re-dispatching (DHK-415);
 *  - reconcile the ones that died with the process, leaving a clean worktree behind.
 *
 * `payloadVersion` is the load-bearing field. The hub's adoption gate calls `isPayloadVersionSupported`
 * on what we announce, and treats an absent or malformed version as UNSUPPORTED: it kills the row and
 * re-dispatches. So a job we announce without its version is strictly worse than one we do not announce
 * at all. It arrives on the inbound `JobRequest` and must survive the restart, which is why it is here
 * and not merely in memory.
 *
 * Durability is deliberately modest. This is a crash-recovery hint, not a transaction log: the hub's
 * `dispatch` ledger (DHK-414) remains the authority on what is in flight, and a lost or corrupt file
 * degrades us to exactly the pre-DHK-416 behaviour (lease lapses, reaper re-dispatches) rather than
 * wedging a boot. Hence: one small JSON file, an atomic replace, and a read that treats any unparseable
 * content as empty.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file holds no secret, but it sits in the same 0700 state dir as `node.json` (which does), and a
 *  worktree path is host detail we have no reason to widen. Match the neighbour rather than relax it. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** One in-flight job or push, as the owning process last knew it. */
export interface JobLedgerEntry {
  jobId: string;
  runId: string;
  /** `stage` for an agent stage, `push` for the deliver/open-PR push. Both cross the socket, both are
   *  de-duped against `running`, and both get a hub `dispatch` row, so both are ledgered. */
  kind: "stage" | "push";
  /** Absent on a push (which has no stage of its own; the hub records it under `deliver`). */
  stageId?: string;
  /** The `DISPATCH_PAYLOAD_VERSION` the dispatching hub build stamped on the JobRequest. Absent when
   *  the job came from a build predating DHK-415, in which case the hub's gate will refuse to adopt it -
   *  correctly, since we cannot prove the payload is one it can still read. */
  payloadVersion?: string;
  /** Where the run's worktree lives, so boot reconciliation can find the tree to clean. */
  worktreePath?: string;
  /** The run's branch, so a reconciled tail can be named and preserved. */
  branch?: string;
  /** The git url, needed to force-push a preserved tail to the real remote. */
  gitUrl?: string;
  /** Epoch ms this node started the job. */
  startedAt: number;
  /** The pid of the NODE process that owned this entry. It is how boot tells "a job this process is
   *  running" from "a job a previous process was running when it died"; it is NOT the agent's pid (the
   *  runner subprocess is owned by the SDK, which never surfaces it - see the boot reconciliation). */
  nodePid: number;
}

/** Reads and writes the node's in-flight job ledger. All methods are best-effort: a disk failure warns
 *  and is swallowed, because losing the ledger must degrade recovery, never break the run in hand. */
export interface JobLedger {
  /** Every entry on disk, including those written by a previous process. */
  all(): JobLedgerEntry[];
  /** Entries written by a PREVIOUS process, i.e. jobs that died with it. */
  stale(currentPid: number): JobLedgerEntry[];
  upsert(entry: JobLedgerEntry): void;
  remove(jobId: string): void;
  /** Drop every entry, whoever wrote it. Used once, after boot reconciliation has dealt with them. */
  clear(): void;
}

/** A ledger that persists nothing. The default for tests and embedders that never asked for one, and
 *  what the node falls back to if no path is configured: the pre-DHK-416 behaviour, explicitly. */
export function nullJobLedger(): JobLedger {
  return { all: () => [], stale: () => [], upsert: () => {}, remove: () => {}, clear: () => {} };
}

const isEntry = (v: unknown): v is JobLedgerEntry => {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["jobId"] === "string" &&
    !!e["jobId"] &&
    typeof e["runId"] === "string" &&
    (e["kind"] === "stage" || e["kind"] === "push") &&
    typeof e["startedAt"] === "number" &&
    typeof e["nodePid"] === "number"
  );
};

/**
 * A ledger backed by one JSON file.
 *
 * Writes are atomic (write a temp sibling, then `rename`, which is atomic within a filesystem). A plain
 * `writeFileSync` over the live file would leave a truncated ledger if the node were killed mid-write -
 * and being killed mid-write is the exact scenario this file exists to survive, so the naive version
 * would fail precisely when it was needed.
 */
export function fileJobLedger(file: string, warn: (msg: string) => void = console.warn): JobLedger {
  const read = (): JobLedgerEntry[] => {
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Drop anything malformed rather than rejecting the whole file: one bad entry (a hand-edit, a
      // half-written record from an older client) must not cost us the good ones.
      return parsed.filter(isEntry);
    } catch {
      // A corrupt ledger reads as empty. The cost is that we announce nothing and the hub re-dispatches
      // from its own ledger - which is exactly the old behaviour, and vastly better than a wedged boot.
      return [];
    }
  };

  const write = (entries: JobLedgerEntry[]): void => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE });
      writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: FILE_MODE });
      // `mode` only applies when writeFileSync CREATES the file, so tighten explicitly for the case
      // where a temp file from a previous pid is being overwritten.
      chmodSync(tmp, FILE_MODE);
      renameSync(tmp, file);
    } catch (e) {
      warn(`could not persist the job ledger to ${file}: ${(e as Error).message}`);
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // Nothing useful left to do; the stale temp is inert.
      }
    }
  };

  return {
    all: read,
    stale: (currentPid) => read().filter((e) => e.nodePid !== currentPid),
    upsert(entry) {
      write([...read().filter((e) => e.jobId !== entry.jobId), entry]);
    },
    remove(jobId) {
      const next = read().filter((e) => e.jobId !== jobId);
      write(next);
    },
    clear() {
      write([]);
    },
  };
}

/**
 * Project the in-flight set onto what `hello.inFlightJobs` may carry.
 *
 * The filter is the whole point, and it is a safety property rather than tidiness. The hub runs
 * `isPayloadVersionSupported` over whatever we announce and treats an absent or malformed version as
 * UNSUPPORTED: it marks the dispatch dead, sends a `cancel`, and fails the awakeable. So announcing a job
 * we cannot version-stamp does not merely fail to get it adopted, it KILLS a stage that is running
 * perfectly well. Staying silent about it instead leaves the hub's lease to lapse and the stage to be
 * re-dispatched, which is the pre-DHK-416 behaviour and strictly better than killing it.
 *
 * In practice this drops exactly two things: a push (`PushJob` carries no version) and a stage dispatched
 * by a hub build older than DHK-415.
 */
export function announceableJobs(entries: Iterable<JobLedgerEntry>): Array<{ jobId: string; payloadVersion: string }> {
  const out: Array<{ jobId: string; payloadVersion: string }> = [];
  for (const e of entries) {
    if (e.payloadVersion) out.push({ jobId: e.jobId, payloadVersion: e.payloadVersion });
  }
  return out;
}

/** Where the ledger lives, given the node's state dir. A sibling of `node.json`, not a field inside it:
 *  `node.json` holds slow-moving identity that is read on every `dahrk status`, while this churns on
 *  every job start and finish, and its reader deliberately allowlists scalar fields. */
export function jobLedgerFile(stateDir: string): string {
  return join(stateDir, "jobs.json");
}
