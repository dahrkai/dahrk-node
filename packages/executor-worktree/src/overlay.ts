/**
 * Project pinned components into a run's worktree at dispatch, normalised per runtime.
 *
 * A component is materialised through the {@link PackCache} (which verifies every byte and the
 * combined digest) and then delivered in whatever form the target runtime actually reads. The
 * manifest bakes Claude-convention `.claude/` paths (see {@link PackCache}); each runtime branch
 * translates from those to its own surface:
 *
 *  - Claude (`claude-code`): the adapter reads `.claude/` straight off the worktree
 *    (`settingSources: ["project","local"]`), so write every component file there, with REPO-LOCAL
 *    PRECEDENCE - if the repo already ships a file at the same path, keep the repo's and skip the
 *    central one (never clobber a repo file). Idempotent: re-overlaying identical bytes is a no-op.
 *  - Pi (`pi`), per component kind - because Pi implements the same Agent Skills standard and reads
 *    near-isomorphic prompt templates, it DOES have a components surface (the stale belief that it
 *    did not is what this branch corrects):
 *      - skill: INJECT BY PATH. Pi's resource loader takes additional skill directories as arbitrary
 *        paths (`additionalSkillPaths`) and recurses to find `SKILL.md`, so point it straight at the
 *        verified CAS directory - nothing is copied into the worktree. Recorded in `injected`.
 *      - command: RESHAPE AND WRITE. Pi reads prompt templates from `.pi/prompts/*.md`; a Claude
 *        command is a frontmatter reshape away from one (see {@link reshapeClaudeCommandToPi}), so
 *        write the reshaped template there, with the same repo-local precedence + idempotence as
 *        Claude. Recorded in `written`.
 *      - agent: WARN AND SKIP. Pi intentionally ships no subagents, so a pinned subagent genuinely
 *        cannot be projected onto a Pi stage. This is the one kind where warn-and-skip is correct.
 *  - Every other runtime (Codex, ...): no components surface, so write nothing and record a warning
 *    per component (inline into the prompt or use Claude).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ComponentRef, Runtime } from "@dahrk/contracts";
import { parseFrontmatter, serialiseFrontmatter } from "./frontmatter.js";
import type { PackCache } from "./pack-cache.js";
import { readManifestFiles } from "./pack-cache.js";

/** Pi's project prompt-template directory (its `configDir` is `.pi`; templates live under `prompts/`). */
const PI_PROMPTS_DIR = ".pi/prompts";

export interface OverlayResult {
  /** Worktree-relative paths written to disk (Claude files, and Pi reshaped commands). */
  written: string[];
  /**
   * Absolute pack-cache directories referenced in place, never copied into the worktree (Pi skills
   * injected via the adapter's resource loader). Materialised-and-referenced, not written to disk.
   */
  injected: string[];
  /** Worktree-relative paths skipped because the repo already ships its own (repo-local precedence). */
  skippedRepoLocal: string[];
  /** Human-readable notes (e.g. a runtime cannot project a given component kind). */
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

/**
 * Write `bytes` to the worktree-relative `relPath` with repo-local precedence and idempotence, the
 * shared write step for both Claude files and Pi reshaped commands: a file the repo already ships
 * wins (recorded as `skippedRepoLocal`), identical already-overlaid bytes are a no-op, otherwise the
 * bytes are written and recorded as `written`.
 */
function writeWithPrecedence(worktreePath: string, relPath: string, bytes: Buffer, result: OverlayResult): void {
  const dest = join(worktreePath, relPath);
  if (existsSync(dest)) {
    if (sameBytes(dest, bytes)) return; // idempotent re-overlay, no-op
    result.skippedRepoLocal.push(relPath);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  result.written.push(relPath);
}

/** The frontmatter keys a Pi prompt template understands; every other Claude command key is dropped. */
const PI_PROMPT_FRONTMATTER_KEYS = ["description", "argument-hint"];

/**
 * Reshape a Claude command file into a Pi prompt template. The two are near-isomorphic: both carry a
 * `description` and `argument-hint` in YAML frontmatter, and both bodies use the same positional /
 * all-argument substitution and defaults (`$1`, `$@`, `$ARGUMENTS`, `${N:-default}`), so this is a
 * frontmatter reshape and a relocation, not a rewrite. Claude-only keys (`allowed-tools`, `model`)
 * are dropped since Pi's template loader ignores them; the body is preserved verbatim. The
 * `.claude/commands/<name>.md` source is relocated to Pi's flat project template dir
 * `.pi/prompts/<name>.md` (Pi scans that directory non-recursively). Pure, so it is unit-tested
 * without the filesystem or the SDK.
 */
export function reshapeClaudeCommandToPi(relPath: string, content: string): { dest: string; content: string } {
  const { frontmatter, body } = parseFrontmatter(content);
  const kept = PI_PROMPT_FRONTMATTER_KEYS.filter((k) => frontmatter[k] !== undefined).map(
    (k) => [k, frontmatter[k]!] as const,
  );
  const reshaped = kept.length > 0 ? `${serialiseFrontmatter(kept)}\n${body}` : body;
  return { dest: `${PI_PROMPTS_DIR}/${basename(relPath)}`, content: reshaped };
}

export async function overlayComponents(opts: OverlayOptions): Promise<OverlayResult> {
  const { worktreePath, runtime, components, cache } = opts;
  const result: OverlayResult = { written: [], injected: [], skippedRepoLocal: [], warnings: [] };

  for (const ref of components) {
    if (runtime === "claude-code") {
      // Claude reads `.claude/` off the worktree, so write every file there.
      const { dir } = await cache.materialise(ref);
      for (const relPath of readManifestFiles(dir)) {
        writeWithPrecedence(worktreePath, relPath, readFileSync(join(dir, relPath)), result);
      }
      continue;
    }

    if (runtime === "pi") {
      if (ref.kind === "skill") {
        // Inject by path: hand Pi's resource loader the verified CAS dir; copy nothing.
        const { dir } = await cache.materialise(ref);
        result.injected.push(dir);
        continue;
      }
      if (ref.kind === "command") {
        // Reshape each Claude command into a Pi prompt template and write it under `.pi/prompts/`.
        const { dir } = await cache.materialise(ref);
        for (const relPath of readManifestFiles(dir)) {
          const reshaped = reshapeClaudeCommandToPi(relPath, readFileSync(join(dir, relPath), "utf8"));
          writeWithPrecedence(worktreePath, reshaped.dest, Buffer.from(reshaped.content), result);
        }
        continue;
      }
      // Subagent: Pi intentionally ships no subagents, so this genuinely cannot be projected.
      result.warnings.push(
        `pi runtime: subagent \`${ref.name}@${ref.version}\` not projected; Pi intentionally ships no subagents, so a pinned subagent cannot be provided to a Pi stage`,
      );
      continue;
    }

    // Any other runtime (Codex, ...): no components surface, so warn and write nothing.
    result.warnings.push(
      `${runtime} runtime: ${ref.kind} \`${ref.name}@${ref.version}\` not materialised; inline into the prompt or use Claude`,
    );
  }

  return result;
}
