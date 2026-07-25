/**
 * The `dahrk_stage_complete` tool, injected per interactive stage as an in-process Claude MCP tool.
 * It is the stage's EXIT SIGNAL: for an interactive stage "the agent's turn ended" carries no
 * information (every turn ends), so without this the agent has no way to say it is finished and the
 * stage runs on until its idle window expires and is recorded as `timeout`. Calling it ends the stage
 * and its `summary` argument becomes the handoff summary directly, skipping the engine-owned
 * summarisation turn a gate exit needs. Ported from the S2 spike's tool definition + captured-summary
 * closure.
 *
 * Interactive stages have FULL TOOL PARITY with batch: they may write files and explore the repo like
 * any other stage. (The S2 spike gated the tool set to this one tool; that was reversed after two
 * production failures where a denied `Write` left `attach-document` with nothing and derailed the
 * model into a timeout. `allowedTools` in the adapter is an auto-approve list, not a whitelist.) The
 * optional `document` argument is therefore a convenience, not the only route: it hands a deliverable
 * back in-band so the model need not pick a filesystem path, and it sits ahead of the scratch and
 * changed-file scans in the edge stage-runner's artifact resolution chain.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** The in-process MCP server's name, and the tool's name within it. Kept as the single source for
 *  both `STAGE_COMPLETE_TOOL_NAME` and the adapter's `mcpServers` key: the SDK derives the exposed
 *  tool name as `mcp__<server>__<tool>`, so a drift between any two of them breaks every interactive
 *  stage in production while every test still passes (nothing asserts the SDK options object). */
const MCP_SERVER_NAME = "dahrk";
const STAGE_COMPLETE_TOOL = "dahrk_stage_complete";

/** The fully-qualified tool name the SDK exposes for the in-process `dahrk` MCP server. */
export const STAGE_COMPLETE_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${STAGE_COMPLETE_TOOL}` as const;

/** The tool description shipped to the model. Exported because it is model-facing contract text, not
 *  an implementation detail: it must not re-acquire the reversed S2 claim that an interactive stage
 *  cannot write files (see the header), and a test asserts exactly that. */
export const STAGE_COMPLETE_DESCRIPTION =
  "End the current stage and hand off a one-sentence summary of what was accomplished. When the " +
  "stage's deliverable is a document (e.g. a specification or report) to be published, you may " +
  "pass its full markdown body as `document` to hand it back directly, rather than writing it to " +
  "a file and relying on it being found.";

export interface StageCompleteTool {
  /** The in-process MCP server to pass to `query()`'s `mcpServers`, keyed by `serverName`. */
  server: ReturnType<typeof createSdkMcpServer>;
  /** The key this server MUST be registered under in `mcpServers`. Exposed so the adapter cannot
   *  spell it differently from the name baked into `allowedToolName`. */
  serverName: string;
  /** The allowed tool name to whitelist (`mcp__dahrk__dahrk_stage_complete`). */
  allowedToolName: string;
  /** True once the agent has called the tool. */
  fired(): boolean;
  /** The captured one-sentence summary, or null if the tool has not fired. */
  summary(): string | null;
  /** The captured deliverable document body, or null if none was handed back. */
  document(): string | null;
  /** Invoke the capture directly, exactly as the SDK's MCP handler does - the seam a
   *  `FakeClaudeSession` uses to drive a stage-complete exit without running the live SDK. */
  capture(args: { summary: string; document?: string }): void;
}

export function createStageCompleteTool(): StageCompleteTool {
  let captured: string | null = null;
  let capturedDoc: string | null = null;
  // The capture body the SDK's MCP handler runs; extracted so a `FakeClaudeSession` can drive the
  // tool-exit path without the live SDK. Production still fires via the handler below, unchanged.
  const capture = (args: { summary: string; document?: string }): void => {
    captured = args.summary;
    if (args.document !== undefined) capturedDoc = args.document;
  };
  const completeTool = tool(
    STAGE_COMPLETE_TOOL,
    STAGE_COMPLETE_DESCRIPTION,
    {
      summary: z.string().describe("A one-sentence summary of the stage outcome."),
      document: z
        .string()
        .optional()
        .describe("The full markdown body of the stage's deliverable document, if any."),
    },
    async (args) => {
      capture(args);
      return { content: [{ type: "text", text: "Stage marked complete." }] };
    },
  );
  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: "0.0.0", tools: [completeTool] }),
    serverName: MCP_SERVER_NAME,
    allowedToolName: STAGE_COMPLETE_TOOL_NAME,
    fired: () => captured !== null,
    summary: () => captured,
    document: () => capturedDoc,
    capture,
  };
}
