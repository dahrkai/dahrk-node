/**
 * Trace writer tests: JSONL lines, a finalised meta.json, and blob spill for
 * large payloads. No external services.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceMeta } from "@dahrk/contracts";
import { createTraceWriter } from "../src/trace-writer.js";

const meta: TraceMeta = {
  tenantId: "t_default",
  runId: "run-trace-test",
  stageId: "build",
  jobId: "job-1",
  attempt: 1,
  runtime: "claude-code",
  configDigest: "sha256:abc",
  startedAt: "2026-06-21T00:00:00Z",
};

test("trace writer appends JSONL, finalises meta, and spills large payloads", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dahrk-scratch-"));
  const w = createTraceWriter(scratch, meta, { spillBytes: 32 });

  w.append({ seq: 0, ts: "2026-06-21T00:00:01Z", type: "thought", runtime: "claude-code", text: "small" });
  const big = "x".repeat(100);
  w.append({ seq: 1, ts: "2026-06-21T00:00:02Z", type: "response", runtime: "claude-code", text: big });
  w.finalise({ status: "ok", endedAt: "2026-06-21T00:00:03Z" });

  const lines = readFileSync(join(w.dir, "trace.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "one JSONL line per event");

  const small = JSON.parse(lines[0]!);
  assert.equal(small.text, "small", "small payload stays inline");

  const spilled = JSON.parse(lines[1]!);
  assert.equal(spilled.text, undefined, "large payload is removed from the line");
  assert.ok(typeof spilled.textRef === "string" && spilled.textRef.startsWith("blobs/"), "referenced by textRef");
  assert.ok(existsSync(join(w.dir, spilled.textRef)), "blob file written");
  assert.equal(readFileSync(join(w.dir, spilled.textRef), "utf8"), big, "blob holds the full payload");

  const finalMeta = JSON.parse(readFileSync(join(w.dir, "meta.json"), "utf8")) as TraceMeta;
  assert.equal(finalMeta.status, "ok");
  assert.equal(finalMeta.endedAt, "2026-06-21T00:00:03Z");
});
