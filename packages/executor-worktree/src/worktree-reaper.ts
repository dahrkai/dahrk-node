/**
 * Worktree reaper (DHK-371).
 *
 * The edge creates one git worktree per run and, before this, never removed any of them: the only
 * teardown path was an LRU retention pass that (a) was disabled unless an operator set a policy, and
 * (b) consulted an IN-MEMORY map, so every worktree created by a previous process was orphaned for
 * ever. On one node that reached 92 registered worktrees and 65 GB.
 *
 * The hub -> edge protocol has a `run-finished` frame, but it is best-effort and no hub sends it yet,
 * so the edge cannot rely on being told when a run is over. This reaper is therefore the primary
 * mechanism, and it is deliberately built to be restart-safe: it reconciles what is ON DISK and what
 * git has REGISTERED, never process-local state.
 *
 * What it must NOT do is mistake "idle" for "over" (DHK-1045). Idleness is measured from the last time
 * a stage touched the worktree, so a run parked at a human gate looks identical to a finished one, and
 * collecting it strands the deliver that follows the approval. `isLive` marks the runs this node still
 * holds a worktree for, and idleness simply does not apply to them - the count cap and a restart are
 * what bound their disk.
 *
 * It also clears the two things that wedge future runs:
 *   - a stale worktree registration keeps claiming its branch name for ever, so the next run of the
 *     same issue cannot `worktree add` that branch;
 *   - a worktree whose branch ref was deleted under it has an unborn HEAD and can never be reused.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUN_SCRATCH_DIR_NAME, runIdOfWorktreePath } from "./worktree-layout.js";

/** Milliseconds. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface ReapPolicy {
  /** Keep at most this many worktrees; the idlest are reaped first. */
  maxRuns?: number;
  /** Reap a worktree idle for longer than this. */
  maxIdleMs?: number;
  /**
   * Never reap a worktree touched more recently than this, whatever else says. This is the only guard
   * against reaping a live run belonging to ANOTHER node process sharing the same worktrees dir (there
   * is no IPC between them), so it must stay comfortably longer than the longest plausible stage.
   */
  activityGraceMs?: number;
  /**
   * Expire a parked salvage ref (`refs/dahrk/salvage/*`) this long after it was parked. These are the
   * insurance `salvageOrphanedTip` writes before a run branch is reset away; they must live long enough
   * for an operator to notice lost work and recover it, but be bounded so they cannot accumulate for
   * ever. Aged by the ref's own park time, never the pointed-to commit's date (a branch can hold a
   * commit authored days before it is parked), so a just-parked ref always survives.
   */
  salvageTtlMs?: number;
  /** Report what would be reaped, change nothing. */
  dryRun?: boolean;
}

export type ReapReason =
  | "broken"
  | "idle"
  | "over-count"
  /** An idle run left in the pre-DHK-358 flat layout (`<worktreesDir>/<runId>` with no repo
   *  subdirectory). Collected on exactly the same terms as any other idle run - this reason exists so
   *  an upgraded node's first sweeps say WHY, not to change what happens. */
  | "legacy-layout";

export interface ReapedWorktree {
  runId: string;
  path: string;
  reason: ReapReason;
}

export interface ReapReport {
  scanned: number;
  reaped: ReapedWorktree[];
  /** Skipped because busy, or inside the activity grace. */
  skipped: number;
  /**
   * Parked salvage refs (`refs/dahrk/salvage/*`) STILL on disk after this pass. Surfaced so the count
   * of recoverable-but-not-yet-expired run-branch tips is visible somewhere a human already looks,
   * rather than only in the one-shot warn at park time.
   */
  salvagedRefs: number;
  errors: string[];
}

export interface ReaperOptions {
  worktreesDir: string;
  mirrorsDir: string;
  /** True while a run is executing a stage on this node. A busy run is never reaped. */
  isBusy?: (runId: string) => boolean;
  /** True while this node holds a worktree for a run it has not seen finish - which includes every run
   *  parked at a human gate, waiting on auth, or between stages. Such a run is not busy (no job is in
   *  flight) but its worktree is still load-bearing: deliver will push from it. Held to
   *  `liveRunMaxIdleMs` rather than `maxIdleMs`. Process-local by design, so a restart still hands the
   *  whole disk back to the reaper (DHK-1045). */
  isLive?: (runId: string) => boolean;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

const DEFAULTS: Required<Omit<ReapPolicy, "dryRun">> = {
  // Deliberately non-optional defaults. "No policy configured" used to mean "never collect anything",
  // which is precisely how the disk reached 65 GB. Absent config must mean sane collection, not none.
  maxRuns: 20,
  maxIdleMs: 6 * HOUR,
  activityGraceMs: 30 * MINUTE,
  // 14 days: long enough that an operator who missed the park log can still recover unpushed work, but
  // bounded so parked tips cannot pile up for ever. Cited verbatim in docs/logging.md - keep in step.
  salvageTtlMs: 14 * DAY,
};

const noop = { info: () => {}, warn: () => {} };

const gitOk = (cwd: string, args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
};
const gitOut = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" });

/**
 * Canonicalise a path so the two sources of truth agree. `readdir` yields the path as configured (e.g.
 * `/var/folders/...` on macOS, or any symlinked worktrees dir), while git reports the fully resolved one
 * (`/private/var/folders/...`). Without this they do not dedupe: the same worktree is counted twice,
 * which breaks the count cap and makes the reaper try to remove it twice.
 */
const canonical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p; // already deleted: the raw path is the best we have, and removal is a no-op anyway
  }
};

/**
 * The last time a run actually did anything, as a durable on-disk clock. `.dahrk/scratch/state.json`
 * is rewritten by the stage runner on every stage entry and exit, so its mtime survives a process
 * restart (which the in-memory map did not).
 *
 * Takes the NEWEST of every candidate - the run-level scratch, each worktree's own (the legacy layout
 * kept it inside the worktree), the run directory and the worktrees themselves. Over-estimating
 * recency is the safe direction: it can delay a collection, never cause one. Under-estimating reaps a
 * live run.
 */
function lastUsedMs(runDir: string, worktrees: readonly string[]): number {
  const candidates = [
    join(runDir, ".dahrk", "scratch", "state.json"),
    ...worktrees.map((w) => join(w, ".dahrk", "scratch", "state.json")),
    runDir,
    ...worktrees,
  ];
  let newest = 0;
  for (const p of candidates) {
    try {
      newest = Math.max(newest, statSync(p).mtimeMs);
    } catch {
      /* missing: ignore */
    }
  }
  return newest;
}

/** Worktrees each mirror has registered, including ones whose directory is already gone. */
function registeredWorktrees(mirror: string): string[] {
  let out: string;
  try {
    out = gitOut(mirror, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => canonical(l.slice(9).trim()))
    .filter((p) => p && p !== canonical(mirror));
}

/**
 * When a salvage ref was parked. Its own on-disk write time (the loose-ref file mtime) is the park
 * time - consistent with how `lastUsedMs` above ages worktrees, and correct where `committerdate` is
 * not: a branch can hold a commit authored days before it is parked, so committer date would expire a
 * just-parked ref immediately and destroy the very insurance it exists for. Falls back to the ref's
 * reflog timestamp for a packed ref with no loose file, and returns undefined when it cannot be dated
 * at all - the caller then never expires it (fail safe: do not destroy an undatable insurance ref).
 */
function salvageParkedMs(mirror: string, ref: string): number | undefined {
  try {
    return statSync(join(mirror, ref)).mtimeMs;
  } catch {
    /* packed or otherwise no loose file: fall back to the reflog */
  }
  try {
    const ts = gitOut(mirror, ["log", "-g", "--format=%ct", "-1", ref]).trim();
    if (ts) return Number(ts) * 1000;
  } catch {
    /* no reflog for this ref */
  }
  return undefined;
}

/**
 * Expire parked salvage refs older than `ttlMs` and return how many are STILL parked afterwards. A ref
 * that cannot be dated is never expired and counts as still parked. In `dryRun` nothing is deleted and
 * every ref counts as parked, but the ones that would go are logged.
 */
function sweepSalvageRefs(
  mirror: string,
  ttlMs: number,
  dryRun: boolean,
  now: number,
  log: { info: (m: string) => void; warn: (m: string) => void },
): number {
  let refs: string[];
  try {
    refs = gitOut(mirror, ["for-each-ref", "--format=%(refname)", "refs/dahrk/salvage/"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return 0;
  }
  let parked = 0;
  for (const ref of refs) {
    const at = salvageParkedMs(mirror, ref);
    const expired = at !== undefined && now - at > ttlMs;
    if (expired && !dryRun) {
      if (!gitOk(mirror, ["update-ref", "-d", ref])) log.warn(`reaper: could not expire salvage ref ${ref}`);
      continue;
    }
    if (expired) log.info(`reaper (dry-run): would expire salvage ref ${ref}`);
    parked++;
  }
  return parked;
}

export function createWorktreeReaper(opts: ReaperOptions) {
  const log = opts.logger ?? noop;
  const mirrors = (): string[] => {
    try {
      return readdirSync(opts.mirrorsDir)
        .map((d) => join(opts.mirrorsDir, d))
        .filter((m) => gitOk(m, ["rev-parse", "--git-dir"]));
    } catch {
      return [];
    }
  };

  /** Which mirror owns a worktree path (needed to remove it); undefined when nothing claims it. */
  const ownerOf = (worktreePath: string, all: Map<string, string[]>): string | undefined => {
    for (const [mirror, paths] of all) if (paths.includes(worktreePath)) return mirror;
    return undefined;
  };

  return {
    async reap(policy: ReapPolicy = {}): Promise<ReapReport> {
      const maxRuns = policy.maxRuns ?? DEFAULTS.maxRuns;
      const maxIdleMs = policy.maxIdleMs ?? DEFAULTS.maxIdleMs;
      const graceMs = policy.activityGraceMs ?? DEFAULTS.activityGraceMs;
      const salvageTtlMs = policy.salvageTtlMs ?? DEFAULTS.salvageTtlMs;
      const dryRun = policy.dryRun ?? false;
      const report: ReapReport = { scanned: 0, reaped: [], skipped: 0, salvagedRefs: 0, errors: [] };
      const now = Date.now();

      // Prune first: drops admin entries whose directory has already vanished, so a hand-deleted
      // worktree stops claiming its branch name. This alone fixes a class of "already used by
      // worktree" failures.
      const registered = new Map<string, string[]>();
      for (const m of mirrors()) {
        gitOk(m, ["worktree", "prune"]);
        registered.set(m, registeredWorktrees(m));
      }

      // Candidates = what git still has registered, UNION what is on disk. The union matters: a
      // worktree whose mirror was deleted is invisible to git but still occupies the disk.
      // Two levels, because a run directory now CONTAINS its repos' worktrees rather than being one
      // (DHK-358). The discriminator is a `.git` entry: a linked worktree always has one (a FILE
      // pointing at `<mirror>/worktrees/<id>`), and a run directory never does. That is what lets an
      // upgraded node read its own legacy flat directories and the new nested ones in the same sweep.
      const onDiskRunDirs: string[] = [];
      const onDisk = (() => {
        const out: string[] = [];
        let top: string[];
        try {
          top = readdirSync(opts.worktreesDir);
        } catch {
          return out;
        }
        for (const d of top) {
          const runDir = join(opts.worktreesDir, d);
          onDiskRunDirs.push(canonical(runDir));
          if (existsSync(join(runDir, ".git"))) {
            out.push(canonical(runDir)); // legacy flat: the run directory IS the worktree
            continue;
          }
          try {
            for (const child of readdirSync(runDir)) {
              // `.dahrk` is the run's shared scratch, not a repo.
              if (child === RUN_SCRATCH_DIR_NAME) continue;
              out.push(canonical(join(runDir, child)));
            }
          } catch {
            /* unreadable: the run directory still counts, via onDiskRunDirs */
          }
        }
        return out;
      })();
      // Both sides canonicalised, so the same worktree from `readdir` and from git dedupes to one entry.
      const worktreePaths = [...new Set([...onDisk, ...[...registered.values()].flat()])];

      // Group every worktree by the RUN it belongs to (DHK-251/DHK-358). A run is the unit of
      // collection now: its repos share a directory and a scratch, so they live and die together.
      // Anything whose runId cannot be derived is not ours - leave it, never guess.
      type Entry = {
        runId: string;
        runDir: string;
        worktrees: Array<{ path: string; mirror?: string }>;
        idleMs: number;
        live: boolean;
        broken: boolean;
        legacy: boolean;
      };
      const byRun = new Map<string, { runDir: string; worktrees: Array<{ path: string; mirror?: string }>; legacy: boolean }>();
      for (const path of worktreePaths) {
        report.scanned++;
        const runId = runIdOfWorktreePath(opts.worktreesDir, path);
        if (runId === undefined) continue;
        const runDir = canonical(join(opts.worktreesDir, runId));
        // Flat = the worktree IS the run directory, which is what the pre-DHK-358 layout produced.
        const legacy = canonical(path) === runDir;
        const mirror = ownerOf(path, registered);
        const entry = byRun.get(runId) ?? { runDir, worktrees: [], legacy };
        entry.legacy = entry.legacy || legacy;
        entry.worktrees.push({ path, ...(mirror ? { mirror } : {}) });
        byRun.set(runId, entry);
      }
      // A run directory with no worktree under it at all (the agent's checkout was hand-deleted, or a
      // provisioning failure left the shell) is still a run's worth of disk, and still ours to collect.
      for (const d of onDiskRunDirs) {
        const runId = runIdOfWorktreePath(opts.worktreesDir, d);
        if (runId !== undefined && !byRun.has(runId)) {
          byRun.set(runId, { runDir: canonical(join(opts.worktreesDir, runId)), worktrees: [], legacy: false });
        }
      }

      const entries: Entry[] = [];
      for (const [runId, r] of byRun) {
        if (opts.isBusy?.(runId)) {
          report.skipped++;
          continue;
        }
        const idleMs = now - lastUsedMs(r.runDir, r.worktrees.map((w) => w.path));
        if (idleMs < graceMs) {
          // Might belong to a live run in another process. Never touch it.
          report.skipped++;
          continue;
        }
        // Broken = the run has no usable worktree left: none of them can resolve HEAD. Deliberately
        // "every", not "any" - collecting a three-repo run because ONE worktree lost its branch ref
        // would destroy the other two repos' uncommitted work, which is worse than leaving one dud
        // directory on disk until the idle sweep takes the whole run.
        const usable = r.worktrees.filter(
          (w) => existsSync(w.path) && gitOk(w.path, ["rev-parse", "--verify", "-q", "HEAD"]),
        );
        const broken = usable.length === 0;
        if (r.worktrees.length > 0 && usable.length > 0 && usable.length < r.worktrees.length) {
          log.warn(
            `reaper: run ${runId} has ${r.worktrees.length - usable.length} unusable worktree(s) of ` +
              `${r.worktrees.length}; keeping the run so the healthy ones are not destroyed with it`,
          );
        }
        // A run this node has not seen finish is EXEMPT FROM IDLENESS ENTIRELY, because idleness cannot
        // distinguish it from a finished one: it is idle between every pair of stages and for the whole
        // of a human gate. No ceiling is guessed here - a longer one would only move the cliff, not
        // remove it. `broken` and the count cap still apply.
        const live = opts.isLive?.(runId) ?? false;
        entries.push({ runId, runDir: r.runDir, worktrees: r.worktrees, idleMs, live, broken, legacy: r.legacy });
      }

      // Idlest first, so the over-count sweep evicts the least recently useful.
      entries.sort((a, b) => b.idleMs - a.idleMs);
      const keep = entries.filter((e) => !e.broken && (e.live || e.idleMs <= maxIdleMs));
      const doomed: Array<Entry & { reason: ReapReason }> = [];
      for (const e of entries) {
        if (e.broken) doomed.push({ ...e, reason: "broken" });
        else if (!e.live && e.idleMs > maxIdleMs) doomed.push({ ...e, reason: "idle" });
      }
      // Then trim whatever survives down to maxRuns, idlest first.
      const survivors = keep.filter((e) => !doomed.some((d) => d.runId === e.runId));
      for (const e of survivors.slice(0, Math.max(0, survivors.length - maxRuns))) {
        doomed.push({ ...e, reason: "over-count" });
      }

      for (const d of doomed) {
        // A legacy flat directory is named in the log so an upgraded node's first sweeps are readable;
        // it is otherwise collected on exactly the same terms as any other run. Deliberately NOT
        // force-deleted at boot regardless of age: a node upgraded while a run sat at a human gate
        // would lose that run's work, and the grace window plus the idle threshold already gate this
        // correctly.
        const reason: ReapReason = d.legacy && d.reason === "idle" ? "legacy-layout" : d.reason;
        if (dryRun) {
          log.info(`reaper (dry-run): would reap ${d.runId} (${reason}, idle ${Math.round(d.idleMs / MINUTE)}m)`);
          for (const w of d.worktrees) report.reaped.push({ runId: d.runId, path: w.path, reason });
          continue;
        }
        try {
          // Remove via the owning mirror where known, so the ADMIN ENTRY goes too (an `rm -rf` alone
          // leaves the registration, and the registration is what blocks the next run of that issue).
          for (const w of d.worktrees) {
            if (w.mirror) gitOk(w.mirror, ["worktree", "remove", "--force", w.path]);
            rmSync(w.path, { recursive: true, force: true });
            if (w.mirror) gitOk(w.mirror, ["worktree", "prune"]);
            report.reaped.push({ runId: d.runId, path: w.path, reason });
          }
          // ONE delete for the whole run, which takes the shared scratch with it. This is what makes
          // teardown a run-level operation rather than N worktree-level ones that leave the shell.
          rmSync(d.runDir, { recursive: true, force: true });
          if (d.worktrees.length === 0) report.reaped.push({ runId: d.runId, path: d.runDir, reason });
        } catch (e) {
          report.errors.push(`${d.runId}: ${(e as Error).message}`);
        }
      }

      if (report.reaped.length) {
        log.info(`reaper: reaped ${report.reaped.length} worktree(s), skipped ${report.skipped}`);
      }

      // Expire and count parked run-branch tips. This is the observability half of DHK-481: the count is
      // reported on every pass (not just the one-shot warn at park time), and a stale ref is actually
      // collected on the TTL the docs promise. `registered` already holds every live mirror.
      for (const m of registered.keys()) {
        report.salvagedRefs += sweepSalvageRefs(m, salvageTtlMs, dryRun, now, log);
      }
      if (report.salvagedRefs) {
        log.info(
          `reaper: ${report.salvagedRefs} salvage ref(s) parked, expire ${Math.round(salvageTtlMs / DAY)}d after parking`,
        );
      }
      return report;
    },
  };
}
