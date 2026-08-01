/**
 * The passive update check - "you are running an old client", said at the three moments you might hear it.
 *
 * `dahrk update` already exists, but it only helps someone who suspects they are behind. A node installed
 * as a service is started ONCE, ever, and then runs for months: it has no moment at which anyone would
 * think to ask. Always-on nodes rot quietly, and the more of them there are, the more quietly. So:
 *
 *   1. interactive `dahrk start` - notice, and offer to update there and then (a TTY, so we may ask);
 *   2. the running daemon - a `UPDATE_AVAILABLE:` line in the log, once a day (nobody to ask);
 *   3. `dahrk status` - from cache, so it stays offline.
 *
 * Nothing here ever updates by itself. A node that rewrites its own binary mid-Job, unattended, is a much
 * bigger promise than "tell me when I am stale", and it is not one this makes.
 *
 * Three properties matter more than the feature does, because an update check is exactly the sort of thing
 * that breaks the command it is bolted onto:
 *
 *  - It FAILS OPEN. Every failure - offline, DNS, a slow registry, a 500, a garbage body - is swallowed and
 *    means "no notice". A node must start on a plane, and npm having a bad day must never be able to stop
 *    one starting.
 *  - It is CACHED, not per-start. A crash-looping daemon restarts every ThrottleInterval; without the cache
 *    it would restart into a registry fetch every ten seconds, turning our outage into npm's.
 *  - It is BOUNDED. A short timeout, so the check can slow a start by at most that much.
 */
import type { NodeState } from "./state.js";
import { detectChannel, fetchLatestVersion, isNewer, upgradeCommand, type Channel } from "./update.js";

/** Check every six hours. Frequent enough that a running node's view of the registry is never more than a
 *  few hours old - which matters, because `dahrk status` reports what this check last learned, and a whole
 *  day of blind spot is a long time to be quietly telling someone they are current. Rare enough to remain
 *  invisible: one small GET per node per interval, jittered across a fleet. `DAHRK_UPDATE_CHECK_INTERVAL_MS`
 *  overrides (0 forces every start, which is how the tests and a curious operator get at it). */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How far past the check interval the cached answer stops being presented as fact.
 *
 *  Expressed as a multiple of the interval rather than as its own constant, so that overriding the interval
 *  moves both together: someone who checks hourly should hear about staleness sooner than someone who checks
 *  daily, and neither should have to discover a second knob to make that happen.
 *
 *  This was 4, which at the default interval put a green "up to date" tick on an answer up to a DAY old. A
 *  release published an hour after the last check was reported as "you are current" for the next twenty
 *  three - the exact failure the tick is supposed to rule out. Two intervals is the honest bound: one full
 *  interval to make the scheduled check, and one more of grace for a node that missed it (asleep, offline,
 *  a slow registry) before we stop vouching for the answer. Past that we still SHOW the cached answer, we
 *  just date it instead of blessing it. */
export const STALE_AFTER_INTERVALS = 2;

/** The check may delay a start by at most this. Deliberately short: nobody agreed to wait on npm to start
 *  their node, and the cost of missing a check is that we mention the update tomorrow instead. */
export const FETCH_TIMEOUT_MS = 1_500;

/** The bound for a check nobody is waiting on - the daemon's periodic one. {@link FETCH_TIMEOUT_MS} is
 *  short because it is spent in front of an operator watching a node start; the periodic check is spent in
 *  the background of a process that is already up, where the only cost of waiting is the wait itself and
 *  the cost of giving up too early is a missed release. A 1.5s bound is comfortable against a registry that
 *  answers in tens of milliseconds and hopeless against a congested link, which is precisely the case where
 *  an always-on node most needs the check to land. */
export const BACKGROUND_FETCH_TIMEOUT_MS = 15_000;

/** How many times per interval a scheduler should wake to CONSIDER a check. {@link shouldCheck} decides
 *  whether any given wake actually asks the registry, so this bounds only how late a due check can be, not
 *  how often one happens. It also sizes {@link CHECK_SKEW_TOLERANCE_MS}, because the two answer the same
 *  question from opposite sides: how early is a tick allowed to be. */
export const CHECK_TICKS_PER_INTERVAL = 4;

/** How much earlier than the interval a check is allowed to happen.
 *
 *  `updateCheckedAt` records when a check RESOLVED, which is necessarily later than the tick that started it
 *  - by a fetch's worth of milliseconds, or by seconds on a slow link. A scheduler that fires on the same
 *  period as {@link shouldCheck}'s gate therefore always arrives fractionally early, takes the not-due
 *  branch, and does nothing; the effective cadence silently halves. Callers should also schedule at a
 *  fraction of the interval (see `scheduleUpdateChecks`), but the gate carries its own tolerance so that no
 *  caller can reintroduce the bug by scheduling on the interval.
 *
 *  Capped at one tick's worth of the interval rather than at the interval itself: a tick can only ever be
 *  one tick-period early, and clamping to the full interval would drop the threshold to zero and turn a
 *  small interval into "check on every wake". */
export const CHECK_SKEW_TOLERANCE_MS = 60_000;

/** Environments where a version notice is noise at best and a broken pipe at worst. `CI` is the de-facto
 *  standard variable every CI provider sets; `NO_UPDATE_NOTIFIER` is the one the npm ecosystem already
 *  respects, so someone who has opted out globally is opted out here too without having to learn a new
 *  name; `DAHRK_NO_UPDATE_CHECK` is ours, for turning it off on a single node. */
export function checkSuppressed(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DAHRK_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI);
}

/** The interval, honouring the override. A non-numeric value falls back to the default rather than
 *  becoming NaN - which would compare false against everything and check on literally every start. */
export function checkIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.DAHRK_UPDATE_CHECK_INTERVAL_MS;
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS;
}

/** Is it time to ask the registry again? Pure: the caller supplies "now" and what the state file remembers.
 *  An unparseable or future-dated `checkedAt` (a clock that jumped, a hand-edited file) reads as "check
 *  now" - being a day early is harmless, whereas never checking again is the failure we are fixing.
 *
 *  The comparison is deliberately slack by {@link CHECK_SKEW_TOLERANCE_MS}: a timestamp written when a check
 *  RESOLVED is always a little later than the tick that began it, so an exact `>= intervalMs` turns any
 *  scheduler running on the interval into one running at half rate. Answering "yes" a minute early costs
 *  nothing; answering "no" forever is the bug. */
export function shouldCheck(
  now: number,
  checkedAt: string | undefined,
  intervalMs: number,
  env: NodeJS.ProcessEnv,
): boolean {
  if (checkSuppressed(env)) return false;
  if (!checkedAt) return true;
  const last = Date.parse(checkedAt);
  if (!Number.isFinite(last)) return true;
  // One tick's worth at most: a tick can only be one tick-period early, and clamping to the whole interval
  // would zero the threshold and make a small interval check on every wake.
  const tolerance = Math.min(CHECK_SKEW_TOLERANCE_MS, intervalMs / CHECK_TICKS_PER_INTERVAL);
  return now - last >= intervalMs - tolerance || last > now;
}

/** Spread a fleet's daily checks over an hour instead of firing them all on the same tick. One node makes
 *  no difference; a thousand nodes that all booted from the same image do. */
export function jitterMs(random: number, spreadMs = 60 * 60 * 1000): number {
  return Math.floor(random * spreadMs);
}

/** What the check found, when it found something worth saying. */
export interface UpdateAvailable {
  current: string;
  latest: string;
  channel: Channel;
}

/** The human-facing notice, and the daemon's machine-readable one. The daemon's line follows the
 *  `TAG:value` shape the edge client already uses (`EDGE_CONNECTED`, `JOB_STARTED:`), so it reads as part
 *  of the same log rather than as an intruder in it. */
export function renderUpdateNotice(u: UpdateAvailable): string {
  const cmd = upgradeCommand(u.channel);
  const how = cmd ? ` (${u.channel}: ${cmd.display})` : " (run `dahrk update`)";
  return `update available: ${u.current} -> ${u.latest}${how}`;
}

export function renderUpdateLogLine(u: UpdateAvailable): string {
  return `UPDATE_AVAILABLE:${u.latest} current=${u.current}`;
}

/**
 * What one attempt at the check actually did.
 *
 * The daemon used to log only the `available` case, and `checkForUpdate` returned `undefined` for every
 * other outcome alike. That made the three ways of saying nothing - we asked and you are current, we were
 * not due to ask, we asked and it failed - indistinguishable from outside the process, and the second of
 * them was quietly winning every tick. A check whose non-events are unobservable cannot be diagnosed; it
 * can only be guessed at from a state file that, on two of those three paths, does not move either.
 */
export type CheckOutcome =
  | { kind: "available"; update: UpdateAvailable }
  | { kind: "current"; latest: string }
  | { kind: "not-due"; checkedAt: string | undefined }
  | { kind: "failed"; reason: string }
  | { kind: "suppressed" };

/** The daemon's line for any outcome, in the same `TAG:value` shape as `UPDATE_AVAILABLE:`. Returns
 *  undefined for `suppressed`: someone who switched the check off did not ask for a log line about it
 *  every interval either. */
export function renderCheckLogLine(o: CheckOutcome): string | undefined {
  switch (o.kind) {
    case "available":
      return renderUpdateLogLine(o.update);
    case "current":
      return `UPDATE_CHECK:current latest=${o.latest}`;
    case "not-due":
      return `UPDATE_CHECK:not-due since=${o.checkedAt ?? "never"}`;
    case "failed":
      return `UPDATE_CHECK:failed reason=${o.reason}`;
    case "suppressed":
      return undefined;
  }
}

/** Injectable IO: the fetch, the clock, the cache, and the randomness - so the whole thing tests without a
 *  network, a real state file, or a real clock. */
export interface UpdateCheckDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  binPath: string | undefined;
  readState: () => NodeState;
  /** Persist what we learned, so the next start does not re-ask (and `status` can report it offline).
   *  A failure writes only `updateCheckFailedAt`, deliberately leaving `updateCheckedAt` where it was:
   *  the age of the last answer we actually have is the thing `status` reasons about, and moving it on
   *  a failure would launder "could not ask" into "asked recently". */
  saveResult: (patch: {
    updateCheckedAt?: string;
    updateLatest?: string;
    updateCheckFailedAt?: string;
  }) => void;
  fetchLatest: (signal?: AbortSignal) => Promise<string>;
  /** How long to let the fetch run. Defaults to {@link FETCH_TIMEOUT_MS}, the bound for a check an
   *  operator is waiting on; the daemon's periodic check passes {@link BACKGROUND_FETCH_TIMEOUT_MS}. */
  fetchTimeoutMs?: number;
}

/**
 * Ask whether a newer client exists, at most once per interval, reporting what actually happened.
 *
 * This is the whole check; `checkForUpdate` is the narrower view of it that the notice-printing callers
 * want. The distinction matters because "nothing to say" has four different causes and only one of them
 * is healthy.
 */
export async function runUpdateCheck(currentVersion: string, deps: UpdateCheckDeps): Promise<CheckOutcome> {
  // Opted out means opted out: not "do not fetch, but still nag from the cache". This has to be checked
  // here and not only inside `shouldCheck`, because the not-due path below deliberately falls back to what
  // we already know - and that fallback would otherwise resurrect the notice someone switched off.
  if (checkSuppressed(deps.env)) return { kind: "suppressed" };

  const state = deps.readState();
  if (!shouldCheck(deps.now(), state.updateCheckedAt, checkIntervalMs(deps.env), deps.env)) {
    // Not time to ask - but we may already know, from the last time we did.
    const cached = cachedUpdate(state, currentVersion, deps.binPath);
    if (cached.kind === "available") return { kind: "available", update: cached };
    return { kind: "not-due", checkedAt: state.updateCheckedAt };
  }

  let latest: string;
  try {
    latest = await deps.fetchLatest(AbortSignal.timeout(deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS));
  } catch (e) {
    // Fail open, always: offline, slow, 500, garbage - none of it is the operator's problem right now. But
    // record the attempt, so that a node which has been failing for a week can say so when asked.
    deps.saveResult({ updateCheckFailedAt: new Date(deps.now()).toISOString() });
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  }

  deps.saveResult({ updateCheckedAt: new Date(deps.now()).toISOString(), updateLatest: latest });
  if (!isNewer(latest, currentVersion)) return { kind: "current", latest };
  return { kind: "available", update: { current: currentVersion, latest, channel: detectChannel(deps.binPath) } };
}

/**
 * Ask whether a newer client exists, at most once per interval. Returns undefined when there is nothing to
 * say - which includes every failure. The caller cannot tell "you are current" from "the registry was
 * down", and that is deliberate: both mean "carry on and do not bother the operator". Callers that DO need
 * to tell them apart (the daemon's log line) use {@link runUpdateCheck}.
 */
export async function checkForUpdate(
  currentVersion: string,
  deps: UpdateCheckDeps,
): Promise<UpdateAvailable | undefined> {
  const outcome = await runUpdateCheck(currentVersion, deps);
  return outcome.kind === "available" ? outcome.update : undefined;
}

/**
 * What we know about this client's currency, and - just as importantly - when we last knew it.
 *
 * The three states exist because the old shape had only two, and one of them was doing the work of two very
 * different facts. `cachedUpdate` used to return `UpdateAvailable | undefined`, reading only `updateLatest`
 * and ignoring `updateCheckedAt` entirely - so "we asked a minute ago and you are on the latest" and "we
 * have never once managed to ask" both came back as `undefined`, and `status` printed the same bare version
 * line for both. Silence was being asked to mean two opposite things, and the reader had no way to tell
 * which one they were getting.
 *
 * `unknown` is that missing third state. It is not a failure and it is not reassurance; it is the honest
 * answer when nothing has ever successfully asked the registry (a client installed but never started, a node
 * that has been down since before the first check, a machine that is always offline).
 *
 * `checkedAt` rides along on the other two because a claim of currency is only as good as its age. We cannot
 * promise you are on the latest - the registry may have moved a minute after we looked - but we can promise
 * what we last learned, and when. That is a claim we can actually stand behind.
 */
export type UpdateStatus =
  | ({ kind: "available"; checkedAt: number } & UpdateAvailable)
  /** `latest` rides along even though it equals (or trails) the running version, because `status` reports
   *  it once the answer is too old to vouch for: "latest known X, checked Yh ago" is a fact we hold and
   *  can defend, where a bare tick would be a claim we cannot. */
  | { kind: "current"; checkedAt: number; latest: string }
  | { kind: "unknown" };

/** Is a cached answer old enough that presenting it as fact would be misleading? See
 *  {@link STALE_AFTER_INTERVALS}. */
export const isStale = (checkedAt: number, now: number, intervalMs: number): boolean =>
  now - checkedAt >= intervalMs * STALE_AFTER_INTERVALS;

/**
 * May we put a tick on this answer - actively vouch for it, rather than merely report it?
 *
 * Only inside one check interval, because that is the only window in which we have any reason to believe
 * the answer reflects the registry: past it, a check was due and did not land (or landed and failed), and
 * the honest report is the answer plus its age. The gap between this and {@link isStale} is deliberate and
 * is the whole point - there is a middle band where the cached answer is still worth showing but no longer
 * worth blessing, and collapsing it is how a ten hour old "up to date" ends up on screen two hours after a
 * release. A tick is read as "we checked"; it must never mean "we checked, a while ago, probably".
 */
export const isVouchable = (checkedAt: number, now: number, intervalMs: number): boolean =>
  now - checkedAt < intervalMs;

/**
 * What the last check found, straight from the state file - no network. This is what `dahrk status` reads:
 * its whole contract is that it is local, instant, and works offline, and an update notice is not worth
 * breaking that for.
 *
 * A cache with no (or an unparseable) `updateCheckedAt` is `unknown` even when it happens to carry an
 * `updateLatest`: without a timestamp we cannot say how old that answer is, and an answer we cannot date is
 * one we have no business presenting as current.
 */
export function cachedUpdate(
  state: NodeState,
  currentVersion: string,
  binPath: string | undefined,
): UpdateStatus {
  const { updateLatest: latest, updateCheckedAt } = state;
  const checkedAt = updateCheckedAt ? Date.parse(updateCheckedAt) : NaN;
  if (!latest || !Number.isFinite(checkedAt)) return { kind: "unknown" };
  return isNewer(latest, currentVersion)
    ? { kind: "available", checkedAt, current: currentVersion, latest, channel: detectChannel(binPath) }
    : { kind: "current", checkedAt, latest };
}
