# dahrk-node - domain model

**Confidentiality:** Public
**Status:** DRAFT - UNREVIEWED

`dahrk-node` is the installable edge client (Apache-2.0). Run and enrolled with a hub, it becomes an
**edge node** and executes workflow stages in a git worktree. The shared kernel below is the cross-repo
vocabulary (mirrored from the harness workspace); the terms in it - hub, edge node, run, stage, job,
worktree, runner adapter, trace - are the product language this client implements.

<!-- BEGIN shared-kernel (canonical: workspace-root /CONTEXT.md - do not edit in repo copies; run scripts/sync-context.sh) -->
## Shared language (the kernel)

### Product and organisation

**Dahrk**:
The product - a Linear-native agent-workflow harness - and the Linear agent handle (`@Dahrk`) that
users assign or @mention.
_Avoid_: the bot, the agent (when you mean the product).

**Skakel Labs**:
The company that owns Dahrk.
_Avoid_: Dahrk Inc.

### The two deployables

**Hub**:
The single deployed, owned service. Ingests Linear webhooks, authenticates them, hosts the engine,
holds the workflow registry, runs the WebSocket server, and routes Jobs to nodes. The only public
inbound endpoint.
_Avoid_: Server, backend, orchestrator.

**Edge node**:
A deliberate worker (a Mac or a VPS) that connects **outbound** to the hub over WebSocket and runs
stages. It has **no inbound ports**. "Node" always means an edge node. One artifact; the only axis that
distinguishes nodes is **who operates it**.
_Avoid_: Worker, agent, runner (a runner is the thing inside a stage, not the node).

**Self-managed node**:
A node the customer operates, on infrastructure they control. The free-tier default, bring-your-own
compute.
_Avoid_: Unmanaged, self-hosted node (prefer "self-managed"), BYO node.

**Managed node**:
A node Dahrk operates on Dahrk infrastructure, on the customer's behalf. Identical in every other
respect: it enrols to one tenant and is handed the same brokered credentials, so which kind serves a job
can never change the result.
_Avoid_: Hosted node, cloud node, pool (node groups are retired).

**Sandbox**:
The isolated guest a managed node works in: one Firecracker microVM per tenant, on a rig. A whole
machine carrying the repository's toolchain, isolated so an agent reaches nothing it was not given.
This is the **public, customer-facing word**, and the only sense the word is permitted in: **microVM**
is the precise architectural term, **managed node** is the enrolment and billing unit, and **sandbox**
is what a reader already understands from E2B, Daytona and Cloudflare. Never write it next to a usage
meter: the comparable is a dev-VM product, not a metered code-interpreter platform, and the pricing
model turns on that distinction (dahrk-hq D9).
_Avoid_: Container (it is not one, and the difference is the point), VM (unqualified), box, cell,
jail, workspace (Linear owns that word).

### The one rule

**Determinism boundary**:
The invariant that the engine is pure deterministic TypeScript and **no LLM call ever decides control
flow**. Inference happens only inside a stage. Wanting an LLM to choose the next step is a design
error, not a feature.
_Avoid_: Orchestration logic, agentic routing.

**Engine**:
The pure-deterministic workflow runner hosted inside the hub. Sequences stages, evaluates
gates / branches / `on_fail` loops, and dispatches Jobs. Contains no LLM calls.
_Avoid_: Orchestrator, scheduler, controller.

### The work hierarchy

**Workflow**:
The versioned definition of a stage graph for an issue: the ordered stages, their gates, branches,
and loops. Hub-owned and DB-canonical.
_Avoid_: Pipeline, playbook, recipe.

**Subject**:
What a run is **about**, and therefore which surface its questions and results belong to: a Linear
issue, a Slack thread, or nothing at all (an admin, triage or preflight run is about the system
itself). The run's anchor, not its trigger - a continuation run on the same issue carries the same
subject.
_Avoid_: Issue (that is one kind of subject), topic, target, context.

**Run**:
One execution of a workflow, about one Subject. Scope: the whole subject.
_Avoid_: Job (a job is one stage dispatch), session, execution.

**Stage**:
One node in the workflow graph: a runtime + model + prompt/skill + tools + interaction mode. Part of
a run.
_Avoid_: Step, task, phase.

**Job**:
One dispatch of one stage to one executor - the unit the engine hands to a node, correlated by
`jobId`. The load-bearing seam between engine and executor.
_Avoid_: Turn (deprecated), task, message.

**Check stage**:
A stage that runs named deterministic commands in the worktree, where the **exit code is the verdict**.
It has no runtime, no model and no cost, but it is still dispatched to a node because it needs the
worktree. It is the determinism boundary applied to verdicts rather than only to routing: "the tests
pass" becomes a fact instead of an inference an agent makes about its own work. A workflow names checks;
the repo's declared **check map** says what each name runs, so a central workflow stays
language-agnostic.
_Avoid_: Test stage, lint stage, hook (a hook is workflow-level and has no id, gate or `goto` target),
gate (a gate is a human pause).

**Check**:
One named command in a repo's check map (`lint`, `typecheck`, `test`, a security scan, a formatter in
`--check` mode). Every check a stage declares runs even after one fails, so a single loop-back carries
every defect. Each yields one **verification** (`passed` / `failed` / `skipped`).
_Avoid_: Expected check (that is the CI check set a repo declares it expects to observe on a PR - a
different concept with a confusingly similar name).

**Attempt**:
One (re-)dispatch of a stage. A re-run writes `attempt-<n>/`; earlier attempts are never clobbered.
_Avoid_: Retry, try.

### The execution surface

**Worktree**:
The git worktree created once at run start and shared by every stage, torn down at run end. The
carrier of context between stages (never a live LLM conversation - stages swap runtimes).
_Avoid_: Checkout, clone, sandbox (a **Sandbox** is the machine; a worktree is a directory on it, and
on a self-managed node there is no sandbox at all).

**Runner adapter**:
A thin wrapper over a vendor agent SDK (Claude Agent SDK, Pi) implementing the internal
`Runner` interface. One per runtime. Produces the normalised trace.
_Avoid_: Driver, plugin, agent.

**Trace**:
The per-stage raw execution record: a normalised JSONL event stream of the agent's actions.
_Avoid_: Log, transcript, history.

**Summary**:
The engine-owned, one-paragraph index into a stage's trace, surfaced to Linear and handed to the next
stage. Not the sole carrier of context.
_Avoid_: Report, digest.

### Identity and authentication

**Tenant**:
The top isolation boundary: one customer's members, integrations, credentials, repositories and runs.
Tenant 0 is the platform itself, not a customer.
_Avoid_: Org, customer, account (as synonyms).

**Integration**:
Any outside system the account links: a tracker (Linear), a code host (GitHub), a chat surface
(Slack), a model provider (Anthropic, OpenAI). The **user-facing umbrella term**, and the name of the
portal surface that holds them. An integration is a *provider*; the records beneath it (a Connection,
an Installation, an AuthProfile) are its *instances*.
_Avoid_: Connection (as the umbrella), plugin, app.

**Connection**:
One Linear OAuth app install acting as an agent (`actor=app`). The unit of authentication, and the
instance behind the Linear integration. One per tenant. Internal: it is never a menu label, because a
user thinks in workspaces and providers, not in auth records.
_Avoid_: Integration (that is the umbrella), install, org.

**Installation**:
One GitHub App install of the **broker App**, granting repository access to a tenant. The instance
behind the GitHub integration; one per tenant. Distinct from the **sign-in OAuth app** behind
"Continue with GitHub", which is identity and grants nothing: conflating the two produced a
cross-tenant IDOR, so name which GitHub you mean.
_Avoid_: Connection, GitHub integration (the integration is the provider, this is its instance).

**Slack Installation**:
One Slack app install binding a tenant to a Slack workspace. The instance behind the Slack integration;
one per tenant, exactly parallel to the GitHub **Installation**. Channels are *routing configuration*
inside it, never identities: there is one `@Dahrk`, and what varies per channel is which repository a
run defaults to.
_Avoid_: Slack connection, bot, persona, agent (there is one agent).

**Workspace**:
A Linear workspace exposed by a Connection. Contains the issues that become runs. The name a person
recognises, so it is what a surface prints for a Connection.
_Avoid_: Org, team (a team is a subdivision of a workspace).

**AuthProfile**:
The tenant-owned record naming a provider and the credential that authenticates **inference** for it. Its
provider decides the **runtime** (`anthropic` -> Claude Code, everything else -> Pi) and its `defaultModel`
decides the model, so it is the single fact behind "how does this stage think". Resolved in exactly two
rungs: the stage's own reference, else the account default.
_Avoid_: API key, credential (a credential is what the profile points at), model config.

**Env profile**:
The tenant-owned bundle of **non-secret** `{ envVar -> literal }` entries that points a stage at a dev or
mock endpoint instead of production. Deliberately the same two-rung ladder as an AuthProfile, so one
sentence describes both. Never carries a secret.
_Avoid_: Environment, config, settings.

**Placement**:
Which node the hub gives a job to. Decided on capability and availability alone, and **inert**: any node
that can serve a job produces the same result. Placement is never an input to which model, which credential
or which repository a run gets.
_Avoid_: Assignment, scheduling, node routing (there is no such routing).

**Broker**:
The hub component that turns a stored `credentialRef` into the credential a job carries. It **mints**
where the provider allows it (a GitHub App installation token, scoped to one repo, about an hour) and
**forwards** where it does not (a third-party API key has no exchange endpoint, so there is nothing to
mint from).
_Avoid_: Vault, secret store (it deliberately brokers rather than stores).

**Brokered credential**:
Any credential the hub attaches to a job: the git token, an MCP server's key, the inference credential.
There is no other kind. A node holds none of its own and reads nothing from the machine it runs on - not
its SSH key, `gh` login, `claude` login, keychain, or provider environment variables. "Brokered" says
where a credential came from, not how long it lives.
_Avoid_: Ambient credentials, credential mode, brokered node (retired: there is no non-brokered
alternative for either to distinguish).

**Secret**:
A credential a **node** uses while running a stage: a cloud key, an MCP server's key, anything a
repository's build needs. An input to the work, never a way to reach a model. Distinct from what an
AuthProfile points at, even though both are stored as credential rows.
_Avoid_: Credential (broader), API key, auth profile.

**Account**:
One customer's tenancy of the product, as a person experiences it: their members, their preferences,
their integrations. The user-facing word for what the code calls a Tenant. "Account default" (the
fallback AuthProfile) is scoped to exactly this.
_Avoid_: Factory (retired), organisation, workspace (that is Linear's).

**Repository**:
A registry row binding a git repo to routing (`teamKeys`, `routingLabels`, `projectKeys`) and to the
Connections allowed to send it issues. It is what a run is executed against, in a worktree on a node.
_Avoid_: Repo config, project, codebase.

### The control surface

**Control surface**:
Where a run is driven from and reported to: progress, the stage graph, gates, drive and cancel. A run
has exactly one, decided by its Subject. **Linear** uses the Agent Session API natively: activities for
progress, the agent-plan checklist for the stage graph, elicitations for gates, the `prompted` webhook
for drive, the `stop` signal for cancel. **Slack** uses the Events API and Block Kit in the subject's
thread. A surface must be able to *answer*, not merely display: a run may only start on a workflow
whose every gate its surface can raise and resolve.
_Avoid_: UI, dashboard, API (when you mean this specifically), notification (a sink is not a surface).

**Gate**:
A deterministic pause of the **run** for a human, raised as a Linear `elicitation`. Used between stages
and by an `ask` policy verdict. The run's status becomes `awaitingInput` and **nothing is held**: no job
is in flight, and the wait may be days.
_Avoid_: Approval, checkpoint, pause.

**In-stage question**:
A question an **interactive stage** asks while its own work is still in flight. The run stays `active`
and carries an `awaitingHuman` health flag, because a live agent session is parked waiting for the answer.
The distinction from a gate is not cosmetic: a gate holds nothing and can outlive the machine, whereas an
in-stage question holds a running session that dies with it.
_Avoid_: Gate, elicitation (Linear's activity type carries both, so it names the wire, not the concept).

### What a reviewer may see

Three separate capabilities, deliberately not one. They differ by what they expose, not by size, and the
names are load-bearing: conflating them is how a link ends up serving a machine that holds credentials.

**Browse**:
Reading a run's worktree - listing directories, opening a file - while the work is still uncommitted.
Needs no running process and no credentials, so it is available on any node, including a self-hosted one,
at any point in a run.
_Avoid_: Diff (a diff is a comparison; this is the files themselves), file viewer, explorer.

**Preview**:
The change under review, running, reachable over HTTPS from the review surface. Served by a **separate
credential-free guest**, never the one the agent worked in, and private by default: only the run's tenant
can open it. Offered at stages that declare how the repository is served; a stage with nothing built yet
has none.
_Avoid_: Deploy preview, staging (an environment is a different thing), demo, sandbox (the preview
guest is a second guest beside the run's **Sandbox**, holding no credentials; calling both "the
sandbox" is exactly the conflation these three names exist to prevent).

**Debug terminal**:
A shell in the **agent's own** environment, for diagnosing a run that has stalled or misbehaved. Sees what
the agent sees, and therefore sits next to the run's credentials, so it is a deliberate, audited,
owner-only action rather than a link beside the preview.
_Avoid_: Terminal (unqualified - a preview terminal is a different, credential-free thing), SSH, console.

**Policy**:
A deterministic guard returning `allow` / `deny` / `ask` around a tool call or at stage entry. Never
an LLM call; never chooses the next stage.
_Avoid_: Rule, guardrail, filter.

### The shared code seam

**`@dahrk/contracts`**:
The published npm package carrying the wire protocol (Job request/result, WebSocket frames, the trace
envelope, data classification). The literal shared kernel in code; hand-published from the harness.
_Avoid_: The SDK, the types package, the API.
<!-- END shared-kernel -->

## Node-local language

**Enrolment**:
The one-time exchange that turns an installed `dahrk-node` into a trusted edge node: it advertises to
the hub and presents a short-lived hub-minted enrolment token over the WebSocket.
_Avoid_: Registration, pairing, login.

**Brokered credential**:
Any credential the hub attaches to a job: the git token, an MCP server's key, the inference credential.
The node holds none of its own and reads none from the machine it runs on. "Brokered" says where the
credential came from, not how long it lives - the git token is minted and short-lived, while an MCP or
API key is the stored secret forwarded, because a third-party key has nothing to mint from.
_Avoid_: Ambient credentials, credential mode, brokered node (there is no other kind; see
`docs/adr/0001-a-node-reads-no-host-credentials.md`).

**Credential latch**:
This node's memory of a runtime whose brokered credential the provider has **refused**, so it stops
advertising a runtime it cannot actually run. A latch rather than a probe: "is this credential still
good" has no cheap honest answer that does not involve spending it, so detection does not poll - it
remembers what a failed stage already proved. It is fed **evidence** (a finished stage's runtime,
status and summary) and owns the judgement of what counts as a refusal; a later successful stage
clears it, so a re-credentialled node recovers with no restart. Per-process, so `dahrk doctor` cannot
observe the running node's latch.
_Avoid_: Credential cache, health check, probe (it is evidence, not inference).

**Mirror cache**:
The edge-local bare-repo cache (`~/.dahrk/mirrors/<repoId>`) the node fetches into before creating a
worktree, so repeated runs against a repo do not re-clone.
_Avoid_: Cache, local clone.

**RuntimeSession**:
The loop-facing, turn-level port inside `executor-worktree` (`sendTurn` / `summariseTurn` / `cost` /
`dispose`), declared in `runtime-session.ts`, that the one shared interactive/batch loop
(`runInteractiveLoop` / `runBatchLoop` in `turn-loop.ts`) drives. Each runtime implements it and keeps
its native-event mapping and stage-complete detection inside the session, so the loop never sees a
`PiEvent` or `SDKMessage`. Both Pi back-ends (embedded and container) drive it. Distinct from the
lower `PiSessionLike` transport seam (`subscribe` / `prompt` / `abort`), which stays the SDK/RPC-facing
boundary beneath it.
_Avoid_: Session (unqualified), runner (a runner is the `Runner`-shaped adapter wrapping this).

## Sources

- Workspace-root `CONTEXT.md` - the shared kernel this file mirrors.
- `docs/adr/0001-a-node-reads-no-host-credentials.md` - why a node holds no credentials of its own.
- `docs/logging.md` - the node's edge-local logs, crash records, and `dahrk diagnose`.
