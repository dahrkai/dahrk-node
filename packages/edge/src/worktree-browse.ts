/**
 * Answering a worktree-browse request (DHK-1104).
 *
 * At a deliver gate a human is asked to approve a change they have never seen: the card carries file
 * counts and path strings, and because stages never commit there is nothing pushed to the remote to go
 * and look at either. The worktree is on this node's disk the whole time - the reaper deliberately
 * preserves a gated run's worktree - and until now nothing exposed it. The hub asks over the socket the
 * node already holds, so this needs no inbound port and works for a NAT'd self-hosted node.
 *
 * This module is the answering half, kept out of `ws-client.ts` so it can be tested without a socket.
 *
 * WHAT THE NODE OWNS. `@dahrk/contracts` carries the frames and the result unions but no runtime
 * validation (the wire is `JSON.stringify`/`JSON.parse`), and its own doc assigns three things to this
 * side: rejecting a path that escapes the worktree, detecting a binary file, and enforcing the size
 * cap. A request arrives from the hub, but the `path` in it is ultimately human input from a URL query,
 * so it is validated here rather than trusted.
 *
 * WHY EVERY REFUSAL IS `not-found`. The published unions have no literal for "this node does not hold
 * that run" or "that path escaped the worktree". Minting one means a harness release, an npm publish
 * and a catalogue bump here before this code could compile - the cross-repo round trip that stranded
 * this ticket for three runs. `not-found` is also the better answer for an escape on its own merits: it
 * tells a prober nothing about what exists outside the worktree. The real reason goes to the node log.
 * The neighbouring conditions are already answered a layer up, where the hub distinguishes an offline
 * node, one too old to support browsing, and one that did not reply in time.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { WORKTREE_READ_MAX_BYTES, type WorktreeEntry, type WorktreeListResult, type WorktreeReadResult } from "@dahrk/contracts";
import { ignoredPaths } from "@dahrk/executor-worktree";
import { isUnder, realish } from "./fs-roots.js";
import type { BrowseRoot } from "./stage-runner.js";

/** How much of a file is sniffed for a NUL byte before calling it text. A binary file essentially
 *  always carries one early; reading further buys nothing and costs on a large file. */
const BINARY_SNIFF_BYTES = 8192;

/** The engine's own directory inside a run. At the run root it is a symlink to the shared scratch, so
 *  it is matched by name here rather than left to the git ignore rules, which only apply inside a
 *  repository and so would never see it. */
const RUN_ENGINE_DIR = ".dahrk";

/** Always hidden, in every directory: git's own store is machinery, not the work under review. */
const ALWAYS_EXCLUDED = new Set([".git", RUN_ENGINE_DIR]);

/**
 * The absolute path a browse request refers to, or undefined when it escapes the root.
 *
 * Confinement is by containment AFTER resolution, never by inspecting the spelling: `realish` resolves
 * the deepest existing ancestor, so a symlink pointing out of the worktree is caught even though its
 * own name says nothing, and macOS's `/tmp` -> `/private/tmp` does not read as an escape. `isUnder`
 * admits the root itself, which is what lets `""` and `"."` mean the root - the reason this does not
 * reuse `resolveWorktreeRelativePath` from the stage runner, which rejects the root by design.
 */
export function resolveBrowsePath(root: string, relPath: string): string | undefined {
  if (isAbsolute(relPath)) return undefined;
  // A NUL in a path is never legitimate and would truncate the name inside any syscall that took it.
  if (relPath.includes("\0")) return undefined;
  const abs = resolve(root, relPath === "" || relPath === "." ? "." : relPath);
  return isUnder(realish(root), realish(abs)) ? abs : undefined;
}

/** The run's worktree that owns an absolute path, if any. Ignore rules are per repository, so a
 *  listing has to ask the right one; at the run root no repository owns the path and there is nothing
 *  to ask. Longest match wins, so a nested layout picks the innermost repository. */
function owningRepo(browse: BrowseRoot, abs: string): { dir: string; worktreePath: string } | undefined {
  let best: { dir: string; worktreePath: string } | undefined;
  for (const r of browse.repos) {
    if (!isUnder(r.worktreePath, abs)) continue;
    if (!best || r.worktreePath.length > best.worktreePath.length) best = r;
  }
  return best;
}

/** Directories first, then files, each alphabetically, so the portal's tree does not reshuffle between
 *  two requests for the same directory. */
function byKindThenName(a: WorktreeEntry, b: WorktreeEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * List a directory inside a run's worktree.
 *
 * Excludes what the footprint probe already excludes - the engine scratch and anything git ignores -
 * so what a human browses is what a human could be asked to approve, rather than that plus
 * `node_modules`. The ignore question is asked once for the whole directory, not once per entry: the
 * hub gives a browse request three seconds, and a git process per file would not survive a real tree.
 */
export function listDirectory(browse: BrowseRoot, relPath: string): WorktreeListResult {
  const abs = resolveBrowsePath(browse.root, relPath);
  if (abs === undefined) return { ok: false, reason: "not-found" };

  let dirents;
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") return { ok: false, reason: "not-a-directory" };
    return { ok: false, reason: "not-found" };
  }

  const named = dirents.filter((d) => !ALWAYS_EXCLUDED.has(d.name));
  const repo = owningRepo(browse, abs);
  let ignored = new Set<string>();
  if (repo) {
    // check-ignore wants paths relative to the repository, while the reply names entries relative to
    // the directory being listed, so the two are mapped either side of the call.
    const prefix = relativeWithin(repo.worktreePath, abs);
    const rels = named.map((d) => (prefix ? `${prefix}/${d.name}` : d.name));
    const hits = ignoredPaths(repo.worktreePath, rels);
    ignored = new Set([...hits].map((p) => (prefix && p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : p)));
  }

  const entries: WorktreeEntry[] = [];
  for (const d of named) {
    if (ignored.has(d.name)) continue;
    // A symlink is reported as whatever it points at, and one pointing outside the worktree is left
    // out entirely: listing it would advertise a path that `readFile` then refuses, which reads as a
    // fault rather than as the boundary doing its job.
    const target = join(abs, d.name);
    if (d.isSymbolicLink() && !isUnder(realish(browse.root), realish(target))) continue;
    let stat;
    try {
      stat = statSync(target);
    } catch {
      // A dangling symlink or a file deleted between the readdir and the stat. It is not there to
      // browse, so it is not listed.
      continue;
    }
    if (stat.isDirectory()) entries.push({ name: d.name, kind: "dir" });
    else if (stat.isFile()) entries.push({ name: d.name, kind: "file", size: stat.size });
  }

  return { ok: true, path: relPath, entries: entries.sort(byKindThenName) };
}

/**
 * Read a file inside a run's worktree.
 *
 * The size is checked from the stat, before any read, so an oversized file is never pulled into memory
 * merely to discover that it is oversized. Binary detection then reads only the sniff window.
 */
export function readFile(browse: BrowseRoot, relPath: string): WorktreeReadResult {
  const abs = resolveBrowsePath(browse.root, relPath);
  if (abs === undefined) return { ok: false, reason: "not-found" };

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not-a-file" };
  if (stat.size > WORKTREE_READ_MAX_BYTES) return { ok: false, reason: "too-large" };

  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ok: false, reason: "binary" };

  return { ok: true, path: relPath, content: buf.toString("utf-8"), encoding: "utf8", size: stat.size };
}

/** `child` expressed relative to `parent` with forward slashes, or "" when they are the same path.
 *  Git speaks forward slashes on every platform, so a Windows-style separator would silently fail to
 *  match an ignore rule. */
function relativeWithin(parent: string, child: string): string {
  if (parent === child) return "";
  const rel = child.startsWith(parent + sep) ? child.slice(parent.length + 1) : "";
  return rel.split(sep).join("/");
}
