/**
 * A job that throws BEFORE the turn loop must still be classified.
 *
 * The stage runner's own loop classifies what fails inside it (`classifyRuntimeError`), but everything
 * that throws on the way IN - resolving the brokered auth profile, preparing the worktree - lands in
 * the edge's outer job catch, which shipped a bare `status: "fail"` with no `failureClass` at all. The
 * hub then had nothing to go on but the summary string, and its `external` rule matches any mention of
 * a vendor. So "no Anthropic credential in the brokered auth profile" - an operator who bound the pool
 * to a Copilot or OpenAI subscription a `claude-code` stage cannot use - was billed as an ANTHROPIC
 * OUTAGE, on five consecutive runs. Exactly backwards: the vendor was healthy and only the operator
 * could fix it.
 *
 * The node knows the answer at the point of the throw, so it says so rather than leaving the hub to
 * guess from prose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { decode, encode, type EdgeToHub, type JobRequest } from "@dahrk/contracts";
import { startEdgeNode } from "../src/ws-client.js";

const TOKEN = "sket_good";

const welcome = encode({
  type: "welcome",
  nodeId: "n1",
  name: "brave-otter",
  tenantId: "t_node",
  credentialMode: "ambient",
  heartbeatMs: 5000,
  allowedRepos: [],
});

const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A hub that welcomes the node, pushes one job, and records the result frame it gets back. */
async function withHub(
  job: JobRequest,
  fn: (ctx: { url: string; results: Array<Extract<EdgeToHub, { type: "result" }>> }) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", r));
  const results: Array<Extract<EdgeToHub, { type: "result" }>> = [];
  wss.on("connection", (sock) => {
    sock.on("message", (raw) => {
      const msg = decode<EdgeToHub>(raw.toString());
      if (msg.type === "hello") {
        sock.send(welcome);
        sock.send(encode({ type: "job", job } as never));
        return;
      }
      if (msg.type === "result") results.push(msg);
    });
  });
  const { port } = wss.address() as AddressInfo;
  try {
    await fn({ url: `ws://127.0.0.1:${port}`, results });
  } finally {
    wss.close();
  }
}

/** A job that cannot possibly run: the gitUrl is unresolvable, so preparing the worktree throws before
 *  any runtime is reached - the same shape as an auth-profile throw, which is the case that motivated
 *  this but needs a broker to reproduce. */
const failingJob = (): JobRequest =>
  ({
    jobId: "job-1",
    awakeableId: "awk-1",
    runId: "run-1",
    stageId: "analyse",
    tenantId: "t_node",
    agentConfig: { runtime: "claude-code", prompt: "noop" },
    workspaceRef: {
      repoId: "r",
      repo: "acme/nope",
      gitUrl: "file:///definitely/not/a/repo/at/all",
      baseBranch: "main",
      worktreePath: "/tmp/dahrk-test-nope",
      scratchPath: "/tmp/dahrk-test-nope/.dahrk/scratch",
    },
  }) as unknown as JobRequest;

test("a job that throws before the turn loop still answers, and the summary names the fault", async () => {
  await withHub(failingJob(), async ({ url, results }) => {
    const abort = new AbortController();
    try {
      await startEdgeNode({
        hubUrl: url,
        runtimes: ["claude-code"],
        enrolToken: TOKEN,
        signal: abort.signal,
        worktreesDir: "/tmp/dahrk-test-worktrees",
      });
      await waitFor(() => results.length === 1);

      const result = results[0]!.result;
      assert.equal(result.status, "fail");
      // The awakeable is always resolved: a throw on the way in must never leave the hub waiting out a
      // dispatch deadline on a node that already knows the answer.
      assert.equal(results[0]!.awakeableId, "awk-1");
      assert.match(result.summary ?? "", /edge error:/);
    } finally {
      abort.abort();
    }
  });
});

test("a failure the classifier does not recognise carries no class, rather than a guessed one", async () => {
  // The other half of the contract, and the reason this is `classifyRuntimeError` rather than a blanket
  // label: a git checkout failure is not a config gap, and asserting one would be a different lie from
  // the one being fixed. Unlabelled here is correct - the hub's own heuristic then applies.
  await withHub(failingJob(), async ({ url, results }) => {
    const abort = new AbortController();
    try {
      await startEdgeNode({
        hubUrl: url,
        runtimes: ["claude-code"],
        enrolToken: TOKEN,
        signal: abort.signal,
        worktreesDir: "/tmp/dahrk-test-worktrees",
      });
      await waitFor(() => results.length === 1);
      assert.equal(results[0]!.result.failureClass, undefined);
    } finally {
      abort.abort();
    }
  });
});
