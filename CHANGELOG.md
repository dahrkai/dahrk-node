# Changelog

All notable changes to the `dahrk-node` edge client are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A node's heartbeat now counts only stages that are executing as busy, so queued and push work no longer inflate its reported load.

## [0.4.7] - 2026-08-14

### Fixed

- A node now tells the hub its stage-concurrency bound, so a multi-core node runs several stages at once instead of being clamped to one. (#219)

## [0.4.6] - 2026-08-13

### Changed

- Setup trace events now report how long the repository setup command took, or how long the cached path saved.

## [0.4.5] - 2026-08-12

### Added

- A node now runs a bounded number of stages at once, derived from its CPU count, queuing the rest instead of oversubscribing. (#210)
- The stage-concurrency bound is tunable with the `DAHRK_MAX_CONCURRENT_STAGES` environment variable. (#210)
- A node's health report now shows its stage capacity and how many slots are in use. (#210)
- A run can check out several repositories side by side, so one stage can change both. (#201)
- A run's worktree can be browsed from the portal while the run is in flight or waiting at a gate. (#211)

### Changed

- A run's worktrees now sit in a directory of their own, one level deeper than before. (#201)
- A command that changes directory into a read-only location, such as `/etc` or `/usr`, is now refused. (#201)

### Fixed

- A batch stage is no longer cancelled while its runtime is still working through a long turn. (#206)
- A process a check or setup command backgrounds during a stage is now killed when the stage settles, instead of outliving the node. (#205)
- Two nodes on one host with distinct `DAHRK_STATE_DIR` values now get their own service and worktree roots, so neither clobbers the other. (#204)
- A node with no Docker installed now reports as healthy, instead of showing a finding for a tool it never uses. (#203)
- The node health report's all-clear no longer claims a repository was checked, since it examines none. (#203)
- A stage can no longer read files outside its worktree by changing directory first. (#201)
- A node that dies mid-run preserves the uncommitted work in every repository of that run. (#201)
- Each repository of a run runs its own setup command. (#201)
- The installer's instructions now suit a box with no `sudo`, using `su` or dropping the privileged route entirely. (#199)
- The apt and dnf recipes are a single command, so a partial paste can no longer install an older distro Node. (#199)
- The installer no longer rejects an npm prefix that is configured but not yet created. (#199)
- Node without npm, the shape Debian's own package leaves you in, is explained instead of being called a broken install. (#199)
- The nvm route says to run it as the user that will run the node, not as root. (#199)

## [0.4.4] - 2026-08-09

### Changed

- The installer now detects your operating system and prints the exact Node 22 install commands for it. (#196)

### Fixed

- The installer explains an unwritable global npm prefix and how to fix it, instead of failing with EACCES. (#196)
- A re-run that continues preserved work now starts from that work, and fails loudly rather than silently branching off the base. (#195)

## [0.4.3] - 2026-08-09

### Added

- The hub can ask a running node for a live health check, answered from the node's own process in milliseconds. (#191)
- Each stage now reports how much it changed, so an approval request can state the file count and line churn up front. (#193)

### Changed

- A stage's closing summary is now one plain sentence, with command names and file counts left to the change summary beside it. (#193)

## [0.4.2] - 2026-08-08

### Fixed

- Worktree confinement denies an anchored path containing a space, so a quoted or escaped path can no longer escape the worktree. (#188)

## [0.4.1] - 2026-08-08

### Added

- A node tears down a finished run's worktree as soon as the hub reports the run finished, freeing disk sooner. (#186)

### Fixed

- A run waiting at a human gate keeps its worktree, so the approved push no longer fails with a missing worktree. (#185)

## [0.4.0] - 2026-08-06

### Added

- Commits are SSH-signed when the hub supplies a signing key, so they show as verified on GitHub. (#181)

### Changed

- A node now enrols to your account rather than to a node group, and serves every repository in it. (#182)
- The hub requires node 0.4.0 or newer; older clients are refused with an upgrade message. (#182)

### Removed

- The legacy `SKAKEL_*` environment variable aliases and the `~/.skakel` state directory fallback. (#181)
- A node still holding its identity in `~/.skakel` mints a new one and must be enrolled again. (#181)

### Fixed

- A commit is never signed with the host's own key, even where git is configured to sign by default. (#181)
- A repository's configured commit author and committer are applied instead of being ignored. (#181)
- `dahrk doctor` and `dahrk preflight` resolve the state directory the same way the node does. (#181)
- An installed node reports its real version instead of `0.0.0`. (#182)

## [0.3.7] - 2026-08-05

### Fixed

- A Claude stage uses the model set on the workspace's connected provider when the stage names none. (#179)

## [0.3.6] - 2026-08-05

### Fixed

- The health check reports on the agent runtimes the workspace's connected providers actually need. (#176)

## [0.3.5] - 2026-08-05

### Fixed

- The `repo-fetch` health check now passes on nodes using brokered credentials. (#174)

## [0.3.4] - 2026-08-04

### Fixed

- `dahrk status` reports a disabled service as disabled, and points at `dahrk start`. (#172)
- `dahrk doctor` reports on the service that is meant to be running the node. (#172)
- A restart from inside the supervised node explains how to restart from a terminal instead of taking
  the node down. (#172)

## [0.3.3] - 2026-08-04

### Fixed

- An update triggered from the portal restarts the node through the service manager and comes back on
  the new build. (#170)
- A stage that fails before it begins is reported as a configuration failure rather than a provider
  outage. (#170)

## [0.3.2] - 2026-08-04

Maintenance release: no behavioural change, adding test coverage for the shell confinement scanner and
regression tests for two earlier fixes. (#168)

## [0.3.1] - 2026-08-04

### Fixed

- Check stages run, including those declaring no runtime or model configuration. (#166)
- An interactive stage reports a refused credential as a failure the agent is not answerable for, and
  stops advertising that runtime. (#166)
- `dahrk status` describes only the running process, never a previous run's failure. (#165)
- `dahrk start` waits up to ten seconds for the node to reach the hub before reporting on it. (#165)
- `dahrk status` reads only the most recent portion of the log. (#165)

## [0.3.0] - 2026-08-03

### Added

- The node applies an upgrade the hub asks for, running the package manager and restarting onto the
  new build unattended. (#161)

### Fixed

- Connecting a node from the web app works: every hub probe runs as this node. (#163)
- `dahrk start --token <new>` restarts the node so a re-enrolment takes effect, and is refused while a
  stage is in flight. (#163)
- A parked node that finds a working token caches the token the hub accepted. (#163)
- A running node checks for a new release on the interval it reports. (#161)
- `dahrk status` reserves `✔ up to date` for an answer from the current check interval, and reports an
  older one with its age. (#161)
- A failed update check is recorded, and the daemon logs the outcome of every check. (#161)

## [0.2.0] - 2026-08-01

### Changed

- Every credential comes from the hub: git, pull requests and inference all authenticate on brokered
  credentials rather than your machine's logins. (#157)
- A node advertises a runtime whenever its SDK is installed, regardless of any login on the host. (#157)
- `dahrk repo add` always registers the HTTPS clone URL, normalising an SSH remote. (#157)

### Removed

- `DAHRK_CREDENTIAL_MODE` and its `SKAKEL_CREDENTIAL_MODE` alias. (#157)
- The SSH key, `claude` login and `gh` CLI checks in `dahrk doctor` and `dahrk preflight`. (#157)

### Fixed

- A newline splits a shell command for worktree confinement exactly as a semicolon does, so each line
  is checked on its own. (#154)
- A `#` comment is skipped when worktree confinement lexes a command, while a mid-word or quoted `#`
  stays an ordinary character. (#155)

## [0.1.31] - 2026-07-31

### Fixed

- A node resolves the host Claude credential itself, picking the freshest unexpired one, so stages
  succeed however the node was started. (#152)

## [0.1.30] - 2026-07-30

### Added

- A Claude stage can use an Anthropic subscription (Claude Pro/Max) through a brokered auth profile,
  not just an API key. (#148)
- A node stops advertising a runtime once the provider has refused its login, and restores it when a
  stage authenticates again. (#148)

### Changed

- The Pi runtime moves to 0.83.0, adding Claude Opus 5 and replacing the Fireworks GLM 5.1 model ids
  with Kimi K3. (#150)

### Fixed

- A credential the provider refused, or an account at its spend cap, is attributed to configuration
  with the provider's own words. (#148)

## [0.1.29] - 2026-07-30

### Added

- A Pi stage receives pinned skills and commands; a pinned subagent warns and is skipped, since Pi
  ships none. (#142)
- A Pi stage writes a durable session under the run's scratch tree, resumable within the stage and
  reaped with the worktree. (#140)
- A container-isolated Pi stage enforces the pre-execution tool gate and can ask a structured
  question. (#137)
- A Pi stage can hand back a document from its `dahrk_stage_complete` tool, emitted as the stage's
  artifact. (#130)
- A container-isolated Pi stage reports its real dollar cost and runs on the model the stage asks
  for. (#139)

### Changed

- A container-isolated Pi stage refuses outright when it lacks a security-critical capability, and
  emits `capability-degraded` for a non-critical gap. (#143)
- A Pi interactive stage receives its instruction as a system prompt, matching the Claude runtime;
  batch stages are unchanged. (#132)

### Fixed

- An embedded Pi stage records a normal blocked deny when its own gate stops a confinement breach,
  instead of hard-failing. (#138)
- A Pi tool observation carries the tool's output in the trace. (#136)
- A Pi stage stops at the same `DAHRK_MAX_TURNS` ceiling Claude enforces, with the same terminal
  state and failure classification. (#131)

## [0.1.28] - 2026-07-29

### Added

- A stage prompt carries the issue's comment thread and a manifest of parent, child, blocking and
  related issues. (#125)

### Changed

- A stage pinned to `runtime: codex` fails with an error naming the migration to `runtime: pi`. (#127)
- A node advertises the runtimes it can both execute and credential, with `dahrk doctor` giving the
  reason for each verdict. (#127)

### Fixed

- A batch stage doing one long tool call that streams no output is no longer killed as stalled. (#128)
- Every `runtime: pi` stage constructs a session on Pi's `ModelRuntime` API and runs again. (#124)
- An installed `dahrk-node` can run Pi stages, with the Pi SDK and MCP SDK now declared
  dependencies. (#127)

## [0.1.27] - 2026-07-26

### Fixed

- A stage naming a model the runtime cannot resolve now fails with the id, the reason, and the
  models it can authenticate to. (#119)

### Changed

- The bundled Pi runtime is now `@earendil-works/pi-coding-agent` 0.82.1, adding the Claude Opus 5
  family, OpenRouter and Kimi Code OAuth, and Qwen Token Plan providers. (#119)

## [0.1.26] - 2026-07-25

### Added

- A workflow stage can declare `check: [lint, typecheck, test]` and no runtime, running each command
  in the worktree with the exit code as verdict.

## [0.1.25] - 2026-07-23

### Added

- A repo can declare a `setup` step that the node runs once per worktree before the agent starts.

## [0.1.24] - 2026-07-22

### Changed

- A stage can be bound to an auth profile for any of the 36 providers and 1072 models the Pi runtime
  supports. (#111)

## [0.1.23] - 2026-07-22

### Added

- A Pi stage authenticates against a subscription login, including OAuth shapes such as a
  ChatGPT/Codex account, with the token refreshed hub-side per stage.
- A stage whose model the connected provider cannot serve falls back to the auth profile's default
  model rather than failing.

### Fixed

- A moved or renamed repo re-points its bare mirror to the Job's `gitUrl` on each refresh.
- Transient upstream API failures are attributed as external, and watchdog kills as harness, so
  neither is billed to the agent.

## [0.1.22] - 2026-07-21

### Added

- A delivered push reports its diff footprint: `git diff --numstat` totals, the changed top-level
  scope, and a capped list of changed paths. (#105)
- The reap pass reports how many salvaged tips are parked (`salvagedRefs`), and parked tips are
  collected 14 days after parking. (#104)
- `dahrk repo add` warns when the hub's stored git URL differs from what this checkout would
  register. (#103)

## [0.1.21] - 2026-07-19

### Added

- A base-advanced merge conflict with no genuine content overlap now integrates and pushes clean,
  with lockfiles taking the base side and CHANGELOGs union-merged.
- A batch stage is cancelled when it streams no output for a stall window, defaulting to 300s and
  overridable via `stall_seconds` or `DAHRK_BATCH_STALL_MS`.
- A Pi stage runs against any provider the selected auth profile names, resolved into a private
  per-stage config.
- A Pi stage enforces edge tool policy (`fs_confine`, `read_only`, `write_scope`, `max_tool_calls`,
  `shell_guard`) before each tool runs, blocking a denied call up front.
- An interactive Pi stage can ask the human a structured multiple-choice question via
  `ask_user_question`, surfaced as a Linear `select` elicitation.
- A Pi stage can use brokered remote MCP servers through the node's local gateway proxy, so the raw
  token never reaches the agent.
- Setting `DAHRK_PI_ISOLATION=container` runs each Pi stage in a fresh per-job Docker container,
  imaged from `DAHRK_PI_IMAGE` (default `dahrk/pi:latest`).

### Changed

- The in-worktree scratch directory is `.dahrk/scratch`, with no `.skakel/scratch` compat shim, so
  workflow prompts must point at `.dahrk/scratch/output`.
- The node replies with a `cancel-ack` for every cancel and re-sends it on reconnect, so a cancel
  survives a hub restart.

### Fixed

- A repeated policy denial surfaces at most one human-visible error per distinct deny reason per
  stage.
- A pinned component is materialised only for the Claude runtime, with a warning naming the skipped
  component on every other runtime.

## [0.1.20] - 2026-07-18

### Added

- `install.sh` installs the client and enrols the node in one copy-paste, served at
  `https://dahrk.ai/install.sh` and taking a connect token. (#78)
- `dahrk start --no-service` enrols without installing the always-on service, for a node you
  supervise yourself. (#78)
- `dahrk repo add` registers the current repository with the hub, deriving the git URL and default
  branch from the working directory. (#74)

## [0.1.19] - 2026-07-15

### Fixed

- Worktree confinement allows heredoc scripts and relative paths issued after a `cd`, while still
  denying a whole-disk `find /`. (#71)

## [0.1.18] - 2026-07-14

### Fixed

- A node whose enrolment token is rejected parks, logs `EDGE_PARKED`, and reconnects in place after
  `dahrk start --token <token>`. (#68)
- The enrolment token lives only in `~/.dahrk/node.json` (0600); launchd and systemd units carry no
  copy. (#68)
- `dahrk status` reports a node the hub has rejected, points at `dahrk start --token`, and exits
  non-zero. (#68)
- Reconnect backoff is exponential from 500ms to a 30s ceiling, jittered so nodes do not return in
  lockstep. (#68)

## [0.1.17] - 2026-07-14

### Fixed

- Pi stages report their real dollar cost as `costUsd`, so a `cost_budget` policy can fire on them.
  (#66)
- A Codex stage states its missing price as a runtime known-unknown rather than reporting `$0`.
  (#66)

## [0.1.16] - 2026-07-13

### Added

- `dahrk status` states whether the client is up to date and how old that answer is, for example
  `up to date (checked 3h ago)`. (#62)
- `dahrk status --json` reports currency as `update: { kind, latest, checkedAt }`, where `kind` is
  `available`, `current`, or `unknown`. (#62)

### Changed

- The node checks for a new client every six hours rather than once a day, still jittered across a
  fleet. (#62)

### Fixed

- A Pi stage on a credential-less node lands a resolved model on a provider the node can
  authenticate to. (#63)
- `dahrk update` records the latest published version it learned, and `dahrk update --check`
  refreshes a stale answer by hand. (#62)
- `dahrk status` distinguishes being on the latest version from never having checked. (#62)

## [0.1.15] - 2026-07-13

### Added

- `dahrk status` leads with a verdict line and lists the runtimes with versions, the stages in
  flight, and the hub's last welcome. (#60)
- `dahrk status --json` prints the same facts as JSON, withholding the enrolment token. (#60)
- `dahrk stop` and `dahrk restart` refuse to kill a stage in flight and list what is running;
  `--force` interrupts anyway. (#60)
- `dahrk update` offers to restart a running node, and prints the command instead where there is
  nobody to ask.

### Fixed

- `dahrk update` points at `dahrk restart` to pick up the new version, and offers to run it. (#60)
- `start` and `restart` show the supervisor's output only when a step that mattered failed, hiding
  launchd's expected unload complaint. (#60)
- `dahrk restart` is one command reporting one outcome, and never records the node as deliberately
  stopped when the start half fails. (#60)
- `dahrk status` recognises a node started with `--foreground`, under pm2, or in a container, by
  reading the pidfile. (#60)
- `dahrk doctor` and `dahrk run preflight` fall back to `wss://api.dahrk.ai` when `DAHRK_HUB_URL` is
  unset. (#60)
- `dahrk update` hides the package manager's output unless the upgrade fails or you pass
  `--verbose`. (#60)
- Every command shares the same status symbols, layout, and hints, with colour switched off when
  piped, when `NO_COLOR` is set, or unsupported. (#60)

## [0.1.14] - 2026-07-13

### Added

- The node announces its in-flight jobs on connect, so a hub redeploy adopts work already under way
  rather than restarting your stage. (#58)

### Fixed

- Restarting the node mid-stage resumes from the on-disk job list (`~/.dahrk/jobs.json`) instead of
  re-running the stage from scratch. (#58)
- An interrupted stage preserves the killed agent's work on a `dahrk/wip/<runId>` ref and resets the
  worktree to the last complete commit. (#58)

## [0.1.13] - 2026-07-12

### Fixed

- When an agent asks several questions at once you are asked all of them, one at a time, with answers
  labelled `Q1..QN`. (#54)

## [0.1.12] - 2026-07-12

### Added

- A node with no login of its own can run `claude-code` and `codex` stages using the hub's brokered
  provider key. (#51)

### Fixed

- Runtime detection retries before concluding a runtime is absent, and re-probes about once a minute,
  tunable with `DAHRK_RUNTIME_RECHECK_MS`. (#50)
- The boot log states which runtimes were detected and warns when one advertised on the previous boot
  is missing. (#50)

## [0.1.11] - 2026-07-11

### Fixed

- A stage is confined to its run's worktree, scratch directory and toolchain reads; credentials and
  `/Volumes` are denied outright. (#47)

## [0.1.10] - 2026-07-11

### Added

- Each heartbeat reports node health: uptime, client version, job and worktree counts, reconnects,
  free disk, detected runtimes, and failure counts by category. (#42)
- Diagnostic logs from a node on your own hardware are never shipped unless you enable it. (#42)
- `DAHRK_TELEMETRY` is a ceiling the hub cannot raise: `off` sends nothing, `health` permits the
  health report and refuses log shipping. (#42)
- An operator can raise a running node's log shipping for a session without restarting it, reverting
  on reconnect. (#42)

### Changed

- Each `action` and `observation` carries its tool-use id, and result output gets its own
  16,000-character budget. (#44)

### Fixed

- `dahrk stop` names any surviving node another supervisor is running and exits 3 rather than
  reporting success. (#43)
- A node exiting removes the single-instance pidfile only while it still names that process. (#43)

## [0.1.9] - 2026-07-11

### Fixed

- The per-repo mirror keeps run branches under `refs/heads/*`, out of reach of a fetch, so a run in
  flight keeps its branch. (#39)
- A reaper reconciles run worktrees on disk at startup and after each stage, tuned by
  `DAHRK_RETENTION_MAX_RUNS` / `DAHRK_RETENTION_MAX_AGE_MS` and previewable with
  `DAHRK_REAPER_DRY_RUN=1`. (#39)
- A stale worktree's branch claim is cleared before a new worktree is created, and any discarded tip
  is parked under `refs/dahrk/salvage/`. (#39)

### Changed

- `dahrk start` installs and starts the always-on service and returns; use `dahrk start --foreground`
  (or `DAHRK_FOREGROUND=1`) for the blocking worker. (#38)

### Added

- The node writes a structured log at `~/.dahrk/logs/node.jsonl`, always at `debug`, rotated at 10 MB
  across five generations. (#40)
- `dahrk logs --run <runId>`, with `--level` and `--json`, filters a stage's lines by the identifiers
  the hub knows the run by. (#40)
- `dahrk diagnose` writes a local support bundle: identity, version, host, `doctor` verdict, log tail
  and crash records, uploading nothing. (#40)
- Uncaught exceptions and unhandled rejections are written to `~/.dahrk/logs/crashes/<timestamp>.json`
  and the node carries on (`DAHRK_CRASH_EXIT=1` to exit instead). (#40)
- `dahrk stop`, `dahrk restart` and `dahrk logs [-f] [-n <lines>]`, with `dahrk status` distinguishing
  a deliberately stopped node from a crash-looping one. (#38)
- The node reports an available client update at `dahrk start`, in `dahrk status`, and once a day in
  its log; disable with `DAHRK_NO_UPDATE_CHECK=1`. (#38)

### Fixed

- Git operations are logged: clone, mirror refresh and worktree create all appear at `debug`. (#40)
- Everything written to a log is scrubbed of credentials in URLs, sensitive keys, and token-shaped
  strings. (#40)
- Failures on best-effort paths, such as shipping a stage's final trace to the hub, are logged rather
  than silent. (#40)
- A node piped into a command that exits first (`dahrk start | head`) exits quietly instead of writing
  crash records. (#40)
- The containerised Pi runtime drains its error output, so a container with much to say cannot block
  on a full pipe. (#40)
- A node takes a lock at `~/.dahrk/node.pid`, so a second node on the same machine refuses to start.
  (#38)
- Linux nodes write `~/.dahrk/logs/node.{out,err}.log` like macOS, rotated past 10 MB, and
  `dahrk logs` reads them on every platform. (#38)
- `dahrk status` reports the log path from a single definition that honours `DAHRK_STATE_DIR`. (#38)

## [0.1.8] - 2026-07-11

### Added

- `dahrk status` reports locally, without dialling, whether this node is enrolled, which runtimes it
  serves, and whether the service is running. (#36)

### Fixed

- `dahrk service install` writes the service unit `0600`, and re-installing tightens the mode on a
  unit an older client left readable. (#36)
- The installed service points at a stable Node path that survives a `brew upgrade node`; re-run
  `dahrk service install` to repin. (#36)
- A token the hub accepts is cached in `~/.dahrk/node.json` (`0600`), so later runs re-attach as the
  same node without one. (#36)

## [0.1.7] - 2026-07-11

### Fixed

- An interactive stage that does not set `exit` defaults to `either`, so it can finish through the
  stage-complete tool. (#31)

## [0.1.6] - 2026-07-11

### Fixed

- `dahrk start` runs again on current Node; upgrade with `dahrk update` or
  `npm install -g dahrk-node@latest`. (#27)

## [0.1.5] - 2026-07-11

### Added

- `dahrk service install` / `uninstall` runs the node as a launchd or systemd user service, with no
  process manager and no root. (#22)
- An enforceable `read_only` stage policy denies every write and shell tool while still allowing
  `Read`, `Grep` and `Glob`. (#24)
- Interactive stages surface an agent's multiple-choice question as a Linear choice prompt with
  selectable options, one question at a time. (#25)

### Changed

- The node advertises its resolved worktree base on connect, so a run's real worktree location is
  recorded in the hub's projection. (#23)

## [0.1.4] - 2026-07-10

### Added

- `dahrk update` self-updates to the latest published client, detecting the install channel (npm,
  Homebrew, curl); `--check` reports availability only. (#18)
- `dahrk run <workflow>` runs a workflow locally against this node's worktree, starting with
  `preflight`, with no Linear, OAuth or issue. (#17)

### Fixed

- A `deliver` whose run branch adds nothing over the base short-circuits to an explicit `noop`:
  nothing is pushed and no pull request opened. (#16)
- Edge policy decisions are enforced before Claude tool execution, and artifact paths that escape the
  run worktree are rejected. (#19)
- A stage that has already finished replays its cached result when the hub re-sends the frame. (#20)
- The heartbeat pings the hub connection and terminates the socket after three missed replies, so the
  node reconnects. (#20)

## [0.1.3] - 2026-07-07

### Changed

- Release tooling strips internal identifiers and commit trailers from every notes source, prefers
  GitHub `(#N)` references, and dates version headings. (#10)
- A manual "Preview release notes" CI workflow drafts the notes for a prospective version without
  tagging or publishing. (#11)

## [0.1.2]

### Added

- A merge-free `mode: "backup"` force-pushes the run's HEAD to `dahrk/wip/<runId>` with no base merge
  or pull request. (#7)

### Fixed

- A push whose base merge never started reports a distinct `diverged` outcome, and genuine merge-start
  failures are re-thrown truthfully. (#6)

## [0.1.1]

### Fixed

- The default hub URL is `wss://api.dahrk.ai`; override with `--hub-url` or `DAHRK_HUB_URL`.
- The default git commit author and committer email is `noreply@dahrk.ai`.

## [0.1.0]

First published release of the `dahrk-node` edge client.

### Added

- `dahrk start --token <enrolment-token>` makes the process a self-managed node: it dials out over
  WebSocket, detects installed runtimes, and runs stages in git worktrees.
- Subcommand CLI: `dahrk start`, `dahrk doctor`, `dahrk help` and `dahrk version`, with `--ephemeral`
  for a throwaway node id.
- Token-only install: the hub URL defaults to the hosted hub, and `--token` / `--name` / `--hub-url`
  override the matching `DAHRK_*` env vars.
- Three install channels provide the `dahrk` command: npm, Homebrew (`dahrkai/tap/dahrk`), and curl
  from `https://dahrk.ai/install.sh`.
- pm2 config (`ecosystem.config.cjs`) for running a durable node from source.
- Tag-driven release CI: a `vX.Y.Z` tag publishes to npm, bumps the Homebrew tap formula, and cuts a
  GitHub release.

[Unreleased]: https://github.com/dahrkai/dahrk-node/compare/v0.4.7...HEAD
[0.4.7]: https://github.com/dahrkai/dahrk-node/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/dahrkai/dahrk-node/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/dahrkai/dahrk-node/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/dahrkai/dahrk-node/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/dahrkai/dahrk-node/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/dahrkai/dahrk-node/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/dahrkai/dahrk-node/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/dahrkai/dahrk-node/compare/v0.3.7...v0.4.0
[0.3.7]: https://github.com/dahrkai/dahrk-node/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/dahrkai/dahrk-node/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/dahrkai/dahrk-node/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/dahrkai/dahrk-node/compare/v0.3.3...v0.3.4
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
