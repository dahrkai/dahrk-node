# @dahrk/edge

The brain of a Dahrk edge node. Dials out to the hub; runs stages; reports back. No inbound ports.

- **WebSocket client** (`startEdgeNode`, `src/ws-client.ts`): advertise runtimes/repos on connect,
  heartbeat, reconnect; answer each `job` with a `result` keyed by `awakeableId`.
- **Stage runner** (`createStageRunner`, `src/stage-runner.ts`): Job -> Runner invocation in a real
  git worktree (sticky owner, reused on re-dispatch); stream progress, write the normalised trace and
  scratch `state.json`, enforce policy, and run the stage-exit hooks.
- **Policy evaluation** (`evaluatePolicies`, `src/policy.ts`): compose rules in declared order, first
  `deny`/`ask` short-circuits, around tool actions and at stage entry; a `deny` surfaces as a
  tool-error observation + `policy-deny` state in the trace.
- **Stage-boundary hooks**: the engine fills `JobRequest.hooks` from the workflow's `stage-exit`
  hooks; the runner runs them in the worktree, and a non-zero exit fails the stage.

The hub<->edge wire protocol lives in [`@dahrk/contracts`](https://www.npmjs.com/package/@dahrk/contracts)
(the shared seam), so the edge does not depend on the hub. Runtime dep: `ws`. The real runner adapters
(Claude Agent SDK / Codex SDK) live in `@dahrk/executor-worktree` behind the same `Runner` interface.

## Run

- `pnpm --filter @dahrk/edge test` - policy and stage-runner unit tests (pure, no Docker).
