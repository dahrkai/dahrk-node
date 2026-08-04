# Changelog

All notable changes to the `dahrk-node` edge client are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.3] - 2026-08-04

### Fixed

- **An update triggered from the portal took the node down and kept it down.** The upgrade itself
  worked: the new build was installed, and then the node had to restart to run it. It did that by
  unloading its own service and loading it again, which cannot work when the thing being unloaded is
  the process doing the unloading. The node was killed halfway through, so it never got to the second
  half, and on macOS the unload also marked the service disabled, so nothing brought it back at login
  either. The node stayed down until someone restarted it by hand, and the portal sat on "restarting"
  for a node that no longer existed. Restarts now ask the service manager to restart the node, which
  it does by replacing the process itself. A restart from the terminal is unchanged. (#170)
- **A stage that failed before it began was reported as a provider outage.** Anything that goes wrong
  on the way in to a stage - a credential the runtime cannot use, a worktree that will not prepare -
  was sent to the hub as a bare failure with no indication of whose fault it was. The hub fell back to
  reading the message, and a message mentioning a provider reads as that provider being down. Binding
  a node group to a subscription its runtime cannot speak to therefore showed up as an Anthropic
  outage, which is both wrong and unactionable. The node now says what kind of failure it was at the
  point it happens, so a configuration gap is reported as one. (#170)

## [0.3.2] - 2026-08-04

Maintenance release: no change to how the client behaves. It adds test coverage for the shell
confinement scanner, which decides what a stage's commands are allowed to touch in the worktree, and
pins the two defects fixed in earlier releases as regressions. (#168)

## [0.3.1] - 2026-08-04

### Fixed

- **Check stages could not run at all: every one crashed the moment it reached the node.** A check stage
  runs named commands in the worktree and takes the exit code as the verdict, so unlike an agent stage it
  has no runtime and no model configuration. The node nonetheless reached for that configuration when
  arming the watchdog that cancels a stage producing no output, and threw before a single check command
  ran. Nothing about the check itself mattered; a repo declaring any check could not use one. (#166)
- **A refused credential during an interactive stage put the runtime back into service instead of taking
  it out.** When a provider refuses the credential a node was handed, the node remembers and stops
  advertising that runtime, so it does not keep accepting work it has just proved it cannot do. On a
  batch stage that worked. On an interactive stage the refusal was recorded in the trace but the stage
  still reported success, and a successful stage is exactly the signal that says the credential is
  healthy again, so a refusal cleared the record rather than creating one. A node with a dead credential
  therefore kept taking interactive work indefinitely. An interactive stage now reports a refused
  credential as a failure the agent is not answerable for, and no longer spends a second refused call
  trying to summarise on the session that just failed to authenticate. Stages that fail for ordinary
  reasons are unaffected. (#166)
- **`dahrk status` no longer reports a previous run's failure as the current state.** The node's log is
  appended to across restarts and nothing in it identified which run wrote a line, so status simply read
  the newest connection marker in the file. A node that had been rejected, fixed, restarted and welcomed
  minutes ago was still described by the rejection from hours earlier: "the hub rejected this node's
  enrolment token; it is serving no Jobs", printed underneath a node that was serving perfectly well, and
  exiting non-zero to match. Every log line now records its process, and status only believes the one that
  is running. A node that is up but has not finished connecting says so rather than borrowing the last
  thing a dead process said. (#165)
- **`dahrk start` waits for the node to reach the hub before reporting on it.** It printed its status
  block the moment the supervisor said the unit was up, several seconds before the connection had been
  made, so the report described a node that had not connected yet. It now gives the node up to ten seconds
  to settle, and says what it is waiting for. (#165)
- **`dahrk status` stopped reading the entire log to answer one question.** It read and parsed the whole
  of `node.jsonl`, which grows to megabytes on a node that has been up for a while. It now reads only the
  most recent portion. (#165)

## [0.3.0] - 2026-08-03

### Added

- **The node applies an upgrade the hub asks for.** The portal's Update button opens an upgrade request
  on the hub, but this client had no handler for it: the request was dropped, nothing was acknowledged,
  and five minutes later the hub gave up and reported a node that had never gone anywhere as "did not
  reconnect". A node now detects how it was installed, tells the hub whether it can drive its own
  upgrade, and if it can, runs the package manager and restarts onto the new build without needing
  anybody at a terminal. An install the client cannot drive (a `curl` install, a source checkout) says
  so immediately, and the portal shows the command to run by hand instead of waiting. (#161)

### Fixed

- **Connecting a node from the web app now works at all.** `dahrk start --token` checks a token with the
  hub before writing it to disk, and that check was made under a fixed throwaway identity rather than
  this machine's own. Because a connect token is claimed by the first node that presents it, the check
  itself claimed the token, and the node that started seconds later was refused as an impostor: the
  install reported success, `dahrk status` showed the new tenant read straight off the disk it had just
  written, and the node sat parked serving nothing while the setup page waited for it forever. Every
  probe now runs as this node, so checking a token and using it are the same act. (#163)
- **Re-enrolling a node that is already running takes effect.** `dahrk start --token <new>` wrote the new
  token to disk but left the running daemon on the old one, because starting something already running is
  deliberately a no-op. The node kept serving the previous tenant, and its next connection quietly wrote
  the old token back over the new one, so the re-enrolment vanished with no error anywhere. Changing a
  node's enrolment now restarts it. If a stage is in flight the restart is refused, as before, but it now
  says plainly that the token is saved and the node is still on the previous one. (#163)
- **A node that heals itself no longer breaks itself again.** A node whose token the hub rejected parks
  and watches for a better one. On finding it, it reconnected correctly, then cached the *rejected* token
  over the good one, so the next reboot parked forever on a token nothing could improve on. It now caches
  the token the hub actually accepted. (#163)
- **A running node now checks for a new release as often as it says it does.** The daemon woke on the
  same period as the "have we checked recently?" gate, but the timestamp it compares against is written
  when a check finishes, so every wake arrived a fraction of a second too early, did nothing, and left
  no record of having done nothing. The real cadence was half the configured one, and a node could sit
  for ten hours on a six hour interval while reporting itself checked and current. The daemon now wakes
  several times per interval and the gate tolerates a little clock skew. (#161)
- **`dahrk status` no longer puts a tick on an answer it cannot vouch for.** A cached result was
  presented as `✔ up to date` for up to four check intervals - a full day at the default. A release
  published an hour after the last check was reported as "you are current" for the rest of that day.
  The tick is now reserved for an answer from inside the current interval; an older one is reported
  with its age instead, and a genuinely stale one still points at `dahrk update --check`. (#161)
- **A failed update check is recorded rather than passing silently.** The check still fails open, but
  it now notes when it last failed, and the daemon logs the outcome of every check rather than only the
  ones that found an update. A node whose checks have been timing out for a week no longer looks
  identical to one that checked a minute ago. The periodic check also gets a longer timeout than the
  one that runs while an operator waits for a node to start. (#161)

## [0.2.0] - 2026-08-01

### Changed

- **Every credential now comes from the hub, and the node no longer reads your machine's logins.**
  Git authenticates with a short-lived, repo-scoped token the hub mints from the GitHub App
  installation, pull requests are opened by the hub through that same App, and inference authenticates
  on the credential you connected in the portal. The node no longer consults your SSH key, your `gh`
  login, your `claude` login, the macOS Keychain, `~/.claude/.credentials.json`, or provider keys in
  its environment. This removes a class of failure where what a node could do depended on which shell
  started it, or on a token that had been revoked with nothing local changing. (#157)
- **A node advertises a runtime whenever it can execute it.** Runtime detection used to ask a second
  question - is there a login on this host a stage could borrow - and withhold a runtime when the
  answer was no. It now asks only whether the runtime's SDK is installed. The one credential signal
  that remains is a credential the provider has actually refused, which still withdraws that runtime
  until a later stage authenticates. (#157)
- **`dahrk repo add` always registers the HTTPS clone URL.** A brokered token can only be presented
  over HTTPS, so an SSH remote is normalised whether or not this host has a key. Having a key used to
  keep the SSH form, which is what masked the mismatch until a key rotation broke the clone. (#157)

### Removed

- `DAHRK_CREDENTIAL_MODE` (and its `SKAKEL_CREDENTIAL_MODE` alias). There is no longer an ambient mode
  for it to select. (#157)
- The SSH key, `claude` login and `gh` CLI checks in `dahrk doctor` and `dahrk preflight`. None of them
  is consulted when a stage runs, so warning about them pointed at the wrong thing. (#157)

### Fixed

- **A newline no longer let a command slip past worktree confinement.** Confinement splits a shell
  command into segments on control operators and path-checks each, but a raw newline was consumed as
  ordinary whitespace and never became a splitting token, so a multi-line command was scanned as one
  segment. Its first word decided the verdict for every line, so a benign leading command that takes
  no path operands (`echo`, `printf`, `:`, `true`, `false`) waved the rest of the command through, and
  a second line reaching outside the worktree was allowed with no deny and no event. A newline now
  splits a command exactly as a semicolon does, so each line is checked on its own. (#154)
- **A `#` comment no longer denies a command it appears in.** Worktree confinement lexes every shell
  command to path-check its operands, but the lexer had no notion of a `#` comment and read comment
  text as live shell code. An apostrophe in a comment (`# pnpm hasn't run yet`) opened a quote that
  never closed, so the command was refused as unparseable; a path, a backtick or a `$(...)` mentioned
  in a comment was scanned as a real operand and denied as an escape. A `#` at the start of a word now
  opens a comment that is skipped, exactly as a heredoc body is, while a `#` mid-word (`foo#bar`, a URL
  fragment, `--pretty=%h#x`) and a quoted `#` stay ordinary characters. (#155)

## [0.1.31] - 2026-07-31

### Fixed

- **A node running as a background service could fail every stage on a login that was perfectly
  valid.** On macOS the Claude login lives in two stores, and refreshing it rotates the token in one
  while leaving the other holding a token the provider has since revoked. Which store a process reaches
  depends on the security session it was started in, so a node started by `launchd` could read the
  stale copy and fail every stage on its first turn with `401 OAuth access token has been revoked`,
  while the same login worked perfectly from a terminal. The node now resolves the host credential
  itself, picking the freshest one that has not expired and passing it to the runtime explicitly, so
  the answer no longer depends on how the node was started. Detection asks the same question, so an
  expired login grounds the runtime instead of advertising one that cannot work, and a node whose
  stores disagree says so while still running. (#152)

## [0.1.30] - 2026-07-30

### Added

- **A Claude stage can now use an Anthropic subscription (Claude Pro/Max), not just an API key.** A
  brokered auth profile carries an API key in the job's runtime environment, but a subscription has no
  environment variable to carry a secret: its token arrives as an OAuth hint instead. The Claude
  adapter never read that hint, so binding a node pool to a Claude Pro/Max profile credentialled
  nothing at all, and the stage silently fell through to whatever login happened to exist on the host.
  The adapter now applies the subscription's live access token to the runtime subprocess, where the
  agent's own tool calls never see it, and a profile that offers only a subscription for some other
  provider now fails immediately with a message naming the misbinding rather than running
  unauthenticated. (#148)

- **A node stops advertising a runtime once the provider has refused its login.** Detection could only
  ask whether a login existed on the host, which a revoked token satisfies perfectly well, so a node
  with a dead credential kept accepting work and failing every job on its first turn at no cost. The
  node now remembers a refusal reported by an actual stage and withholds that runtime until a stage
  authenticates again, so re-authenticating brings it back with no restart. `dahrk doctor` names both
  the cause and the remedy. (#148)

### Changed

- **The Pi runtime moves to 0.83.0, which changes the model ids a stage can resolve.** Claude Opus 5
  becomes available, and the Fireworks GLM 5.1 entries (`accounts/fireworks/models/glm-5p1` and
  `accounts/fireworks/routers/glm-5p1-fast`) are gone, replaced by Kimi K3 at the equivalent ids. A
  stage pinned to a withdrawn id will no longer resolve it, so check any workflow that names one.
  (#150)

### Fixed

- **A credential the provider refused is no longer reported as the agent failing its task.** An
  expired or revoked login, and an account that has hit its configured spend cap, both surfaced as a
  bare stage failure that read as though the agent had done something wrong. Neither is, and no change
  to a prompt or a workflow can fix either. Both are now attributed to configuration, and the stage
  summary carries the provider's own words, so the run says plainly that the credential needs
  attention. Throttling (a 429) is unchanged: that is a working credential being rate-limited, and it
  is still reported as a transient upstream fault. (#148)

## [0.1.29] - 2026-07-30

### Added

- **A Pi stage now receives pinned components, not just Claude.** The dispatch-time overlay previously
  materialised centrally-provisioned skills, commands and agents only for the Claude runtime and warned
  that no other runtime had a components surface, which was wrong for Pi. Pinned skills are now injected
  into a Pi stage by path, pointing Pi's resource loader straight at the verified pack cache with no copy
  into the worktree; pinned commands are reshaped into Pi prompt templates under `.pi/prompts/`, keeping
  their argument substitution and honouring repo-local precedence and idempotence exactly as Claude does;
  and a pinned subagent warns and is skipped, because Pi intentionally ships no subagents. Claude's
  behaviour is unchanged, and the provision note now distinguishes injected-by-path components from files
  written to disk. (#142)

- **A Pi stage now writes a durable, session instead of an in-memory one that vanished.**
  The Pi runtime built its session with the in-memory manager, which persisted nothing, so a stage's
  transcript was gone the moment the stage ended and the session id it reported was not resumable. The
  adapter now points Pi at a durable session directory under the run's own scratch tree
  (`<worktree>/.dahrk/scratch/pi-sessions`), never the machine-global `~/.pi` and disjoint between runs
  by construction, so nothing from one run is readable by another. The transcript is inspectable after
  the run for debugging and is reaped with the run's worktree on every terminus, cancellation and
  failure included. Handing the adapter a session id now resumes that session, so a retry within a
  stage continues rather than starting cold, matching how the Claude runtime consumes its resume token.
  Cross-stage conversation continuity is deliberately unchanged: the engine summary remains the
  cross-stage carrier, because stages swap runtimes. (#140)

- **A container-isolated Pi stage now enforces the tool gate and can ask a structured question.**
  When Pi runs inside a container over the RPC transport (`DAHRK_PI_ISOLATION=container`), the
  pre-execution tool gate and structured elicitation previously did nothing: the RPC session did not
  implement either registrar, and because both are optional they registered as silent no-ops, so a
  container-isolated stage ran with only post-hoc trace annotation and could not ask a question
  mid-stage. The RPC protocol is now bidirectional for these two concerns: the containerised agent
  asks the host to vet a tool call before it runs (a policy-violating call is blocked before
  execution, with the denial reason handed back to the agent) and to surface a multiple-choice
  question (routed to a Linear elicitation, the human's pick returned into the turn). Both flow
  through the same edge policy and elicit machinery as embedded Pi, so a denial produces the same
  recorded deny and the same agent-visible reason. (#137)

- **A Pi stage can now hand back a document from its stage-complete tool.** The injected
  `dahrk_stage_complete` tool on the Pi runtime takes an optional `document` argument alongside the
  summary, matching the Claude runtime. A stage that ends by calling the tool with a document now
  emits that document as its artifact at `.dahrk/scratch/output/document.md` (or the stage's
  `emitArtifact` path), so a Pi stage feeding a document to the next stage no longer depends on the
  agent having written a file to a conventional location. (#130)

- **A container-isolated Pi stage now reports its real dollar cost and honours the stage's model.**
  When Pi ran inside a container over the RPC transport (`DAHRK_PI_ISOLATION=container`), the session
  reported no cost at all, so a `cost_budget` policy on a containerised stage never accumulated spend
  and sat inert, and the container was spawned on Pi's own default model regardless of what the stage
  asked for, so a workflow pinning a model got something else without saying so. The RPC session now
  queries the containerised agent's session statistics and returns the aggregate as the stage's
  `costUsd`, leaving it unset rather than fabricating a `0` when the figure genuinely cannot be read.
  The stage's model is resolved through the same selection and auth-profile path the embedded runtime
  uses and passed to the container on spawn; a model that cannot be resolved now fails the stage
  outright instead of silently falling back. (#139)

### Changed

- **A container-isolated Pi stage now fails loudly on a capability it cannot honour, instead of
  degrading in silence.** When Pi runs inside a container over the RPC transport
  (`DAHRK_PI_ISOLATION=container`), the session supports a different subset of the runtime interface
  than the embedded in-process session, and that difference used to be invisible: a missing capability
  was reached through an optional method that quietly did nothing, so a capability regression looked
  identical to a capability that was never there. Each Pi back-end now declares an explicit capability
  surface (pre-execution tool gate, structured elicitation, cost reporting, brokered MCP, summarise-turn
  tool denial), and the runner checks a stage's needs against it before the first turn. A stage that
  requires a security-critical capability the session lacks (the pre-execution gate for a policy-gated
  stage, or elicitation for an interactive stage that could ask a question) now refuses outright rather
  than running without it; a gap in a non-critical capability (the container path still cannot register
  brokered MCP servers) emits a `capability-degraded` event into the run's trace and continues, so an
  operator reading the run sees the loss rather than inferring it from a missing figure. No capability
  is added here; this only stops the existing gaps failing silently. (#143)

- **A Pi interactive stage now receives its instruction as a system prompt, matching the Claude
  runtime.** Previously the Pi runtime delivered the whole resolved stage prompt (ticket context,
  guidance, gate feedback, attached documents, comments and check failures) as a synthetic opening
  user turn, so the model read its standing instructions as though a human had just typed them and
  they competed with the actual conversation rather than framing it. The Pi adapter now appends the
  stage instruction to the session's system prompt through the resource loader, exactly as the Claude
  runtime does, and opens the interview with a short kickoff turn instead. Pi's own default system
  prompt is preserved in full (its tools, guidelines, skills block and the context files it reads
  natively), because the instruction is appended to those sections rather than replacing them. A
  bare-skill stage, which carries no system prompt, is unchanged. Batch stages are unchanged: they
  still deliver the prompt as their single user turn, as they always have. (#132)

### Fixed

- **An embedded Pi stage is no longer wrongly failed when its own gate blocked a confinement breach.**
  When a tool action reaches outside the run's worktree, the node decides whether that was a call the
  runtime blocked before it ran (record the deny, keep going) or one that already ran and cannot be
  taken back (hard-fail the stage). That decision was keyed off the runtime's name, treating anything
  that was not `claude-code` as unable to block. Since the Pi pre-execution gate landed, an embedded Pi
  stage whose gate did block the call was still hard-failed as though nothing could stop it. The node
  now keys the decision off whether the session in use actually enforces pre-execution, so an embedded
  Pi stage records a normal blocked deny while a session that genuinely cannot pre-block (container Pi)
  still hard-fails, preserving the security property. (#138)

- **A Pi tool observation now carries the tool's output in the trace.** The Pi event mapper read the
  tool result off a `content` field, but Pi's `tool_execution_end` event names it `result`, so every
  Pi tool observation reached the trace with an empty output. It now reads `result`, so a reader of a
  Pi stage's trace sees the tool output, matching the Claude runtime. The mapper's event shapes are now
  reconciled against the installed SDK's type declarations and pinned by a compile-time check, so a
  future Pi bump that renames a field or adds an event kind the mapper drops fails the build instead of
  quietly degrading the trace. (#136)

- **A Pi stage now stops at the same turn ceiling Claude enforces.** Claude caps a stage at
  `DAHRK_MAX_TURNS` (default 64) agent turns, the backstop against an agent stuck in a tool loop. Pi
  had no equivalent: its only bounds were time-based (the interactive idle window and the stage wall
  clock), and an agent making steady progress through a useless loop tripped neither, because it kept
  emitting output and simply burned budget until the wall clock fired. The Pi adapter now counts Pi's
  per-turn events and aborts the run at the same ceiling, reading the same `DAHRK_MAX_TURNS` env var
  and default so the two runtimes are configured identically. Hitting the ceiling produces the same
  terminal state and failure classification as Claude hitting its limit, not a new one. (#131)

## [0.1.28] - 2026-07-29

### Added

- **A stage now sees the issue's comment thread and the issues around it.** Previously an agent got
  the ticket's title, description and labels, plus at most the single comment that triggered the run,
  and nothing at all about the issue's parent, its blockers, or the issues related to it. The
  discussion that decided how the work should be done was invisible to the agent doing it. The stage
  prompt now carries a `<comments>` block with the thread (the node's own posts excluded, so a stage
  never reads the previous stage's summary back as human input) and a `<related>` manifest naming the
  parent, children, blockers and related issues with their state. The full thread and manifest are
  also written to `.dahrk/scratch/comments.md` and `.dahrk/scratch/related.md`, so an agent can read
  the parts the prompt had to truncate. An issue with no comments and no relations produces exactly
  the prompt it did before. (#125)

### Changed

- **A `codex` stage now fails instead of quietly running on Claude.** The Codex adapter was removed
  when the runtime was retired, but runner selection still fell through to the Claude runner for
  anything that was not `pi`. A stage pinned to `runtime: codex` therefore ran on Claude and reported
  success: the run went green on a runtime nobody chose, and nothing in the trace said so. Unknown and
  retired runtimes now raise a clear error naming the migration (`runtime: pi` with a GPT model).
  `codex` is also dropped from `DAHRK_RUNTIMES` and from a `node.json` written by an older client, so
  a node cannot advertise a runtime it has no adapter for. (#127)

- **A node now advertises the runtimes it can actually serve, instead of the CLIs on its PATH.**
  Detection used to run `claude --version` / `pi --version` and advertise whatever answered. That
  measured the wrong thing in both directions, because the host CLI is not what runs a stage: the
  Claude adapter executes the binary vendored inside its SDK, and the Pi adapter runs in-process.
  A container holding brokered credentials advertised nothing and sat idle, though it could have
  served every Job; a machine with a logged-in `pi` advertised `pi` and then failed each Pi Job it was
  sent, because a Pi stage runs in a hermetic config directory that never reads `~/.pi`.

  Advertising is now the conjunction of two separate questions: can this node **execute** the runtime
  (its SDK ships with the client, so normally yes), and can it **credential** a stage - from the hub
  on a brokered node, or from a host login or a provider key in the environment on an ambient one.
  `dahrk doctor` lists every runtime with the reason for its verdict, so "serving no Jobs" points at
  the missing half instead of sending you looking for software to install. `DAHRK_RUNTIMES` still
  overrides everything. A node that is brokered but has not been told so yet boots on the narrower
  ambient answer and widens within a minute of the hub's `welcome`, rather than advertising runtimes
  it cannot yet credential. (#127)

### Fixed

- **A batch stage doing one long tool call that streams no output is no longer killed as stalled.**
  The batch output-idle watchdog reset only on streamed trace events, so a stage whose sole activity
  was a single long-running tool call that emits nothing until it exits (classically
  `pnpm test 2>&1 | tail`, where `tail` buffers) looked identical to a hung runtime: after the one
  action event there was total silence, and past the stall window (default 300s) the watchdog
  cancelled a healthy stage, landing `status: timeout` with a `stalled (no output for Ns)` summary.
  The watchdog now measures agent silence rather than any silence: while a tool call is open it stays
  disarmed, re-arming when the call returns. A genuinely hung runtime with no call in flight is still
  cancelled on the window, and check and interactive stages are unaffected. (#128)

- **Every `runtime: pi` stage now constructs a session and runs again.** The 0.82.1 Pi runtime bump
  dropped the `AuthStorage` export and the `ModelRegistry.create` static, so each Pi stage died at
  session construction with `Cannot read properties of undefined (reading 'create')`, before any
  inference and at no cost. The adapter now builds the session on the replacement `ModelRuntime` API,
  with no change to model selection, auth-profile semantics, or the hermetic per-stage config dir
  (still never the machine-global `~/.pi`, still torn down on dispose). (#124)

- **An installed `dahrk-node` can now run Pi stages at all.** The published package declared only the
  Claude SDK, while the bundler inlines the Pi adapter's source but resolves its imports from that
  same manifest. So `@earendil-works/pi-coding-agent` and `@modelcontextprotocol/sdk` were never
  installed for anyone who installed the client from npm, and a `runtime: pi` stage died with
  `ERR_MODULE_NOT_FOUND` at session construction. Because the Pi SDK is loaded lazily, nothing
  surfaced at install or on `dahrk doctor` - only a Pi stage, when it finally ran, and only on a real
  install (a source checkout resolved both from the workspace and stayed green). Both are now
  declared dependencies. (#127)

## [0.1.27] - 2026-07-26

### Fixed

- **A stage that names a model the runtime cannot resolve now fails, instead of silently running on a
  different one.** Previously an unrecognised model id was discarded and the stage ran on Pi's own
  default model, reporting success: the run went green, nothing in the trace recorded the substitution,
  and the only way to notice was to spot that the output did not look like the model you asked for. The
  stage now fails with the id it was asked for, the reason it could not be resolved, and the models
  that stage can actually authenticate to. This most often means the node's Pi runtime is older than
  the model list the hub is offering from, so the message says so and points at upgrading the node. (#119)

### Changed

- Upgraded the bundled Pi runtime to `@earendil-works/pi-coding-agent` 0.82.1 (from 0.80.6), which adds
  the Claude Opus 5 model family, OAuth sign-in for OpenRouter and Kimi Code, and two Qwen Token Plan
  providers. Nodes on an older release cannot resolve these newer model ids. (#119)

## [0.1.26] - 2026-07-25

### Added

- **Check stages: deterministic quality gates the node runs in the worktree, where the exit code is
  the verdict.** A workflow stage may now declare `check: [lint, typecheck, test]` and no runtime. The
  node runs each named command in the run's shared worktree and reports a pass or fail per check, so
  "the tests pass" becomes a fact rather than something an agent was asked to judge about its own work.
  Commands are declared per repository, so a workflow names what to check and the repository says how,
  and the same workflow works on a TypeScript repo and a Python one. Every declared check runs even
  after one fails, so a single loop back to the build stage carries every defect rather than one per
  round trip. When a check fails, the node writes a per-attempt note to
  `.dahrk/scratch/checks/<stage>-<attempt>.md` holding each command, its exit code and its captured
  output, and the agent the run loops back to is told which checks failed and where to read the detail.
  A check stage runs no model, so it costs nothing.

## [0.1.25] - 2026-07-23

### Added

- **A repo can now declare a `setup` step that the node runs in the worktree before the agent starts,
  so a stage inherits a buildable tree instead of a bare checkout it has to install itself.** After the
  worktree is created and the `.claude/` overlay applied, and before the runner starts, the node runs
  the declared setup command inside the worktree and folds its output and exit into the run trace. It
  runs once per worktree: a continuation or re-dispatch onto the same worktree reuses the installed tree
  rather than reinstalling. A failing setup fails the stage cleanly with a distinct `setup-failed` error
  rather than handing the agent a half-built tree. Nothing changes for a repo that declares no `setup`.

## [0.1.24] - 2026-07-22

### Changed

- **A stage can now be bound to an auth profile for any provider the Pi runtime supports, not just the
  five that were hand-listed.** The client took `@dahrk/contracts` `^0.4.0`, and a caret range on a
  `0.x` version does not cross the minor, so a node stayed on the contract published in 0.4.0 no matter
  what shipped afterwards. It now takes `^0.6.0`, which carries a provider catalogue generated from the
  Pi runtime itself: 36 providers and 1072 models, including subscription logins for Anthropic Claude
  Pro/Max, GitHub Copilot and xAI alongside the existing ChatGPT/Codex one. Nothing changes for a node
  already running: provider identity still arrives as a hint minted by the hub, and a profile you have
  not created cannot be selected. (#111)

## [0.1.23] - 2026-07-22

### Added

- **A Pi stage can now authenticate against a subscription login, and pick a model the subscription
  can actually serve.** Since 0.1.21 the Pi runtime has taken provider identity solely from the auth
  hint the hub mints, but the stage runner never carried that hint from the Job onto the stage, so a
  brokered key arrived and was ignored: a managed node ended up with no inference auth at all and fell
  through to whatever provider the runtime defaults to, dying on its first turn. The hint is now
  threaded through, including the OAuth-subscription shape (e.g. a ChatGPT/Codex login), whose token
  is refreshed hub-side and attached per stage.
- **A stage whose model cannot be served by the connected provider now falls back to the profile's
  model instead of failing.** Workflows name tier aliases (`sonnet`, `opus`) that resolve to Anthropic
  models on Bedrock; a subscription for a different provider serves none of them, and no
  same-family substitute exists, so the stage previously died asking for a credential that was never
  brokered. The selected auth profile's default model is now the last resort, applied only after an
  exact-provider and same-family match have both failed, so a stage that could run as authored still
  does. An unmatched fallback is ignored rather than substituted, leaving the runtime to raise its own
  error rather than silently running a model nobody chose.

### Fixed

- **A moved or renamed repo now re-points its bare mirror instead of fetching the stale remote for
  ever.** The per-repo mirror consulted the Job's `gitUrl` only at first clone; every later refresh
  fetched whatever `remote.origin.url` the mirror already held, so an org rename, transfer, or host
  change left it silently fetching the old remote - working only while the host courtesy-redirects the
  old name. Each refresh now reconciles the mirror's `origin` URL against the Job's `gitUrl` in place
  (`git remote set-url`, no re-clone) before fetching, and logs the change; a matching URL is left
  untouched. A brokered (token-user) mirror is compared in its stored form, so it is never needlessly
  rewritten.
- **A transient upstream API failure, and a harness-owned watchdog kill, are no longer billed to the
  agent.** When the runtime's stream stalled (a stream idle timeout, an overloaded/529, a 5xx, a 429,
  a gateway timeout, or a connection reset), the node reported a bare `"<stage>: fail"` with no failure
  attribution, so the hub's heuristic sniffed the summary and mis-billed the transient to the agent.
  The batch loop now recognises the upstream transient, attributes the result `failureClass: external`,
  and carries a truthful summary that names it. Likewise, when the node's own wall-clock timeout or
  batch-stall watchdog cancels a stage, the result is now attributed `failureClass: harness` - a
  watchdog kill the node owns is never the agent's fault. A genuine agent-task failure (bad output,
  failing tests) is unaffected and still classes `agent`.

## [0.1.22] - 2026-07-21

### Added

- **A delivered push now reports its diff footprint, so the hub can show the blast radius.** After a
  clean deliver (or a base-advanced merge conflict that still produced a diff), the node computes the
  branch's own contribution over the freshly fetched base and attaches it to the push result: the
  `git diff --numstat` totals (files, added, removed), the changed top-level `scope`, and a capped list
  of changed paths with a truncation marker so a large diff never spills an unbounded payload over the
  wire. Engine scratch never inflates the numbers, and a zero-diff or scratch-only run reports no
  footprint (the surface falls back to a commit count only). (#105)
- **A salvaged tip is now discoverable, and parked tips expire on a schedule.** When a new
  run resets a branch that still held unpushed commits, the node parks the old tip at
  `refs/dahrk/salvage/<branch>/<sha>` so it is never destroyed - but until now nothing told you it had
  happened, and `git branch --contains` never lists it because it lives outside `refs/heads/*`. The
  reap pass now reports how many tips are currently parked (`salvagedRefs` on the `EDGE_REAPED` log
  line), and `docs/logging.md` documents how to find and recover one. Parked tips are also now
  collected 14 days after parking (aged by park time, so a freshly parked tip always survives), so the
  insurance cannot accumulate for ever. Parking behaviour itself is unchanged. (#104)
- **`dahrk repo add` now warns when the hub's stored git URL differs from what this checkout would
  register.** The idempotent re-run already flagged a drifted default branch or display name; it now
  also compares `gitUrl`, so a stale record - a URL left on HTTPS, or pointing at a repo's pre-rename
  name, that an ambient (SSH-only) node cannot clone - is surfaced as a hint instead of passing
  silently. The record is still left unchanged (`repo add` never overwrites); the warning tells the
  operator to correct it in the hub. (#103)

## [0.1.21] - 2026-07-19

### Added

- **A base-advanced merge conflict with no genuine content overlap now integrates and pushes clean
  instead of parking.** At push-time base integration, before aborting on the first conflict the edge
  runs a deterministic (no-LLM) pre-resolve pass: it replays any recorded `rerere` resolution, then
  mechanically resolves an explicitly-safe set of paths - generated lockfiles take the base side
  (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, regenerated downstream) and append-only
  CHANGELOGs are union-merged so both sides' `[Unreleased]` entries survive. Only the residual conflict
  set (genuine, hand-mergeable overlap) then parks as before, so a run no longer burns an agent
  conflict-resolution stage - or a manual park - on a conflict pure git can clear. The safe path set is
  overridable per repo. This stays inside the determinism boundary: git decides the outcome, nothing is
  inferred.
- **Batch output-idle watchdog: a hung batch stage is cancelled instead of running forever.** A batch
  stage (build, plan, test) now cancels its runner if it streams no output - no assistant text, tool
  call, or tool result - for a stall window, defaulting to 300s and overridable per stage
  (`stall_seconds`) or via `DAHRK_BATCH_STALL_MS`. Every streamed event resets the timer, so an
  actively-working stage runs unbounded; only a genuinely stalled one (an orphaned subprocess, a
  runtime that stopped streaming) is stopped, reported as `timeout` with a `stalled (no output for Ns)`
  summary. This is the guard that replaces the removed default 30-minute wall clock: with the stage
  wall clock now opt-in, batch stages had no automatic guard of their own. Interactive stages keep
  their existing per-turn idle timer.
- **A Pi stage can now run against any provider a selected auth profile names, not just Anthropic,
  OpenAI, or Google.** The Pi runtime used to recognise a fixed four-key table, so a brokered
  OpenRouter, Kimi, Mistral, or Groq key was ignored and a subscription login (ChatGPT/Codex, GitHub
  Copilot, Gemini) could not be attached at all. Provider identity now comes from the auth profile the
  run selects: an API-key provider is applied as a runtime override (and, where Pi ships no built-in
  for it, reached through a custom endpoint from the profile), and an OAuth-subscription provider is
  attached from the profile's token material. Each stage resolves its providers into a private,
  per-stage config that is created fresh and removed when the stage settles, so nothing leaks between
  stages and no machine-global Pi config is inherited. The raw key is never exposed to the agent's own
  tool calls.
- **A Pi stage now enforces tool policy before a tool runs, not just after.** Previously only a Claude
  stage had a pre-execution guardrail; a Pi stage's sole check was the post-hoc re-evaluation of the
  trace, which could hard-fail a filesystem-confinement escape only after the command had already run.
  A Pi stage now consults the same edge policy set as Claude (`fs_confine`, `read_only`, `write_scope`,
  `max_tool_calls`, `shell_guard`) before each tool executes and blocks a denied call up front,
  surfacing the policy's reason, so a policy-violating write or command never runs in the first place.
  The post-hoc check stays in place as a defence-in-depth backstop.
- **An interactive Pi stage can now ask the human a structured multiple-choice question, surfaced as a
  Linear elicitation.** Previously only a Claude stage could raise a structured question; a Pi stage
  had no way to, so it fell back to guessing. A Pi stage's `ask_user_question` tool now maps each
  question (with its options and multi-select flag) to a Linear `select` elicitation, waits for the
  human's pick, and feeds the selection straight back into the same stage so it continues with the
  answer. It reuses the same one-question-at-a-time machinery as the Claude path, so a batch of
  questions is asked one at a time and an unanswered question, a cancelled stage, or a second question
  raised while one is still open all behave exactly as they do for Claude.

- **A Pi stage can now use brokered MCP servers, routed through the node's gateway proxy.** Previously
  a stage that declared MCP servers got them only on the Claude runtime; a Pi stage ignored them
  entirely. A Pi stage now reaches each declared brokered server through the same node-local gateway
  proxy the Claude path uses: the node holds the credential and injects it upstream, and the Pi agent
  only ever talks to `127.0.0.1`, so the raw token never reaches the agent. The remote server's tools
  appear to the Pi model as ordinary tools. Only remote (`http`) brokered servers are wired; a stage
  that declares no MCP servers is unchanged.

- **A managed node can now run a Pi stage container-isolated.** Setting `DAHRK_PI_ISOLATION=container`
  makes the node run each Pi stage in a fresh per-job Docker container (`pi --mode rpc`) instead of the
  embedded in-process session; without it the node keeps using the embedded path. The container image
  is taken from `DAHRK_PI_IMAGE` (default `dahrk/pi:latest`). One known degradation on the container
  path: the RPC session has no agent handle, so a meta-loop stage's tool-denial during `summarise` is a
  no-op there (meta-loop stages are telemetry-only, so this is accepted).

### Changed

- **The in-worktree scratch directory is now `.dahrk/scratch` instead of `.skakel/scratch`.** The node
  pre-writes stage inputs and reads the output deliverable from `.dahrk/scratch`, which is excluded from
  git. This release completes the rename in a single step, with no `.skakel/scratch` compat shim: any
  workflow prompt that still references `.skakel/scratch/output` must be updated to point at
  `.dahrk/scratch/output`, or the stage will not find its deliverable.

- **The node now acknowledges cancels, so a cancel survives a hub restart or a dropped connection.**
  A `cancel` used to be handled and forgotten: the node aborted the stage but told the hub nothing, so
  a cancel that arrived while the node was momentarily disconnected, or was in flight across a hub
  restart, could be lost and the runner kept working on a run nobody was waiting for. The node now
  replies with a `cancel-ack` for every cancel it receives (even one for a stage it has already
  finished, which is a harmless no-op) and re-sends that acknowledgement on every reconnect, so the hub
  can treat cancel as a durable, acknowledged item and settle it exactly once.

### Fixed

- **A repeated policy denial no longer posts a duplicate comment for every blocked action.** When a
  governance policy denied the same action over and over - a retried blocked command, or an agent that
  kept calling tools after a cap - each denial streamed its own error, so the run's thread filled with
  identical messages. The node now surfaces at most one human-visible error per distinct deny reason
  per stage; the full trace and the agent-facing denial are unchanged, so nothing observable is lost.
- **A pinned component is no longer written into a worktree the runtime cannot read.** The component
  overlay only special-cased Codex for warn-and-skip, so any other non-Claude runtime (for instance
  Pi) fell through and had Claude-convention `.claude/` files written into its worktree that it never
  reads, with no warning - the component was silently absent. The overlay now materialises files only
  for the Claude runtime, which owns the `.claude/` surface, and emits a warning naming the skipped
  component for every other runtime.

## [0.1.20] - 2026-07-18

### Added

- **`install.sh` installs the client and enrols the node in one copy-paste.** (#78) The curl one-liner the
  docs and dashboard advertise now exists in the repo and is served at `https://dahrk.ai/install.sh`.
  Passed a connect token - `curl -fsSL https://dahrk.ai/install.sh | sh -s -- --token <token>`, or the
  `DAHRK_TOKEN` environment variable - it installs `dahrk-node` from npm, preflights the token with
  `dahrk doctor`, then enrols and starts the node with `dahrk start`, with no manual second step. A
  bad, expired, or already-consumed token stops at the preflight with a clear message and a non-zero
  exit, leaving the client installed so a re-run with a fresh token just works. Run without a token it
  installs the client and prints the next step, keeping the plain install channel working. It requires
  Node 22+ (it does not install a runtime) and supports macOS and Linux; an unsupported OS or a
  missing or too-old Node fails loudly. Re-running on an already-enrolled machine re-attaches as the
  same node rather than creating a duplicate. `--hub-url` / `DAHRK_HUB_URL` override the hub for
  self-hosters.
- **`dahrk start --no-service` enrols without installing the always-on service.** (#78) For a node you
  supervise yourself (a container, pm2, your own unit), it caches the enrolment token and returns
  without registering the launchd / systemd service. `install.sh --no-service` forwards to it.
- **`dahrk repo add` registers the current repository with the hub, from the client side.** (#74) Run it from
  inside a repo - `cd your-repo && dahrk repo add` - and the node reads the `origin` remote and the current
  branch itself, so the git URL and default branch are derived from the working directory and you are never
  asked to paste a URL. The URL is registered in the form the host can authenticate: an HTTPS origin is kept
  as-is, an SSH origin is kept when this host has an SSH key, and otherwise normalised to HTTPS with a
  warning. It authenticates with the node's existing enrolment token and dials the hub itself, so the daemon
  need not be running. Re-running on an already-registered repo is a clear no-op, not an error or a
  duplicate; running outside a git repo, in one with no `origin`, or on a node that is not yet enrolled
  fails with an actionable message.

## [0.1.19] - 2026-07-15

### Fixed

- **Worktree confinement no longer falsely denies heredoc scripts or relative paths issued after a `cd`.**
  (#71) Two normal shapes were being blocked by the filesystem guard shipped in 0.1.11. First, a `cat > file
  <<'EOF'... EOF` heredoc had its body scanned as if it were shell arguments, so a `//` JS comment read
  as an absolute path and a `../..` import specifier read as climbing out of the worktree - both denied
  over inline data that names no path at all. The scanner now recognises `<<` / `<<-` heredocs (quoted or
  bare delimiter) and skips the body entirely. Second, Claude's Bash tool keeps its working directory
  between calls, but the guard reset to the worktree root every call, so any relative path issued after a
  `cd` in an earlier call was judged from the wrong base and read as an escape. The shell's working
  directory is now carried across calls. A genuine whole-disk `find /` is still denied.

## [0.1.18] - 2026-07-14

### Fixed

- **A node whose enrolment token is rejected no longer restarts forever; it parks and heals itself.** (#68) A
  revoked or expired token made the node exit with a distinct code (78) and rely on its supervisor to stop
  it. systemd and pm2 honour that, but launchd's `KeepAlive` takes no exit code, so on macOS the node was
  simply respawned every 10 seconds, dialling the hub around the clock and never serving a Job. The node now
  stops dialling in-process instead: it stays up, parks, logs `EDGE_PARKED` once with what to do about it,
  and re-reads `~/.dahrk/node.json` on a slow poll. Re-enrolling with `dahrk start --token <token>`
  reconnects it in place, with no restart. A node with no token source to heal from (`--ephemeral`, CI)
  still fails fast with exit 78.

- **The enrolment token now lives in exactly one place, so re-enrolling actually takes effect.** (#68) The launchd
  plist and systemd unit used to carry a copy of the token in their environment block, and that copy
  outranked the one on disk. Re-enrolling rewrote `~/.dahrk/node.json` but nothing rewrote the unit, so a
  supervised node went on presenting its old, revoked token on every boot while the working one sat unread
  on disk. The unit no longer carries a token at all; `dahrk start --token <token>` validates it against the
  hub and writes it to `~/.dahrk/node.json` (0600), and the daemon reads it from there. Existing units are
  rewritten without the token on the next `dahrk start`, and a supervised node prefers the disk in the
  meantime, so an upgrade needs no manual repair.

- **`dahrk status` now reports a node the hub has rejected.** (#68) It scanned for `EDGE_CONNECTED` but not
  `EDGE_REJECTED`, and the connected marker is written when the socket opens, which is before the hub has
  looked at the token. A node being rejected on every attempt therefore reported as happily connected.
  `status` now reads the rejection, says the node is serving no Jobs, points at `dahrk start --token`, and
  exits non-zero so it is usable as a health check for this.

- **A hub outage no longer produces a reconnect storm.** (#68) The reconnect was a flat 500ms retry despite
  claiming to be a backoff, so every node in a fleet re-dialled twice a second for as long as the hub was
  away. It is now exponential from 500ms to a 30s ceiling, jittered so nodes do not come back in lockstep,
  and reset only by an accepted enrolment.

## [0.1.17] - 2026-07-14

### Fixed

- **Pi stages now report their real dollar cost, so a `cost_budget` can actually fire on them.** (#66) Only the
  Claude adapter was capturing a cost; a `pi` stage always reported `$0`, which is indistinguishable from
  "free" and left the `cost_budget` policy silently inert - the accumulated spend never reached `maxUsd`, so
  a cap declared in a workflow did nothing and a runaway diagnostic run had no ceiling. The Pi adapter now
  reads the aggregate cost Pi's own session already computes and returns it as the stage's `costUsd`, across
  the batch, interactive, and summarise turns alike. Managed-node runs on the platform pool - the tier billed
  directly - stop reporting blind `$0` and show real spend.

- **A Codex stage no longer masquerades as free.** (#66) The Codex SDK reports tokens but no price, so the adapter
  genuinely cannot compute a dollar cost. Rather than leave `costUsd` silently unset - which the hub cannot
  tell from `$0`/"free" - it now states the gap explicitly as a runtime known-unknown and never fabricates a
  price, so a Codex stage reads as "not priced" rather than "cost nothing".

## [0.1.16] - 2026-07-13

### Added

- **`dahrk status` now tells you whether your client is up to date.** (#62) Previously the only way to find
  out was to run `dahrk update` and read what it said. The `Client` line now always states where you stand,
  and how old that information is: `up to date (checked 3h ago)`. An available update gets a line of its own
  directly under the node verdict, rather than a dim aside halfway down the report that was easy to read past.

  It says "as of" rather than "you are current" on purpose. `dahrk status` makes no network request, so it
  cannot know what the registry published a minute ago; what it can do is tell you what it last learned and
  when. Once that answer is old enough to mislead, it stops being stated as fact and points at the command
  that refreshes it.

- **`dahrk status --json` reports currency as `update: { kind, latest, checkedAt }`** (#62), where `kind` is
  `available`, `current`, or `unknown`, so a monitoring script can alert on a fleet that is falling behind
  (and, just as usefully, on nodes that have never managed to check at all). The exit code is unchanged: an
  available update is not a health failure.

### Changed

- **The node checks for a new client every six hours rather than once a day** (#62), so a running node's view
  of the registry is never more than a few hours old. Still jittered across a fleet, still fails open, still
  one small request per node per interval.

### Fixed

- **A Pi stage on a credential-less node no longer asks the wrong provider for a key.** (#63) Pi resolves a
  model alias against its entire registry, roughly a thousand models across thirty-odd providers, and the
  plain aliases (`sonnet`, `opus`, `haiku`) resolve to Amazon Bedrock: `opus` becomes
  `us.anthropic.claude-opus-4-8`. A node with no login of its own is handed an Anthropic key by the hub, so
  Pi went looking for Bedrock credentials that were never going to be there, and the stage stopped on its
  first turn with `No API key found for amazon-bedrock` - having spent nothing and written no trace, which
  made it look like a broken node rather than a model pointed at the wrong door.

  A resolved model is now landed on a provider the node can actually authenticate to: if the one Pi picked
  is not among the models the registry reports as available, the same model is taken from a provider that
  is. It substitutes nothing - a Claude model is never quietly swapped for someone else's - so if no
  available provider carries that model, Pi's own error stands. Nothing changes on a node using its own
  ambient login.

- **`dahrk update` now records what it learned.** (#62) It fetched the latest published version, printed it,
  and threw it away, so you could be told a new version existed and have `dahrk status` go on knowing nothing
  about it. This also makes `dahrk update --check` the way to refresh a stale answer by hand, which matters
  on a machine whose node is not running: the node's own periodic check was otherwise the only thing that
  ever updated it.

- **`dahrk status` could not tell "you are on the latest" from "I have never checked".** (#62) Both produced
  an identical bare version line, so an absence of news was doing duty for two opposite facts. They are now
  reported as what they are.

## [0.1.15] - 2026-07-13

### Added

- **`dahrk status` now tells you what the node is actually doing.** It leads with a single verdict line
  (running, stopped, crash-looping) instead of burying it at the bottom, reports the runtimes it can serve
  with their versions rather than just their names, and lists the stages it has in flight, read from the
  node's own on-disk job ledger. The hub line now says when the node was last known to be connected
  (`welcomed 2h ago`), taken from its log. It still dials nothing, so it stays instant and works offline,
  and it says "last known" rather than claiming a live connection it cannot verify without dialling. (#60)

- **`dahrk status --json`** prints the same facts as JSON, for a script or a monitoring check. The enrolment
  token is withheld, as it is from the human report. (#60)

- **`dahrk stop` and `dahrk restart` refuse to kill a stage in flight.** A stage is minutes to hours of agent
  time, and it was being interrupted silently by anyone restarting the node to pick up a new client. They now
  list what is running and leave the node up; `--force` interrupts it anyway. (#60)

- **`dahrk update` offers to restart the node.** A running node keeps executing the build it started with, so
  an upgrade does nothing until it is restarted. If a node is up, `update` now asks; where there is nobody to
  ask (a script, CI), it prints the right command instead.

### Fixed

- **`dahrk update` no longer tells you to run `dahrk start` to pick up the new version.** It does not work:
  `start` on a running node is a deliberate no-op, so it returned success and left the node on the old build.
  The command to use is `dahrk restart`, and that is now what it says (and offers to do). (#60)

- **`launchctl` no longer leaks `Unload failed: 5: Input/output error` into `start` and `restart`.** Making
  `start` idempotent means unloading the unit before loading it, and on a node that is not currently loaded
  launchd complains about that. The complaint was expected and ignored, but it was being printed anyway. The
  supervisor's output is now shown only when a step that mattered actually failed, where it is genuinely
  useful. (#60)

- **`dahrk restart` no longer claims the node "will stay stopped across reboots".** That is `stop`'s message,
  and it was untrue: `restart` was implemented as `stop` followed by `start`, so it printed both commands'
  output back to back. It is now one command that reports one outcome. It also no longer leaves the node
  recorded as deliberately stopped when the start half fails, which had been hiding a down node from the very
  health check meant to catch it. (#60)

- **`dahrk status` no longer reports a node started with `--foreground` (or under pm2, or in a container) as
  "not installed".** It asked the launchd/systemd service and nothing else, so a perfectly healthy node that
  it had not started itself was invisible to it. It now also reads the pidfile, which every node takes
  whoever supervises it. (#60)

- **`dahrk doctor` no longer fails with "no hub URL configured" on a default install.** The client falls back
  to `wss://api.dahrk.ai` when `DAHRK_HUB_URL` is unset, but the doctor did not, so it reported a failure
  against the very hub the node was connected to. The same fix applies to `dahrk run preflight`. (#60)

- **`dahrk update` no longer dumps the package manager's output on success.** A successful `npm install -g`
  prints a wall of `ERESOLVE` peer-dependency warnings about the client's own transitive dependencies: it is
  alarming, it is not actionable, and it is not a problem. It is hidden unless the upgrade fails, or you pass
  `--verbose`. (#60)

- **The CLI now speaks with one voice.** Every command shares the same status symbols, the same aligned
  layout, and the same style of next-step hints, where each had previously invented its own. Colour is used
  only to classify (pass, warn, fail) and is switched off automatically when the output is piped or redirected,
  when `NO_COLOR` is set, or on a terminal that cannot render it. (#60)

## [0.1.14] - 2026-07-13

### Added

- **The node now tells the hub what it is running, so a hub redeploy no longer restarts your stage.** When
  the connection moved to a new hub build midway through a stage (a redeploy, or a dropped socket), the
  new hub had no idea the node was already working: it dispatched the stage again, and the node ran it a
  second time from the beginning. A long stage could burn hours of agent time, and its cost, twice over.

  The node now announces its in-flight jobs when it connects, so the hub adopts the work already under way
  instead of duplicating it. An idle node says so explicitly, and a node running nothing it can identify
  stays silent rather than risk the hub cancelling healthy work. (#58)

### Fixed

- **Restarting the node mid-stage no longer silently re-runs the stage from scratch.** The node kept the
  list of what it was running in memory only, so a restart, a crash, or a machine reboot lost it entirely.
  The agent was killed, its result was never sent, and the hub simply dispatched the whole stage again -
  paying for all of it a second time, with no indication anything had gone wrong.

  The node now keeps that list on disk (`~/.dahrk/jobs.json`, alongside `node.json`; honours
  `DAHRK_STATE_DIR`, and is skipped entirely for an ephemeral node). On the next start it reconciles what
  the dead process left behind rather than pretending it never happened. (#58)

- **An interrupted stage no longer leaves half-written files for the next attempt to trip over.** An agent
  killed mid-edit leaves the worktree dirty, and because the worktree is reused for the same run, the
  re-dispatched stage started on top of a partial edit. That is worse than starting clean: it can quietly
  produce corrupt output that still looks like work.

  The node now preserves whatever the killed agent had written - committed to a disposable
  `dahrk/wip/<runId>` ref, pushed when it can reach the remote and kept locally when it cannot, so the work
  is never lost - and resets the worktree to the last commit the agent actually completed. (#58)

## [0.1.13] - 2026-07-12

### Fixed

- **When an agent asks you several questions at once, you now get asked all of them.** The elicit surface
  raises one question at a time, and the tool honoured that by surfacing only the first question of a batch
  and appending a note asking the agent to raise the rest later. The agent had no way to do so: the tool
  call had already returned, so questions two onwards were simply discarded, and the stage carried on with
  answers it never actually received.

  The batch is now drained through the same one-at-a-time surface, awaiting each answer before raising the
  next question, so every question reaches you and none is dropped. A single-question batch behaves exactly
  as before; a multi-question batch returns the answers labelled `Q1..QN` so the agent can tie each reply
  back to the question it answers. (#54)

## [0.1.12] - 2026-07-12

### Added

- **A node with no login of its own can now run Claude and Codex stages.** A managed node, or one you run
  in a container, has no ambient `claude` or `codex` session to borrow: nothing on the box has ever logged
  in. The hub already mints a provider key for those nodes and delivers it on the job, but only the Pi
  runtime was reading it, so a `claude-code` or `codex` stage on such a node simply failed to authenticate.

  Both adapters now pass that brokered key to the runtime as the CLI subprocess environment, layered over
  the inherited one so `PATH` and friends survive. The key rides the child process env only; it is never
  put on the agent's own tool surface.

  This changes nothing for a self-managed node. No brokered key on the job means no `env` override, so the
  runtime keeps using the ambient login on your machine exactly as before. (#51)

### Fixed

- **A runtime that was briefly slow to answer is no longer written off as missing for the life of the
  node.** At boot the node asks each agent CLI (`claude`, `codex`, `pi`) for its version to work out what
  it can run. That question was asked once, with a three second budget, and *any* unhappy answer - an
  error, a non-zero exit, a timeout - was read as "not installed". The answer was then frozen: it was what
  the node advertised to the hub on every reconnect and every heartbeat until someone restarted it.

  So a cold Node-based CLI on a busy host - a machine mid-IO-churn, which is exactly what a node looks
  like in the seconds after `dahrk update` restarts it - could take longer than three seconds to reply
  once, and be dropped. Not just for that probe: for good. Every stage that needed that runtime then
  failed the moment it was dispatched, and nothing anywhere said why. The runtime was installed and
  working the whole time.

  A probe now retries before concluding a runtime is absent (two attempts, and the budget is up from
  three seconds to five). A command that genuinely is not on `PATH` still gives up on the first attempt,
  because no amount of waiting will find it - the retry costs latency only on a host where something is
  actually struggling.

  The node also re-probes after boot, roughly once a minute, and re-advertises when what it finds differs
  from what it is advertising. A node that came up degraded now heals itself instead of waiting for a
  human to notice and restart it. `DAHRK_RUNTIME_RECHECK_MS` tunes the interval. (#50)
- **The boot log now says which runtimes it found.** A degraded advertisement used to be invisible: the
  only symptom was stages failing at dispatch, and you had to already suspect detection to go looking.
  The node now states the detected set at boot, and warns when a runtime it advertised on its previous
  boot is not there any more - a disappearance is worth shouting about, as distinct from a runtime that
  was simply never installed. (#50)

## [0.1.11] - 2026-07-11

### Fixed

- **A stage can no longer read your whole machine.** An agent looking for a package ran a `find` from the
  filesystem root and scanned the entire disk, mounted network volumes included - and nothing stopped it.
  Nothing could: `shell_guard` was a blocklist of seven dangerous commands (a root-anchored `find` is not
  one of them), `write_scope` only ever looked at the worktree's git *branch*, and the read tools - `Read`,
  `Grep`, `Glob` - were governed by nothing at all. The working directory was where a stage started, not a
  wall it could not climb.

  A stage is now confined to the run's worktree, its scratch directory, and the git object store the
  worktree depends on, plus temporary directories and the safe `/dev` sinks. It may **read** the toolchain
  and its config (`/usr`, `/opt`, your git config, the TLS roots, the pnpm store) and may write none of it.
  Your credentials (`~/.ssh`, `~/.aws`, `~/.gnupg`, keychains) and `/Volumes` are denied outright, above
  every allowance. On the Claude runtime the denial happens **before the tool runs**.

  Two honest limits. On Codex and Pi the runtime offers no pre-tool hook, so a breach is only detectable
  after the command ran - there the node now **fails the stage** rather than leaving a note at the end of a
  green run. And this is a tool-argument guard, not a syscall sandbox: a path assembled inside a script and
  never named in the command is not something it can see. `DAHRK_SANDBOX=1` adds the Claude SDK's OS-level
  sandbox, which does close that gap; it stays off by default until its behaviour is proven on real runs.

  Measured against the shell commands from three real run worktrees - 118 commands, each judged against its
  own run's roots - two were denied, and both were the whole-disk scan itself. If a legitimate command is
  wrongly denied anyway, `DAHRK_FS_EXTRA_ROOTS` widens the box and `DAHRK_FS_CONFINE=0` turns it off,
  without waiting for a release. (#47)

## [0.1.10] - 2026-07-11

### Added

- **Your node now tells the hub how it is doing.** On each heartbeat it reports its uptime, which client
  version it is, how many jobs it is holding, how many times it has reconnected, how many worktrees it has
  on disk, how much free disk it has, which runtimes it found, and **counts** of failures by category.

  That is the whole list, and it is worth being precise about what is *not* in it: no file paths, no
  repository or branch names, no command lines, and no error messages. It is numbers, a version string and
  category counts - and that is structural rather than a promise about our carefulness, because the type
  cannot hold anything else. Note the deliberate asymmetry: we send the *count* of git failures and never
  the message, because a count says your node cannot clone, while a message would say **which private
  repository it cannot clone from**.

  Without this we could not tell you your node was broken, only that it had pinged recently. A node
  crash-looping, wedged on a stage, out of disk, or reconnecting every thirty seconds under a process that
  looked fine was indistinguishable from one working perfectly. (#42)
- **Your node's diagnostic logs are NOT sent, unless you say so.** Log lines carry free text: a failed git
  operation quotes the remote it could not reach, the branch it was on, and the paths it was working with.
  So log shipping is **off** for any node running on hardware you operate, and the hub refuses your log
  records even if a client sends them anyway. You can enable it deliberately, and disable it again.

  Nodes running on Dahrk-operated infrastructure do ship their logs, because we operate those machines and
  need them to run the service. (#42)
- **`DAHRK_TELEMETRY` is a ceiling the hub cannot raise.** `off` sends nothing at all about the node;
  `health` permits the health report and refuses log shipping however nicely the hub asks. The hub may only
  ever ask for *less* than you allow, never more.

  This client is open source and you can read `log-shipper.ts` yourself, which is rather the point: a hub
  that could override a local opt-out would be a claim anyone could catch us breaking. (#42)
- An operator can turn a running node's log shipping up for a session while debugging it, **without
  restarting it** - restarting a misbehaving node destroys the state you were trying to look at. It reverts
  to the node's own default when it reconnects, so a debugging act cannot quietly become a standing
  setting. (#42)

### Changed

- **A tool's result is no longer clipped mid-sentence, and no longer lands against the wrong tool.**
  Progress frames carried a tool call and its result as two adjacent items with nothing tying them
  together, so the hub had to pair them by adjacency. That holds only while tools run strictly one at a
  time: the moment a stage runs tools in parallel, or a tool's result comes back deferred, the frames
  interleave and a result gets attributed to whichever call happened to precede it. You would read a
  file's contents underneath a search you never ran.

  Each `action` and `observation` now carries the tool-use id it belongs to, so a result is matched to
  its call by identity rather than by luck of ordering. Result output also gets its own budget of 16,000
  characters instead of sharing the 500-character preview budget used for noisy intermediate steps,
  which was clipping real content a human was meant to read. Output beyond that ceiling is still
  truncated on the wire, deliberately, to keep a whole-repo grep off the control socket - the full
  output survives in the trace archive either way. (#44)

### Fixed

- **`dahrk stop` no longer reports success while a node keeps running.** `stop` drives the service it
  installed (launchd / systemd), and it cannot stop a node somebody else supervises: one started under
  pm2, in a container, or with `dahrk start --foreground` in another terminal. It used to print "Node
  stopped." regardless, so a pm2-supervised node went on holding this host's identity and taking Jobs
  from the hub while the operator had every reason to believe the host was idle. `stop` now checks the
  single-instance pidfile after stopping the service, names the surviving node's pid, says where to go
  and stop it, and exits 3 rather than 0. (#43)
- **A node exiting no longer deletes another node's lock.** `release()` removed the pidfile
  unconditionally, so a node that had reclaimed a stale lock (or lost the acquire race) would, on its way
  out, delete the pidfile of the live node that had since taken it. That left the single-instance guard
  silently disarmed - the exact condition it exists to prevent - and left `dahrk stop` nothing on disk to
  find the surviving node by. Release now removes the pidfile only while it still names the releasing
  process. (#43)

## [0.1.9] - 2026-07-11

### Fixed

- **A node no longer destroys the branch of a run that is still in flight, and no longer wedges every
  re-run of an issue.** Three defects in the worktree/mirror layer interacted (#39):

  - The per-repo cache was a `git clone --mirror`, whose refspec force-syncs local refs to match the
    remote on every fetch. A run's branch exists only locally until `deliver` pushes it (and the forge
    deletes the branch again on merge), so **every mirror refresh deleted the branch of any run then in
    flight**, orphaning its commits and leaving the worktree on an unborn HEAD. The mirror now keeps the
    remote's refs under `refs/remotes/origin/*` and the node's own run branches under `refs/heads/*`,
    which a fetch never touches. Existing mirrors migrate themselves in place on the next refresh; there
    is nothing to do and nothing to re-clone.
  - Run worktrees were **never removed**. Teardown only ran if you had configured a retention policy, and
    even then it only knew about runs the current process had started, so anything from a previous
    process was orphaned for good. One node reached 92 worktrees and 65 GB. There is now a reaper that
    reconciles what is actually on disk, runs at startup and after each stage, and has sane defaults -
    "no policy configured" no longer means "never collect anything". It never touches a run that is busy.
  - A worktree left behind by an earlier run went on **claiming its branch name for ever**, so the next
    run of the same issue failed outright with `fatal: '<branch>' is already used by worktree at...`.
    Stale claims are now cleared before a worktree is created, and a run is always based on the current
    remote base rather than on whatever a previous run happened to leave behind. If work would be
    discarded, its tip is first parked under `refs/dahrk/salvage/` rather than dropped.

  Tune the reaper with `DAHRK_RETENTION_MAX_RUNS` / `DAHRK_RETENTION_MAX_AGE_MS`, or preview a sweep with
  `DAHRK_REAPER_DRY_RUN=1`.

### Changed

- **`dahrk start` now means "make this node run, and keep it running".** It installs the always-on
  service, starts it, and hands your terminal back, instead of blocking forever. Nodes are meant to be
  always-on, so that is what the plain verb should do. The blocking worker is still there and is still a
  first-class way to run a node - it is now `dahrk start --foreground` (or `DAHRK_FOREGROUND=1`), which is
  what you want in a container, under pm2, in CI, or to watch a node work. `--ephemeral` implies it.

  **If you run a node under pm2 or in a container, add `--foreground`** (the bundled `ecosystem.config.cjs`
  already does). Everything else upgrades on its own: an installed service repairs its own unit the first
  time it restarts. (#38)

### Added

- **The node keeps a proper log now, and it is written at `debug` whether or not you asked for it.** It had
  no logger at all before: bare lines on stdout, with no levels, no timestamps, and nothing kept. An
  incident on a node left nothing behind to read.

  There are now two logs. The transcript (`node.out.log` / `node.err.log`) is unchanged - the same lines,
  as printed. Alongside it, `~/.dahrk/logs/node.jsonl` holds the structured record: level, timestamp,
  correlation ids, and full error stacks, rotated at 10 MB across five generations.

  The important part is that **the file is written at `debug` even when your terminal is not.**
  `DAHRK_LOG_LEVEL` (default `info`) governs only what reaches stdout. Debug logging you have to switch on
  *before* the incident is no use, because you find out you wanted it *afterwards* - so the node always
  writes the detail, and the evidence for a failure is already on disk by the time you go looking. At
  `debug` you also see every git operation: clone, mirror refresh, worktree create, fetch. (#40)
- **`dahrk logs --run <runId>`**, plus `--level` and `--json`. Every line the node writes during a stage
  carries the same identifiers the hub knows that run by, so a node's account of a run and the hub's are
  finally the same story told from two ends. A bare `dahrk logs` still tails the transcript exactly as
  before. (#40)
- **`dahrk diagnose`** - a support bundle you can actually read. It collects this node's identity, version
  and host, the `doctor` verdict, the tail of the structured log, and every crash record, and writes them
  to **one local JSON file**. It uploads nothing, and there is no flag to make it. The enrolment token is
  removed rather than redacted, and no source, prompts or issue content go in.

  This is deliberate. Debugging a node running on someone else's machine means asking them for it, and the
  point of the bundle is that saying yes is safe: they can open it, read every byte, and decide. (#40)
- A crash now leaves something behind. Uncaught exceptions and unhandled rejections are logged with a full
  stack and written to `~/.dahrk/logs/crashes/<timestamp>.json`, and the node carries on rather than dying
  (set `DAHRK_CRASH_EXIT=1` if you would rather your supervisor restart it). The crash record is a separate
  file from the log on purpose: the log rotates, and a crash-loop will happily push its own first cause out
  of it. (#40)
- `dahrk stop`, `dahrk restart`, and `dahrk logs [-f] [-n <lines>]`. `stop` was previously
  `unknown command: stop` - the only way to stop a node was `dahrk service uninstall`, which also removed
  it. A stopped node stays stopped across reboots until the next `start`, and `dahrk status` now tells a
  node you stopped **on purpose** from one that is **crash-looping**, exiting non-zero only for the latter
  so it remains usable as a health check. (#38)
- The node tells you when its client is out of date, rather than waiting to be asked - an always-on node
  is started once and then runs for months, so it never otherwise finds out. `dahrk start` offers to
  update (only at a terminal - a scripted start never blocks on a prompt), the running node logs
  `UPDATE_AVAILABLE:<version>` once a day, and `dahrk status` reports it. Nothing ever updates itself; run
  `dahrk update` when you want it. The check reads the registry at most once a day and fails silently when
  it cannot (it can never delay or fail a start). Switch it off with `DAHRK_NO_UPDATE_CHECK=1`,
  `NO_UPDATE_NOTIFIER`, or `CI`. (#38)

### Fixed

- **Git was completely silent.** The worktree layer has always had a logging seam, with something useful to
  say on every clone, mirror refresh and worktree create - but nothing was ever plugged into it, so it
  discarded every line. On a real node, no git operation has ever been logged. They are now, at `debug`,
  which is exactly what you want when a stage fails before the agent even starts. (#40)
- Credentials could reach a log line. Now that the node logs git output and agent errors, the log itself
  becomes somewhere a token could land - a git failure will happily echo the remote URL it failed on,
  credentials and all. Everything written to a log is scrubbed first: values under sensitive keys,
  credentials embedded in URLs (`https://user:secret@host`), and token-shaped strings anywhere in free text.
  It errs on the side of dropping: a redacted value costs you a re-run, a leaked token rather more. (#40)
- Failures on the node's best-effort paths vanished without trace. The worst of them: if shipping a stage's
  final trace to the hub failed, the hub simply ended up with **no trace for that stage** - the whole record
  of what the agent did - and nobody ever found out why. These paths are still best-effort and still never
  fatal; they are just no longer silent. (#40)
- A node piped into a command that exits first (`dahrk start | head`) would write spurious crash records.
  Closing the pipe made the next write raise `EPIPE`, which surfaced as an uncaught exception, which the
  crash handler then tried to log through the very output that had just gone away. A logger must never be
  the cause of a crash. (#40)
- The containerised Pi runtime could hang. Its error output was piped and then never read, so a container
  with much to say would fill the pipe buffer and block on its next write - with the explanation for the
  stall sitting unread in the pipe. (#40)
- Two nodes could run at once on the same machine - `dahrk service install` followed by `dahrk start` in a
  terminal was enough. Because a node's id is persisted and re-presented on every dial, that is not two
  nodes: it is one node dialling the hub twice and racing itself for the Jobs it is given. A node now takes
  a lock (`~/.dahrk/node.pid`) and a second one refuses to start. A node killed outright releases it, so a
  crash cannot lock the host out. (#38)
- Linux nodes logged only to the journal, so there was no single answer to "where are the logs". The
  systemd unit now writes the same `~/.dahrk/logs/node.{out,err}.log` that launchd always has, and
  `dahrk logs` reads them on every platform. They are rotated past 10 MB, keeping one generation. (#38)
- `dahrk status` pointed at a log path that ignored `DAHRK_STATE_DIR`, so a node with a custom state
  directory was told to tail a file that would never exist. There is now one definition of the log
  directory. (#38)

## [0.1.8] - 2026-07-11

### Added

- `dahrk status`: is this node enrolled (and as whom), what runtimes can it serve, and is the
  always-on service actually running? It answers locally and dials nothing, so it is instant and works
  offline - `doctor` remains the one that checks the hub is reachable and the token still valid. It
  calls out the state that was previously invisible: a service that is installed but *not running*
  (crash-looping or failing to load), and exits non-zero for it so it can be used as a health check.
  (#36)

### Fixed

- The service unit was world-readable (`0644`) and holds your enrolment token in its environment
  block. `dahrk service install` now writes it `0600`, and re-installing tightens the mode on a unit an
  older client left readable. If you installed the service before this release, re-run
  `dahrk service install` to fix the file already on disk. (#36)
- The installed service pointed at a *versioned* Node path (e.g.
  `/opt/homebrew/Cellar/node/26.5.0/bin/node`, which is what `process.execPath` reports for a Homebrew
  Node). The next `brew upgrade node` deletes that directory, so the node would silently stop serving
  Jobs and crash-loop every 10 seconds forever. The unit now prefers a stable path that resolves to the
  same binary (`/opt/homebrew/opt/node/bin/node`), verified rather than assumed. Re-run
  `dahrk service install` to repin an already-installed service. (#36)
- Enrolment did not survive a restart. `dahrk start --token <token>` enrolled and ran, but the token
  was never saved, so the moment you stopped the node a plain `dahrk start` died with
  `EDGE_REJECTED:4400 an enrolment token is required` - every reboot, service restart, and update
  meant pasting the token again (or exporting `DAHRK_ENROL_TOKEN` by hand). A token the hub accepts
  is now cached alongside the node id in `~/.dahrk/node.json` (owner-only, `0600`), so enrolment is a
  one-time act and later runs re-attach as the same node with no token. `doctor`, `run`, and
  `service install` use the cached token too. Pass `--token` again to re-enrol with a rotated token,
  and `--ephemeral` still keeps everything off disk. Only a token the hub has actually welcomed is
  cached, so a typo is never written. (#36)

## [0.1.7] - 2026-07-11

### Fixed

- Interactive stages that did not set `exit` could never finish. The default was `gate`, which
  disables the stage-complete tool, so the stage could only end successfully if your reply happened
  to contain the word "allow" or "approve" - a keyword nothing in the prompt or in Linear mentions.
  In practice the interview ran on until the idle window expired: the run timed out and the agent's
  work was discarded. The default is now `either`, which keeps the allow-word path and adds the tool
  exit, so a stage that omits `exit` can complete. (#31)

## [0.1.6] - 2026-07-11

### Fixed

- Fix a startup crash introduced in 0.1.5: `dahrk start` aborted immediately with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` because a bundled dependency shipped uncompiled
  TypeScript that current Node refuses to load from `node_modules`. The client now resolves the
  compiled build, so `dahrk start` runs again. Upgrade with `dahrk update` (or
  `npm install -g dahrk-node@latest`). (#27)

## [0.1.5] - 2026-07-11

### Added

- `dahrk service install` / `uninstall`: run the node as an always-on service without a process
  manager. It generates and registers a launchd LaunchAgent on macOS or a systemd *user* service on
  Linux that runs `dahrk start` on boot, restarts on failure, and streams logs - no pm2, no root. The
  persisted node id (`~/.dahrk/node.json`) means the service re-attaches as the same node across
  reboots; on Linux it also enables linger so a headless VPS starts at boot and survives logout. The
  token and any `--name` / `--hub-url` are baked into the service's environment (not its argv, so they
  never surface in `ps`), along with the operator's PATH so the daemon finds `git` and the runtime CLIs
  (claude / codex / pi) that a supervisor's minimal PATH would otherwise hide. A bad or missing token
  exits 78 (`EX_CONFIG`): systemd stops the service and launchd throttles retries to one every 10s, so
  the misconfiguration stays visible rather than hammering the hub. (#22)

- An enforceable `read_only` policy for a stage: it denies every write and shell tool outright while
  still allowing reads (`Read` / `Grep` / `Glob`). Previously `shell_guard: deny` only blocked a small
  dangerous-command blocklist, so effectful shells like `git push`, `curl -X POST`, and `>` / `>>`
  redirection writes slipped through - there was no way to express a genuinely read-only stage. (#24)

- Interactive stages now surface an agent's structured multiple-choice question as a proper Linear
  choice prompt with selectable options, instead of the question silently resolving to "the user did
  not answer" and the agent falling back to a plain-text paragraph nobody could reply to. Your pick is
  fed straight back to the agent and the stage continues. Only one question is shown at a time; if the
  agent asks several at once, the first is shown and the rest are noted. (#25)

### Changed

- The node now advertises its resolved worktree base to the hub when it connects, so a run's real
  worktree location (`~/.dahrk/worktrees/<runId>`, or your `DAHRK_WORKTREES_DIR`) is recorded in the
  hub's projection instead of an advisory placeholder. Observability only; never control flow. (#23)

## [0.1.4] - 2026-07-10

### Added

- `dahrk update`: a local, user-initiated self-update to the latest published client. It reads this
  build's version, asks the npm registry for the newest release (the single source of "latest" across
  every channel), and - when behind - detects how the client was installed (npm / Homebrew / curl) and
  runs the right upgrade in place, or prints the exact command when it cannot safely automate it. It
  reports `current -> latest`, is a no-op when already current, and `--check` reports availability
  without applying. No hub involvement; the same local path a future remote upgrade reuses. (#18)

- `dahrk run <workflow>`: run a workflow through the engine locally against this node's worktree, the
  engine-backed twin of `doctor` and the first slice of a general `dahrk run`. The first workflow is
  `preflight`, which sequences `check node` / `check repo` / `check tools` stages, synthesises a
  plain-English read, and links the full report at `app.dahrk.ai/r/<runId>`, streaming `[n/5] <stage>`
  progress as it goes. It runs with no Linear, no OAuth, and no issue, and exits non-zero only on an
  unsound floor (old Node, not a git repo, git missing, worktree unwritable); a tool or hub it cannot
  reach is a finding, not a failure. (#17)

### Fixed

- Harden `deliver`: when a run branch adds nothing over the (possibly advanced) base - an empty delta,
  or one consisting solely of the engine-owned scratch dir or other git-ignored paths - the push now
  short-circuits to an explicit `noop` outcome. Nothing is pushed and no PR is opened; the run closes
  as a successful "already delivered" no-op rather than risking a base-advanced merge conflict on a
  stray scratch path. A genuine code delta still integrates and pushes as before. (#16)

- Enforce edge policy decisions before Claude tool execution, and reject declared or handed-back
  artifact paths that escape the run worktree. (#19)

- A stage that had already finished no longer re-runs when the hub re-sends its frame. The node
  de-duped only against the set of in-flight jobs, which clears on completion, so a re-dispatched job
  started a second runner and redid the agent's work at full token cost; it now replays the cached
  result instead. A job that is neither running nor cached still re-runs, which is the genuine
  recovery path. (#20)

- Detect a dead hub connection instead of streaming into it. A half-open TCP connection leaves the
  WebSocket reporting itself as open, so a node could send trace events to a hub that no longer knew
  about it, never reconnect, and never receive its job again. The heartbeat now pings and terminates
  the socket after three missed replies, letting the node reconnect. (#20)

## [0.1.3] - 2026-07-07

### Changed

- Release tooling: harden generated release notes so internal identifiers never reach the public
 changelog. Linear-style keys, internal run IDs, and commit trailers are stripped from every notes
 source (hand-written, AI-drafted, or the commit-log fallback), drafts prefer GitHub `(#N)`
 references, and version headings are dated. (#10)
- Release tooling: add a manual "Preview release notes" CI workflow that drafts the notes for a
 prospective version without tagging or publishing, so they can be reviewed before a release. (#11)

## [0.1.2]

### Added

- Work-preservation backup push (#7): a new merge-free `mode: "backup"` force-pushes the run's
  HEAD to `dahrk/wip/<runId>` with no base merge or PR, so in-flight work survives without touching the
  integration branch.

### Fixed

- Stop masking push-integration merge failures. A push whose base merge failed before a merge even
  started (e.g. unrelated histories, no `MERGE_HEAD`) previously surfaced an opaque
  `git merge --abort` error that destroyed the real diagnostic. Such cases now report a distinct
  `diverged` outcome and re-throw genuine merge-start failures truthfully, with a merge-base
  short-circuit and a fail-fast guard against an unborn HEAD. (#6)

## [0.1.1]

### Fixed

- Point the default hub URL at the canonical hosted endpoint `wss://api.dahrk.ai`. The 0.1.0 default
  (`wss://hub.dahrk.net`) did not resolve, so a token-only `dahrk start` failed with
  `getaddrinfo ENOTFOUND hub.dahrk.net`. Override via `--hub-url` / `DAHRK_HUB_URL` is unchanged.
- Default the git commit author/committer identity email to `noreply@dahrk.ai` (was `noreply@dahrk.net`).

## [0.1.0]

First published release of the `dahrk-node` edge client.

### Added

- Installable edge client. Run `dahrk start --token <enrolment-token>` and the process becomes a
  self-managed node: it dials OUT to the hub over WebSocket (no inbound ports), auto-detects the
  agent runtimes installed on the host (Claude Code, Codex, Pi), mints and persists a stable node id
  under `~/.dahrk/node.json`, and runs each workflow stage in an isolated git worktree.
- Subcommand CLI: `dahrk start` (default), `dahrk doctor`, `dahrk help`, `dahrk version`.
  `dahrk doctor` preflights the Node version, installed runtimes, hub reachability, and token
  validity before you commit to `start`. `--ephemeral` mints a throwaway node id for CI / one-shot
  nodes.
- Token-only install: the hub URL defaults to the hosted hub, so only an enrolment token is
  required; `--token` / `--name` / `--hub-url` flags override the matching `DAHRK_*` env vars (the
  legacy `SKAKEL_*` names are accepted as aliases during the rename).
- Three install channels, all providing the `dahrk` command: npm (`npm install -g dahrk-node`),
  Homebrew (`brew install dahrkai/tap/dahrk`), and curl (`curl -fsSL https://dahrk.ai/install.sh | sh`).
- pm2 config (`ecosystem.config.cjs`) for running a durable node from source.
- Tag-driven release CI: a `vX.Y.Z` tag publishes `dahrk-node` to npm, bumps the Homebrew tap
  formula, and cuts a GitHub release.

[Unreleased]: https://github.com/dahrkai/dahrk-node/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/dahrkai/dahrk-node/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/dahrkai/dahrk-node/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/dahrkai/dahrk-node/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/dahrkai/dahrk-node/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dahrkai/dahrk-node/compare/v0.1.31...v0.2.0
[0.1.31]: https://github.com/dahrkai/dahrk-node/compare/v0.1.30...v0.1.31
[0.1.30]: https://github.com/dahrkai/dahrk-node/compare/v0.1.29...v0.1.30
[0.1.29]: https://github.com/dahrkai/dahrk-node/compare/v0.1.28...v0.1.29
[0.1.28]: https://github.com/dahrkai/dahrk-node/compare/v0.1.27...v0.1.28
[0.1.27]: https://github.com/dahrkai/dahrk-node/compare/v0.1.26...v0.1.27
[0.1.26]: https://github.com/dahrkai/dahrk-node/compare/v0.1.25...v0.1.26
[0.1.25]: https://github.com/dahrkai/dahrk-node/compare/v0.1.24...v0.1.25
[0.1.24]: https://github.com/dahrkai/dahrk-node/compare/v0.1.23...v0.1.24
[0.1.23]: https://github.com/dahrkai/dahrk-node/compare/v0.1.22...v0.1.23
[0.1.22]: https://github.com/dahrkai/dahrk-node/compare/v0.1.21...v0.1.22
[0.1.21]: https://github.com/dahrkai/dahrk-node/compare/v0.1.20...v0.1.21
[0.1.20]: https://github.com/dahrkai/dahrk-node/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/dahrkai/dahrk-node/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/dahrkai/dahrk-node/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/dahrkai/dahrk-node/compare/v0.1.16...v0.1.17
[0.1.16]: https://github.com/dahrkai/dahrk-node/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/dahrkai/dahrk-node/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/dahrkai/dahrk-node/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/dahrkai/dahrk-node/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/dahrkai/dahrk-node/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/dahrkai/dahrk-node/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/dahrkai/dahrk-node/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/dahrkai/dahrk-node/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/dahrkai/dahrk-node/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/dahrkai/dahrk-node/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/dahrkai/dahrk-node/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/dahrkai/dahrk-node/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/dahrkai/dahrk-node/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/dahrkai/dahrk-node/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/dahrkai/dahrk-node/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/dahrkai/dahrk-node/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dahrkai/dahrk-node/releases/tag/v0.1.0
