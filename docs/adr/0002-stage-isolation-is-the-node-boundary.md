# ADR 0002 - Stage isolation is the node boundary, not a per-stage container

**Confidentiality:** Public
**Status:** DRAFT - UNREVIEWED

## Context

There is no existing ADR on stage isolation, sandboxing, or untrusted code execution, and the question
has been rediscovered and re-answered from scratch more than once. Two prior attempts — DHK-91
("Docker-isolate edge nodes on the Mac") and DHK-1 ("Unmanaged-container node mode + credential
injection") — were both cancelled. A third investigation happened in August 2026 when a
`✓ docker available` row in the node health dialog prompted "what would it actually take to run
workflows in Docker?".

The answer, established by that investigation, is recorded here so the ground is not walked a fourth
time.

## Decision

**The isolation boundary is the node process and the host it runs on.** A stage is confined by
`fs_confine` (a tool-argument guard — it inspects paths named in tool arguments, not a syscall wall),
optionally by the SDK's OS sandbox (`DAHRK_SANDBOX=1`, opt-in, and its own comment notes the SDK's
docs and schema disagree about what it enforces), and by whatever boundary the operator places around
the node itself. We are not supporting per-stage container isolation at this stage.

A self-hosted node stays as simple as possible. An operator who wants a container boundary puts one
around the whole node — which already works today, and is how the platform diagnostics node ships.

## Why not per-stage containers now

A container Pi path exists in the codebase. It is **internal, unsupported, Pi-only, and imageless**.
Its status:

- **Scope.** It is wired only for telemetry-only meta-loop stages. It mounts `.dahrk/scratch` only;
  the worktree alone would not help because a linked worktree's `.git` is a pointer file into the
  mirror, so no git command works inside the container without the mirror mounted too.
- **Image.** The image it names (`dahrk/pi:latest`) is not built anywhere in this repository. The
  container path has never run against a real Docker daemon in production.
- **Observability.** A crashed container is not observed: when the container dies unexpectedly the
  stage hangs rather than fails, because `PiRpcSession` awaits an `agent_end` event that never arrives.
- **What is done.** The RPC transport — driving `pi --mode rpc` over stdio, the pre-execution gate,
  structured elicitation, and cost reporting — is complete and well-tested at the wiring level. The
  image and the filesystem/credential story are the long poles.

## The decisive finding: brokered MCP cannot reach a containerised agent (DHK-1055)

Brokered MCP cannot be threaded to a containerised agent. This is a **protocol limit of the pinned
Pi** (`@earendil-works/pi-coding-agent@0.84.1`), not unfinished work:

- Pi ships **no built-in MCP at all**. The embedded path implements MCP entirely on the Dahrk side,
  via an in-process extension (`createBrokeredMcpExtension` -> `pi.registerTool`). A `pi --mode rpc`
  subprocess has no analogue for this: the host cannot inject an in-process extension into the child.
- The RPC command surface (`dist/modes/rpc/rpc-mode.js`; `docs/rpc.md`, which never mentions MCP) is
  a closed switch — prompt/abort/get_state/get_session_stats/… — with no tool- or MCP-registration
  command. The host cannot declare the brokered servers' tools into the running agent.
- The only subprocess-initiated host-callback the protocol emits is `extension_ui_request` (a fixed
  set of UI dialogs: select/confirm/input/editor). The gate and elicitation ride this, but there is no
  generic frame to tunnel an MCP call back to the host. The gate/elicit precedent does not transfer:
  those piggyback on Pi's native per-tool `tool_call` hook and native custom tools; MCP has no native
  Pi hook to piggyback on.

So this gap is not ours to close at any effort against the current Pi pin. Delivering brokered MCP to
a containerised Pi would require either an upstream Pi RPC MCP/tool-registration surface, or a new
Dahrk protocol (host lists the tools via a spawn argument plus an image-side bridge extension emitting
an `mcp_request`/`mcp_response` stdio tunnel like the gate's `tool_call_request`) — and the bridge
would live in the image, not here.

## Why claude-code cannot follow the Pi path — stated precisely

The blunt version — "Claude has no RPC mode" — is wrong. The Claude Agent SDK *does* speak a stdio
control protocol, spawning the Claude Code executable and exchanging `control_request`/`control_response`
including `can_use_tool`. The asymmetry is **which side of that boundary we are on**.

The SDK's stdio protocol is internal, used by the SDK to talk to the Claude Code CLI it spawns. We are
the SDK's *caller*, one level up. The pieces that would have to cross a container wall —

- the `canUseTool` policy evaluator, and
- `stage-complete` / `AskUserQuestion` as in-process SDK MCP servers —

execute inside our own V8, wired directly to the SDK as in-process callbacks. Pi's `--mode rpc` is a
documented, supported *external* interface intended for exactly this kind of host-process control. The
Claude Agent SDK exposes no equivalent external interface to the SDK's caller.

Containerising a Claude stage therefore means putting the **whole stage runner** inside the container.
That container then needs the git credential, the worktree, the mirror and the hub socket. This is a
different architecture — not a flag.

## What RPC buys and what it costs

A process boundary has to carry six concerns to remain governable:

| Concern | How Pi's RPC carries it |
|---------|------------------------|
| Drive | `prompt` command |
| Stop | `abort` command |
| Watch | event stream (`agent_end`, `message_update`, …) |
| Gate | `tool_call_request` / `tool_call_response` frame |
| Ask | `elicit_request` / `elicit_response` frame |
| Account | `get_session_stats` command |

Pi's RPC carries all six. The two *inbound* concerns — gate and elicitation — are what keep a
containerised stage governable: the stage can be denied a tool call, and it can ask a human a
question, across the process boundary.

Against that, in-process is genuinely better on fidelity:

- The gate is a direct function call with no protocol to version.
- `summarise`'s tool-denial can mutate the agent's tool state directly (`s.agent.state.tools`) — this
  is impossible over RPC, hence `capabilities.summariseToolDenial = false` on the RPC path.
- Brokered MCP works because the gateway is in the same network namespace.
- There is no image to build, publish, pin, or patch.

**RPC buys isolation and costs fidelity. Today we have full fidelity and no isolation, and for
claude-code there is no lever to pull at all.**

## ADR 0005 corollary

If per-stage isolation ever becomes real, it must be an **explicit declared property** of the node,
never detected from the host environment.

Auto-detecting Docker and switching execution mode would make the same job behave differently depending
on what happened to be installed on whichever machine picked it up — precisely the invisible,
outcome-bearing routing input that ADR 0005 in dahrk-harness forbids, and which was amended in
DHK-1059 for the node pin. The existing `DAHRK_PI_ISOLATION=container` flag is the right shape: it is
explicit, operator-set, and scoped to the Pi runtime.

## What this does not close

The **managed tier**. The harness idea bank argues for dedicated long-lived VMs over ephemeral
container instances, and ADR 0005 already notes the hub can no longer distinguish a managed node from
a self-managed one. This ADR is about the *stage* isolation boundary and does not touch the managed
tier architecture.

## Prior art

- **DHK-91** ("Docker-isolate edge nodes on the Mac") — cancelled.
- **DHK-1** ("Unmanaged-container node mode + credential injection") — cancelled.

Both were considered before this ADR was written. The decision here reflects the same conclusion
reached by both, now with a concrete upstream protocol finding (DHK-1055) added to the record.

## Sources

- `packages/executor-worktree/src/pi-rpc-client.ts` — capability declarations and the DHK-1055
  diagnosis in its header; the bidirectional gate/elicitation protocol.
- `packages/executor-worktree/src/pi-container.ts` — the container Pi session factory; the module
  header documents the filesystem/credential gaps.
- `packages/edge/src/fs-roots.ts` — what `fs_confine` is: a tool-argument guard over named paths, not
  a syscall wall.
- `packages/executor-worktree/src/claude-adapter.ts` — `DAHRK_SANDBOX=1` and why it is opt-in.
- Related: DHK-1055 (upstream brokered-MCP limit), DHK-506/DHK-7 (how the Pi container path was
  built), DHK-1059 (node-pin amendment to ADR 0005).
