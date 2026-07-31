/**
 * Ambient Claude credential resolution (DHK-1004).
 *
 * An ambient node has no brokered credential: the hub attaches nothing and the stage authenticates
 * with whatever login the host already has. Until now the node left that resolution entirely to the
 * runtime subprocess, which reads its own credential store. That is fine when there is one store. On
 * macOS there are two, and they drift.
 *
 * The observed failure: a node running under launchd resolved the **Keychain** copy while the
 * operator's own interactive tooling had refreshed the **file** copy. An OAuth refresh rotates the
 * token and revokes the previous one, so the Keychain held a token the provider had already revoked.
 * Every stage died on its first turn with `401 OAuth access token has been revoked`, at $0.00 and zero
 * turns, on a host whose login was perfectly valid. Which store a process reaches is not something the
 * node controls: it depends on the security session the process was started in, so the same code
 * authenticated from a terminal and failed under launchd.
 *
 * The fix is to stop leaving it to chance. The node reads every store it knows about, picks the
 * freshest credential that has not expired, and passes it explicitly to the runtime. Resolution
 * becomes a decision the node makes and can explain, rather than a side effect of how it was started.
 *
 * Two deliberate non-goals:
 *
 * - **Never refresh.** The provider rotates the refresh token on every use, so a refresh the node does
 *   not persist would strand the credential for whoever owns the store. This module only ever reads.
 *   The same reasoning already governs the brokered subscription path in `claude-adapter.ts`.
 * - **Never write.** Repairing the stale store is the operator's business, not a stage's side effect.
 *   Divergence is reported so a human can fix it, and worked around so a run does not have to wait.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where a host credential was found. Both are Claude Code's own stores, not ours. */
export type AmbientCredentialSource = "keychain" | "file";

/** A credential parsed out of one store. `expiresAt` is epoch ms, absent when the store omits it. */
export interface AmbientCredential {
  token: string;
  source: AmbientCredentialSource;
  expiresAt?: number;
}

/** The macOS Keychain item Claude Code stores its OAuth credential under. */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** The file store, relative to the home directory. */
const CREDENTIAL_FILE = join(".claude", ".credentials.json");
/** A read that hangs must not hang a stage; the stores are local, so this is generous. */
const READ_TIMEOUT_MS = 5_000;

/** Injection seam: every impure read is a dep, so the resolver is testable without a host login. */
export interface AmbientAuthDeps {
  /** Home directory holding the file store. Defaults to the real one. */
  homeDir?: string;
  /** Raw contents of the file store, or undefined when absent/unreadable. */
  readFile?: (path: string) => string | undefined;
  /** Raw contents of the Keychain item, or undefined when absent/unreadable. */
  readKeychain?: () => string | undefined;
  /** Clock, for expiry. Defaults to `Date.now`. */
  now?: () => number;
  /** Host platform; the Keychain is consulted on `darwin` only. Defaults to the real one. */
  platform?: NodeJS.Platform;
}

/**
 * What resolution found. `chosen` is what the stage should authenticate with; the rest exists so the
 * node can explain itself rather than surfacing a bare provider 401.
 */
export interface AmbientAuthResolution {
  /** The freshest unexpired credential, or undefined when nothing usable was found. */
  chosen?: AmbientCredential;
  /** Every credential parsed, in the order the stores were read. Diagnostics only. */
  candidates: AmbientCredential[];
  /** True when two stores hold DIFFERENT tokens: the condition that caused DHK-1004. */
  diverged: boolean;
  /** One line an operator can act on, whether resolution succeeded or not. */
  detail: string;
}

/** Read the file store. Any failure (absent, unreadable, not ours) is simply "no credential here". */
function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Read the Keychain item. Whether this succeeds depends on the security session of the calling
 * process, which is exactly the variable behind DHK-1004: a launchd agent in the Aqua session reads it
 * happily, while a sandboxed process gets `errSecInteractionNotAllowed` (exit 36). Both outcomes are
 * normal and neither is an error worth surfacing on its own, so a failure is just "no credential here".
 */
function defaultReadKeychain(): string | undefined {
  try {
    const out = execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      timeout: READ_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull the OAuth access token out of one store's payload. Both stores hold the same JSON shape, with
 * the credential under `claudeAiOauth`. Anything else - absent, malformed, no token - yields undefined
 * rather than throwing: a store we cannot read is a store we do not use, not a failed stage.
 */
function parseCredential(raw: string | undefined, source: AmbientCredentialSource): AmbientCredential | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return undefined;
  const { accessToken, expiresAt } = oauth as { accessToken?: unknown; expiresAt?: unknown };
  if (typeof accessToken !== "string" || accessToken.length === 0) return undefined;
  return {
    token: accessToken,
    source,
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
  };
}

/** Expired means we KNOW it is past its stated expiry. A store that omits `expiresAt` is not judged. */
function isExpired(cred: AmbientCredential, now: number): boolean {
  return cred.expiresAt !== undefined && cred.expiresAt <= now;
}

/**
 * Resolve the host's ambient Claude credential across every store on this platform.
 *
 * Selection is "the freshest one that still works": among unexpired candidates, the greatest
 * `expiresAt` wins, because a refresh mints a longer-lived token and revokes its predecessor, so later
 * expiry is a reliable proxy for "this is the one that was refreshed most recently". A candidate with
 * no `expiresAt` is usable but ranks below any dated one, since we cannot show it is fresher.
 */
export function resolveAmbientClaudeAuth(deps: AmbientAuthDeps = {}): AmbientAuthResolution {
  const now = (deps.now ?? Date.now)();
  const platform = deps.platform ?? process.platform;
  const home = deps.homeDir ?? homedir();
  const readFile = deps.readFile ?? defaultReadFile;
  const readKeychain = deps.readKeychain ?? defaultReadKeychain;

  const candidates: AmbientCredential[] = [];
  // The Keychain exists on macOS only; on every other platform the file is the whole story.
  if (platform === "darwin") {
    const fromKeychain = parseCredential(readKeychain(), "keychain");
    if (fromKeychain) candidates.push(fromKeychain);
  }
  const fromFile = parseCredential(readFile(join(home, CREDENTIAL_FILE)), "file");
  if (fromFile) candidates.push(fromFile);

  const tokens = new Set(candidates.map((c) => c.token));
  const diverged = tokens.size > 1;

  const usable = candidates.filter((c) => !isExpired(c, now));
  // Sort by expiry descending, undated last: the freshest dated credential is the one to use.
  const ranked = [...usable].sort((a, b) => (b.expiresAt ?? -Infinity) - (a.expiresAt ?? -Infinity));
  const chosen = ranked[0];

  return { ...(chosen ? { chosen } : {}), candidates, diverged, detail: describe(candidates, chosen, diverged) };
}

/**
 * The operator-facing sentence. This is the whole point of resolving explicitly: when a stage cannot
 * authenticate, the node says which stores it read and what it found, instead of handing back the
 * provider's 401 and letting it be read as the agent's fault.
 */
function describe(
  candidates: readonly AmbientCredential[],
  chosen: AmbientCredential | undefined,
  diverged: boolean,
): string {
  if (candidates.length === 0) {
    return "no ambient Claude login found (checked the macOS Keychain and ~/.claude/.credentials.json); run `claude /login` on this host, or enrol this node into a brokered pool";
  }
  if (!chosen) {
    const where = candidates.map((c) => c.source).join(" and ");
    return `the ambient Claude login has expired in every store (${where}); run \`claude /login\` on this host to refresh it`;
  }
  const base = `ambient Claude login resolved from the ${chosen.source} store`;
  if (!diverged) return base;
  const stale = candidates.filter((c) => c.token !== chosen.token).map((c) => c.source);
  // Worth saying out loud even on success: the stage will run, but the host is in the state that
  // breaks any process reaching the other store, so the operator should still repair it.
  return `${base}; NOTE the ${stale.join(" and ")} store holds a different, older token, so a process reaching it would fail to authenticate (run \`claude /login\` to bring the stores back into line)`;
}
