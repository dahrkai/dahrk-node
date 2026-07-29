/**
 * Project pinned components into a run's worktree at dispatch, normalised per runtime.
 *
 * The manifest bakes each component under its Claude-convention `.claude/` path (see {@link PackCache}),
 * but the two runtimes consume components through different surfaces, so this step projects each one to
 * fit the runtime that will read it:
 *
 *  - Claude (`claude-code`): the SDK reads `.claude/` straight off the worktree
 *    (`settingSources: ["project","local"]`), so each component must physically exist there. Write the
 *    files under `.claude/`, with REPO-LOCAL PRECEDENCE - if the repo already ships a file at the same
 *    path, keep the repo's and skip the central one (never clobber a repo file). Idempotent:
 *    re-overlaying identical bytes is a no-op.
 *  - Pi (`pi`) implements the same Agent Skills standard and has near-isomorphic prompt templates, so
 *    its components are real - just reached differently, per kind:
 *      - skills: Pi's resource loader takes additional skill directories as arbitrary paths, so point it
 *        straight at the pack cache (`injected`) with NO copy into the worktree - a projection the Claude
 *        adapter cannot do, since it depends on the SDK reading the project dir off disk.
 *      - commands: reshape the Claude frontmatter into a Pi prompt template and write it under
 *        `.pi/prompts/`, where Pi discovers project-local templates. Same repo-local precedence and
 *        idempotence as Claude.
 *      - subagents: Pi intentionally ships no subagents, so warn-and-skip - the one kind that genuinely
 *        cannot be projected onto Pi, and the accurate reason for it.
 *  - Every other runtime (Codex, ...): no components surface the adapter reads, so warn-and-skip and name
 *    the component rather than write files it never looks at.
 *
 * The result distinguishes `injected` (made available WITHOUT writing bytes) from `written` (copied to
 * disk), so injected-by-path components are reported honestly. Not in scope here: the hub component
 * catalogue and production pack source (DHK-172); this works against the existing cache seam.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ComponentRef, Runtime } from "@dahrk/contracts";
import type { PackCache } from "./pack-cache.js";
import { readManifestFiles } from "./pack-cache.js";

export interface OverlayResult {
  /** Worktree-relative paths written to disk (Claude components; Pi commands). */
  written: string[];
  /**
   * Absolute paths made available to the runtime WITHOUT writing bytes into the worktree - injected by
   * path, e.g. Pi skills pointed at straight from the pack cache. Reported separately from `written` so
   * an injected-by-path component is never counted as a file on disk.
   */
  injected: string[];
  /** Worktree-relative paths skipped because the repo already ships its own (repo-local precedence). */
  skippedRepoLocal: string[];
  /** Human-readable notes (e.g. a component a runtime cannot materialise). */
  warnings: string[];
}

export interface OverlayOptions {
  worktreePath: string;
  runtime: Runtime;
  components: readonly ComponentRef[];
  cache: PackCache;
}

/** True when the worktree already has identical bytes at `dest` (an idempotent re-overlay). */
function sameBytes(dest: string, bytes: Buffer): boolean {
  try {
    return readFileSync(dest).equals(bytes);
  } catch {
    return false;
  }
}

/** The frontmatter keys a Pi prompt template understands (its loader reads only these). Claude command
 *  frontmatter uses the same key names, so the reshape keeps them and drops every Claude-only key
 *  (`allowed-tools`, `model`, ...) rather than leaving dead metadata in the Pi template. */
const PI_TEMPLATE_FRONTMATTER_KEYS = new Set(["description", "argument-hint"]);

/**
 * Reshape a Claude command markdown into a Pi prompt template: keep only the frontmatter keys Pi reads
 * ({@link PI_TEMPLATE_FRONTMATTER_KEYS}) and leave the body - and its argument-substitution tokens
 * (`$1`, `$ARGUMENTS`, ...), which are already isomorphic across the two - untouched. A mechanical
 * reshape, not a rewrite. Line-based like `stripFrontmatter` (no YAML parser, no new dependency): a
 * command's frontmatter is flat `key: value` lines. A command with no frontmatter passes through
 * unchanged.
 */
export function reshapeCommandToPiTemplate(source: string): string {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return source;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return source; // no closing fence: not a frontmatter block, leave as-is
  const kept: string[] = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const key = line.slice(0, line.indexOf(":")).trim();
    if (line.indexOf(":") !== -1 && PI_TEMPLATE_FRONTMATTER_KEYS.has(key)) kept.push(line);
  }
  const body = lines.slice(end + 1).join("\n");
  // Drop the frontmatter fence entirely when nothing Pi understands survives, so the template is not
  // led by an empty `---`/`---` block.
  if (kept.length === 0) return body.replace(/^\n+/, "");
  return ["---", ...kept, "---", body].join("\n");
}

/** Copy a component's manifest file into the worktree with repo-local precedence + idempotence, the
 *  shared Claude/Pi-command write path. `transform` reshapes the bytes (identity for Claude); `destRel`
 *  maps the manifest path to the worktree-relative target (identity for Claude). */
function writeWithPrecedence(
  worktreePath: string,
  srcAbs: string,
  destRel: string,
  transform: (bytes: Buffer) => Buffer,
  result: OverlayResult,
): void {
  const bytes = transform(readFileSync(srcAbs));
  const dest = join(worktreePath, destRel);
  // Repo-local precedence: a file the repo already ships wins. Idempotency: an identical
  // already-overlaid file is not a clobber, so it does not count as repo-local.
  if (existsSync(dest)) {
    if (sameBytes(dest, bytes)) return; // idempotent re-overlay, no-op
    result.skippedRepoLocal.push(destRel);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  result.written.push(destRel);
}

export async function overlayComponents(opts: OverlayOptions): Promise<OverlayResult> {
  const { worktreePath, runtime, components, cache } = opts;
  const result: OverlayResult = { written: [], injected: [], skippedRepoLocal: [], warnings: [] };

  for (const ref of components) {
    if (runtime === "claude-code") {
      // The SDK reads `.claude/` off the worktree, so copy each manifest file to its declared path.
      const { dir } = await cache.materialise(ref);
      for (const relPath of readManifestFiles(dir)) {
        writeWithPrecedence(worktreePath, join(dir, relPath), relPath, (b) => b, result);
      }
      continue;
    }

    if (runtime === "pi") {
      await overlayPiComponent(worktreePath, ref, cache, result);
      continue;
    }

    // Every other runtime (Codex, ...) has no components surface the adapter reads, so warn-and-skip
    // and name the component rather than write files it never looks at.
    result.warnings.push(
      `${runtime} runtime: ${ref.kind} \`${ref.name}@${ref.version}\` not materialised; inline into the prompt or use Claude`,
    );
  }

  return result;
}

/** Project one pinned component onto Pi: skills inject by path, commands reshape+write, subagents warn. */
async function overlayPiComponent(
  worktreePath: string,
  ref: ComponentRef,
  cache: PackCache,
  result: OverlayResult,
): Promise<void> {
  // Pi intentionally ships no subagents, so a pinned agent genuinely cannot be projected onto it.
  // (This is the ONLY kind that warns for Pi - not a blanket "no components surface".)
  if (ref.kind === "agent") {
    result.warnings.push(
      `pi runtime: subagent \`${ref.name}@${ref.version}\` not materialised; Pi ships no subagents by design`,
    );
    return;
  }

  const { dir } = await cache.materialise(ref);
  const files = readManifestFiles(dir);

  if (ref.kind === "skill") {
    // Inject by path: point Pi's resource loader at each skill's own directory (the one holding its
    // SKILL.md) straight in the pack cache, so nothing is copied into the worktree.
    for (const relPath of files) {
      if (basename(relPath) === "SKILL.md") result.injected.push(join(dir, dirname(relPath)));
    }
    return;
  }

  // Command: reshape the Claude frontmatter into a Pi prompt template and write it under `.pi/prompts/`,
  // where Pi discovers project-local templates. Pi names a template by its file's basename, so flatten
  // to `.pi/prompts/<basename>`.
  for (const relPath of files) {
    if (!relPath.endsWith(".md")) continue;
    const destRel = join(".pi", "prompts", basename(relPath));
    writeWithPrecedence(
      worktreePath,
      join(dir, relPath),
      destRel,
      (b) => Buffer.from(reshapeCommandToPiTemplate(b.toString("utf8"))),
      result,
    );
  }
}
