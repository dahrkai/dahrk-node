/**
 * Stage-prompt assembly: the single place both runtime adapters (and the batch and interactive paths)
 * turn a stage's config plus the run's Linear context into the text sent to the model. Resolves the
 * bare instruction (prompt_file / inline / skill / default), then folds in the ticket brief, the
 * workspace/team guidance, any gate feedback, and attached documents as delimited, defanged blocks.
 * Runtime-agnostic and side-effect-free apart from reading a configured prompt file off the worktree.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunnerContext, WorkspaceRef } from "@dahrk/contracts";
import { attachedDocBasename } from "@dahrk/contracts";

/** Strip a leading YAML frontmatter block (`---` ... `---`) from a prompt-file body, so a
 *  reused `.claude/commands/*.md` file's metadata header is not sent to the model as instruction. */
function stripFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\n+/, "");
    }
  }
  return text; // no closing fence: treat the whole file as body
}

/** The stage's bare instruction, before any ticket context is folded in. Precedence:
 *  prompt_file (read from the worktree) -> inline prompt -> skill -> the default. */
function stageInstruction(ctx: RunnerContext): string {
  const { config, workspace } = ctx;
  if (config.promptFile) {
    try {
      const raw = readFileSync(join(workspace.worktreePath, config.promptFile), "utf8");
      const body = stripFrontmatter(raw).trim();
      if (body) return body;
    } catch (e) {
      // Surface a usable instruction rather than silently running an empty prompt.
      return `The configured prompt file "${config.promptFile}" could not be read (${(e as Error).message}).`;
    }
  }
  if (config.prompt) return config.prompt;
  if (config.skill) return `Use the ${config.skill} skill to complete this stage.`;
  return "Begin the stage.";
}

/** Per-document inline cap. The full body is on disk at `.dahrk/scratch/docs/<slug>.md`, so the
 *  prompt only needs enough to orient the agent; a long doc is truncated with a pointer to the file. */
export const MAX_INLINE_DOC_CHARS = 6000;
/** Overall inline budget across all documents, so many attached docs cannot blow up the prompt. */
export const MAX_INLINE_DOCS_TOTAL_CHARS = 20000;

/** Defang the `<documents>`/`<document>` closing tags inside untrusted document text by inserting a
 *  zero-width space, so the text cannot close the block early and inject top-level instructions. The
 *  inserted character is invisible to a reader and does not change the meaning of the document. */
function neutraliseDelimiters(text: string): string {
  return text.replace(/<\/(documents?)>/gi, "<​/$1>");
}

/** Build the `<documents>` block from the run's attached Linear documents: per doc a header (title +
 *  the scratch path holding the full text) and a capped excerpt. Returns "" when there are none.
 *  The full body always lives at `.dahrk/scratch/docs/<slug>.md`, which the edge wrote. */
function documentsBlock(ctx: RunnerContext): string {
  const docs = ctx.attachedDocuments;
  if (!docs || docs.length === 0) return "";
  let budget = MAX_INLINE_DOCS_TOTAL_CHARS;
  const parts: string[] = [];
  for (const doc of docs) {
    // Share the basename function with the edge's file write so the pointer can never drift from the
    // file it names.
    const path = `.dahrk/scratch/docs/${attachedDocBasename(doc)}.md`;
    const cap = Math.max(0, Math.min(MAX_INLINE_DOC_CHARS, budget));
    const body = doc.content.trim();
    const truncated = body.length > cap;
    const excerpt = truncated ? body.slice(0, cap) : body;
    budget -= excerpt.length;
    const tail = truncated
      ? `\n...(truncated; full text at ${path})`
      : "";
    // Title and body are untrusted (anyone who can attach a doc to the issue controls them). Neutralise
    // the block's own delimiters so a body/title containing `</document>` cannot break out of the block
    // and have its following text read as top-level prompt instructions. XML tags are not a security
    // boundary for an LLM, but this removes the trivial breakout.
    const title = doc.title.replace(/[<>"]/g, "'");
    parts.push(
      `<document title="${title}" file="${path}">\n${neutraliseDelimiters(excerpt)}${tail}\n</document>`,
    );
    if (budget <= 0) break;
  }
  return `<documents>\n${parts.join("\n\n")}\n</documents>`;
}

/** Inline budget for the comment thread, deliberately SEPARATE from the document budget rather than
 *  drawn from a shared pool. The documents loop spends its pool in list order and breaks when it is
 *  exhausted, so a single long comment thread sharing that pool could silently evict the attached
 *  documents - the spike findings the stage exists to build against. Separate budgets make the two
 *  independent: a noisy ticket costs comment fidelity, never document fidelity. */
export const MAX_INLINE_COMMENTS_TOTAL_CHARS = 8000;
/** Per-comment inline cap, so one enormous comment cannot consume the whole thread's budget. */
export const MAX_INLINE_COMMENT_CHARS = 3000;
/** Manifest rows to inline. Metadata only, so this is generous; it exists to stop a pathological
 *  issue graph from crowding out the instruction. */
export const MAX_INLINE_RELATED = 50;

/** Defang the `<comments>`/`<comment>` closing tags inside untrusted comment text, mirroring
 *  `neutraliseDelimiters` for documents. Comment bodies are the LEAST trusted input in the prompt -
 *  anyone who can see the issue can write one - so this matters more here than anywhere else. */
function neutraliseCommentDelimiters(text: string): string {
  return text.replace(/<\/(comments?)>/gi, "<​/$1>");
}

/**
 * Build the `<comments>` block from the issue's thread.
 *
 * Truncation keeps the MOST RECENT comments, the opposite of the documents block. A document is a
 * standing reference whose opening frames it; a conversation's current state lives at its end, so
 * dropping the tail would strip exactly the turn that redirected the work. The dropped older comments
 * are noted and the full thread is always on disk at `.dahrk/scratch/comments.md`.
 */
function commentsBlock(ctx: RunnerContext): string {
  const comments = ctx.comments;
  if (!comments || comments.length === 0) return "";
  const path = ".dahrk/scratch/comments.md";

  // Walk backwards (newest first) accumulating within budget, then re-reverse so the block still reads
  // oldest-to-newest as a conversation should.
  let budget = MAX_INLINE_COMMENTS_TOTAL_CHARS;
  const kept: string[] = [];
  let dropped = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!comment) continue;
    const body = comment.body.trim();
    if (budget <= 0) {
      dropped = i + 1;
      break;
    }
    const cap = Math.max(0, Math.min(MAX_INLINE_COMMENT_CHARS, budget));
    const truncated = body.length > cap;
    const excerpt = truncated ? body.slice(0, cap) : body;
    budget -= excerpt.length;
    // Attributes are untrusted (an author display name is user-controlled), so strip the quoting
    // characters exactly as the documents block does.
    const author = (comment.author || "unknown").replace(/[<>"]/g, "'");
    const at = comment.createdAt.replace(/[<>"]/g, "'");
    const tail = truncated ? `\n...(truncated; full thread at ${path})` : "";
    kept.push(
      `<comment author="${author}" at="${at}">\n${neutraliseCommentDelimiters(excerpt)}${tail}\n</comment>`,
    );
  }
  if (kept.length === 0) return "";
  kept.reverse();
  const note = dropped > 0 ? ` earlier="${dropped} older comment(s) omitted; full thread at ${path}"` : "";
  return `<comments count="${comments.length}" file="${path}"${note}>\n${kept.join("\n\n")}\n</comments>`;
}

/**
 * Build the `<related>` manifest from the issue's one-hop neighbourhood: metadata only, one row per
 * neighbouring issue.
 *
 * This block is why the agent knows there is anything to look at. Bodies are not fetched, so without
 * it a spike attached to a blocking ticket, or the epic that frames the work, is completely invisible
 * from inside the run.
 */
function relatedBlock(ctx: RunnerContext): string {
  const related = ctx.relatedIssues;
  if (!related || related.length === 0) return "";
  const rows = related.slice(0, MAX_INLINE_RELATED).map((r) => {
    // Every attribute here is Linear-derived but user-authored (titles especially), so quote-strip
    // them all; the title is element text and gets the delimiter defang.
    const rel = r.relation.replace(/[<>"]/g, "'");
    const key = r.key.replace(/[<>"]/g, "'");
    const state = r.stateName.replace(/[<>"]/g, "'");
    const title = r.title.replace(/<\/(related|issue)>/gi, "<​/$1>");
    return `<issue rel="${rel}" key="${key}" state="${state}">${title}</issue>`;
  });
  const omitted = related.length > MAX_INLINE_RELATED ? related.length - MAX_INLINE_RELATED : 0;
  const note = omitted > 0 ? ` omitted="${omitted}"` : "";
  return `<related count="${related.length}"${note} file=".dahrk/scratch/related.md">\n${rows.join("\n")}\n</related>`;
}

/** Defang the `<guidance>`/`<guidance-rule>` closing tags inside guidance text by inserting a
 *  zero-width space, mirroring `neutraliseDelimiters` for documents, so the text cannot close the block
 *  early. Guidance is operator-authored (lower risk than documents) but we stay consistent. */
function neutraliseGuidanceDelimiters(text: string): string {
  return text.replace(/<\/(guidance(?:-rule)?)>/gi, "<​/$1>");
}

/** Build the `<guidance>` block from the run's Linear workspace/team guidance: one
 *  `<guidance-rule origin="..." team="...">text</guidance-rule>` per rule. Returns "" when none. */
function guidanceBlock(ctx: RunnerContext): string {
  const guidance = ctx.guidance;
  if (!guidance || guidance.length === 0) return "";
  const parts: string[] = [];
  for (const rule of guidance) {
    const content = rule.content.trim();
    if (!content) continue;
    const origin = rule.origin.replace(/[<>"]/g, "'");
    const team = rule.teamName !== undefined ? ` team="${rule.teamName.replace(/[<>"]/g, "'")}"` : "";
    parts.push(`<guidance-rule origin="${origin}"${team}>\n${neutraliseGuidanceDelimiters(content)}\n</guidance-rule>`);
  }
  if (parts.length === 0) return "";
  return `<guidance>\n${parts.join("\n")}\n</guidance>`;
}

/** Defang the `<gate-feedback>`/`<gate-note>` closing tags inside untrusted gate-feedback prose
 *  by inserting a zero-width space, mirroring the documents/guidance neutralisers, so the text cannot
 *  close its block early and inject top-level instructions. */
function neutraliseGateFeedbackDelimiters(text: string): string {
  return text.replace(/<\/(gate-feedback|gate-note)>/gi, "<​/$1>");
}

/** Build the `<gate-feedback>` block from the run's feedback-bearing gate approvals: one
 *  `<gate-note stage="..." decision="...">prose</gate-note>` per note. The prose is untrusted human
 *  input (it came in over a Linear reply), so the closing tags are defanged exactly as documents and
 *  guidance are. Returns "" when there are none. */
function gateFeedbackBlock(ctx: RunnerContext): string {
  const notes = ctx.gateFeedback;
  if (!notes || notes.length === 0) return "";
  const parts: string[] = [];
  for (const note of notes) {
    const content = note.feedback.trim();
    if (!content) continue;
    const stage = note.stageId.replace(/[<>"]/g, "'");
    const decision = note.decision.replace(/[<>"]/g, "'");
    parts.push(
      `<gate-note stage="${stage}" decision="${decision}">\n${neutraliseGateFeedbackDelimiters(content)}\n</gate-note>`,
    );
  }
  if (parts.length === 0) return "";
  return `<gate-feedback>\n${parts.join("\n")}\n</gate-feedback>`;
}

/**
 * Build the `<check-failures>` block: WHY this agent is running again.
 *
 * Without it the loop is blind. `stageInstruction` returns the stage's STATIC prompt, nothing else
 * injects a re-entry note, and no other block points at `.dahrk/scratch/checks/`. An agent looped back
 * by a failing lint would otherwise rebuild identically until the `on_fail` bound ran out and the run
 * died - the exact failure a check stage exists to prevent.
 *
 * Every check is listed, passed ones included, so the agent sees the whole picture rather than a list
 * of complaints. The captured output is deliberately NOT here: it can be tens of kilobytes, so the
 * block points at the per-attempt note in the worktree instead.
 *
 * Nothing needs defanging: every value is engine-authored (a check name from the repo's config, a
 * status from a closed enum, a stage id), never agent or human prose.
 */
function checkFailuresBlock(ctx: RunnerContext): string {
  const failures = ctx.checkFailures;
  if (!failures) return "";
  const { stageId, attempt, verifications } = failures;
  if (verifications.length === 0) return "";
  const safeStage = stageId.replace(/[^A-Za-z0-9._-]/g, "-");
  const rows = verifications
    .map((v) => `  ${v.name}: ${v.status === "failed" ? "FAILED" : v.status}`)
    .join("\n");
  return (
    `<check-failures stage="${stageId.replace(/[<>"]/g, "'")}" attempt="${attempt}">\n` +
    `${rows}\n` +
    `  Full output: .dahrk/scratch/checks/${safeStage}-${attempt}.md\n` +
    `</check-failures>`
  );
}

/**
 * Resolve the prompt an adapter sends for a stage: the stage instruction (from a `prompt_file`,
 * inline `prompt`, `skill`, or the default), with the run's Linear ticket brief prepended as a
 * delimited `<ticket>` block, the run's workspace/team guidance as a `<guidance>` block, and any
 * attached Linear documents as a `<documents>` block when present. This is the single place both
 * adapters (and the batch and interactive paths) build the stage prompt, so the ticket, guidance, and
 * documents reach the agent uniformly.
 */
/**
 * The `<repos>` manifest for a MULTI-REPO run (DHK-251): every repository checked out for this run,
 * and where it is relative to the agent's working directory.
 *
 * Rendered only when there is more than one, so a single-repo prompt is byte-identical. That is not
 * only tidiness: the assembled prompt feeds the stage's config digest, so a block that said nothing
 * would invalidate every existing single-repo digest for no gain.
 *
 * Paths are RELATIVE, because that is what the agent types and what path confinement judges. The
 * working directory is the primary repo, and the siblings are `../<name>` beside it.
 */
function reposBlock(ctx: RunnerContext): string {
  // A node-local extension of the runner context, not a contract field - the same shape as
  // `injectedSkillPaths`. The cast is deliberate and is NOT leftover scaffolding from the pinned
  // contracts version: `JobRequest.extraWorkspaces` is the wire field and is properly typed; this is
  // the stage runner handing the resolved worktrees to an adapter in-process.
  const workspaces = (ctx as RunnerContext & { workspaces?: WorkspaceRef[] }).workspaces ?? [];
  if (workspaces.length < 2) return "";
  const rows = workspaces.map((w, i) => {
    const path = i === 0 ? "." : `../${basename(w.worktreePath)}`;
    return `| ${w.repo} | ${path} | ${w.branch ?? ""} | ${w.baseBranch} |`;
  });
  return [
    "<repos>",
    "This run has more than one repository checked out side by side. You are in the first one; the",
    "others are directories beside it, and you may read and change them. Commit nothing: each repo is",
    "committed and pushed for you at the end of the run.",
    "",
    "| Repo | Path | Branch | Base |",
    "|---|---|---|---|",
    ...rows,
    "</repos>",
  ].join("\n");
}

export function resolveStagePrompt(ctx: RunnerContext): string {
  const instruction = stageInstruction(ctx);
  const ticket = ctx.issueContext?.trim()
    ? `<ticket>\n${ctx.issueContext.trim()}\n</ticket>`
    : "";
  const guidance = guidanceBlock(ctx);
  const gateFeedback = gateFeedbackBlock(ctx);
  const docs = documentsBlock(ctx);
  const comments = commentsBlock(ctx);
  const related = relatedBlock(ctx);
  // Guidance sits right after the ticket (workspace direction); gate feedback follows it (run-specific
  // approving-with-guidance), both ahead of any attached documents. The issue's own conversation and
  // then its neighbourhood manifest follow the documents: they are the widest, least specific context,
  // so they sit furthest from the instruction. Check failures come LAST, closest to the instruction:
  // it is the most immediate, most actionable context the agent has, and it is the reason this stage
  // is running at all.
  const checkFailures = checkFailuresBlock(ctx);
  // The repo manifest sits with the ticket: it is a fact about the workspace the agent is standing in,
  // so it belongs before any of the narrative context.
  const repos = reposBlock(ctx);
  const preamble = [ticket, repos, guidance, gateFeedback, docs, comments, related, checkFailures]
    .filter(Boolean)
    .join("\n\n");
  return preamble ? `${preamble}\n\n${instruction}` : instruction;
}

/** Whether a stage carries an explicit instruction, ticket context, or attached documents worth
 *  setting as the Claude interactive `systemPrompt` (a bare `skill` did not set one before, so it is
 *  excluded here). */
export function hasSystemPrompt(ctx: RunnerContext): boolean {
  return Boolean(
    ctx.config.prompt ||
      ctx.config.promptFile ||
      ctx.issueContext?.trim() ||
      (ctx.guidance && ctx.guidance.length > 0) ||
      (ctx.gateFeedback && ctx.gateFeedback.length > 0) ||
      Boolean(ctx.checkFailures) ||
      (ctx.attachedDocuments && ctx.attachedDocuments.length > 0) ||
      (ctx.comments && ctx.comments.length > 0) ||
      (ctx.relatedIssues && ctx.relatedIssues.length > 0),
  );
}

/**
 * A short nudge that opens an interactive stage whose instruction and ticket context already ride
 * in the runtime's system prompt (the Claude interactive path appends `resolveStagePrompt`). The
 * ticket is in context, so this just tells the agent to speak first.
 */
export const OPENING_KICKOFF =
  "Begin now. Using the ticket context and your instructions already provided, ask the human your " +
  "first question. Do not wait for further input before sending your first message.";

/**
 * The opening user turn that self-starts an interactive stage. An interactive stage is
 * triggered by a Linear label or mention whose text rides in `issueContext`, never as a queued human
 * turn, so without a seed the runner would idle until it timed out with the model never running. Pass
 * `instructionInSystemPrompt: true` when the adapter already carries the stage instruction as a system
 * prompt (Claude, when `hasSystemPrompt(ctx)`) so a short kickoff suffices; otherwise (Pi, or a
 * bare-skill Claude stage) seed the full resolved prompt so the agent has its instructions.
 */
export function interactiveSeedText(ctx: RunnerContext, instructionInSystemPrompt: boolean): string {
  return instructionInSystemPrompt ? OPENING_KICKOFF : resolveStagePrompt(ctx);
}
