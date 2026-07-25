/**
 * The name coupling nothing else asserts. The SDK exposes an in-process MCP tool as
 * `mcp__<mcpServers key>__<tool name>`, so three independently-written strings have to agree: the key
 * the adapter registers the server under, the tool's own name, and the `allowedTools` entry. Nothing
 * reads the `Options` object the adapter builds (the FakeClaudeSession receives it and discards it),
 * so before this a typo in any one of them broke every interactive stage in production while the whole
 * suite stayed green - the stage would simply never be able to exit and would time out.
 *
 * These assertions are deliberately literal. The point is to fail if the wire name changes, so a
 * rename has to be a conscious edit here rather than a silent production break.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createStageCompleteTool,
  STAGE_COMPLETE_DESCRIPTION,
  STAGE_COMPLETE_TOOL_NAME,
} from "../src/stage-complete-tool.js";

test("the exposed tool name is exactly what the SDK will derive from the server and tool names", () => {
  const t = createStageCompleteTool();
  assert.equal(STAGE_COMPLETE_TOOL_NAME, "mcp__dahrk__dahrk_stage_complete");
  assert.equal(t.allowedToolName, STAGE_COMPLETE_TOOL_NAME);
  // The server must be registered under this key, or the derived name above never resolves.
  assert.equal(t.serverName, "dahrk");
  assert.equal(STAGE_COMPLETE_TOOL_NAME, `mcp__${t.serverName}__dahrk_stage_complete`);
});

test("capture records the summary and the optional document handback", () => {
  const t = createStageCompleteTool();
  assert.equal(t.fired(), false);
  assert.equal(t.summary(), null);
  assert.equal(t.document(), null);

  t.capture({ summary: "Wrote the spec." });
  assert.equal(t.fired(), true);
  assert.equal(t.summary(), "Wrote the spec.");
  assert.equal(t.document(), null, "an omitted document must stay null, not become undefined-ish");

  t.capture({ summary: "Revised.", document: "# Spec\n\nBody." });
  assert.equal(t.summary(), "Revised.");
  assert.equal(t.document(), "# Spec\n\nBody.");
});

test("the tool description does not claim interactive stages cannot write files", () => {
  // Interactive stages have full tool parity with batch; the S2 gating was reversed after a denied
  // Write both starved `attach-document` and derailed a model into a timeout. This description ships
  // to the model, so a claim that it cannot write files invites exactly that behaviour with no deny.
  assert.ok(
    !/cannot write files/i.test(STAGE_COMPLETE_DESCRIPTION),
    "tool description must not tell the model it cannot write files",
  );
  assert.ok(
    !/only way/i.test(STAGE_COMPLETE_DESCRIPTION),
    "tool description must not call `document` the only route to emit a document",
  );
});
