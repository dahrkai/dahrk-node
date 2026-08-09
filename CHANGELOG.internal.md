# Internal changelog

Internal-facing companion to [`CHANGELOG.md`](CHANGELOG.md). This file is **never published** — it is
not in any package's `files`, and the release CI cuts the GitHub release from `CHANGELOG.md` only. So
it is the place for notes that should not reach users: internal tracker keys (`DHK-…`), run IDs,
refactors, build/tooling changes, and context that matters to contributors but not to people running
the client.

Rules of thumb:

- **User-visible change** (a behaviour, flag, or fix a self-hoster would notice) → [`CHANGELOG.md`](CHANGELOG.md),
  referencing the GitHub PR as `(#N)`, never a tracker key.
- **Internal-only change** (refactor, test, CI, dependency plumbing) → here. Tracker keys are welcome.
- A change can appear in both: the public line for users, the internal line with the `DHK-…` link.
- **The mechanism belongs here, always.** A public note is one sentence under 25 words stating the
  new behaviour, and `pnpm lint:changelog` enforces that. So the root cause, what used to happen, why
  it was wrong and how it was fixed have nowhere else to go: write them here, at whatever length is
  useful. Pairing a one-line public note with a full internal one is the normal shape, not a
  duplication.

`pnpm release <version>` rolls the `[Unreleased]` section of **both** files into a dated `[version]`
section, so the two histories stay aligned. The public file is sanitised (keys stripped) at release;
this file is left verbatim.

## [Unreleased]

### Changed

- `install.sh` detects the platform (`uname -s` plus a built-in parse of `/etc/os-release`) and probes
  for a package manager, then prints Node 22 install commands for that box; `scripts/test-install.sh`
  covers Debian/Fedora/Alpine/macOS/no-package-manager from fixtures under
  `scripts/fixtures/os-release/`, and CI now shellchecks the script.

  A user on Debian 12 hit `error: Node.js is not installed.` and was offered `brew install node` and
  `nvm install 22` — Homebrew is not on a Debian box and nvm was not installed, so every route the
  installer named was a dead end and they came back round to us. The advice was a fixed
  macOS-flavoured list with no idea what it was running on. The fix keeps the no-runtime contract
  (`testbed/bootstrap.sh:57-63` depends on it, as does `INSTALL_NODE=0`): we still refuse to install
  Node, we just stop guessing what would install it.

  The package manager is found by probing for the binary rather than matching `ID=` in os-release,
  because derivatives (Mint, Pop!_OS, Rocky) report their own ID while carrying apt/dnf, and an ID
  table would need extending forever. `/etc/os-release` is parsed with shell built-ins, never sourced:
  the script is piped into a shell that may be root, so writing that file must not amount to code
  execution here. `DAHRK_OS_RELEASE` overrides the path so the tests can use fixtures.

  Everything stays within the four external commands the stub PATH in `scripts/test-install.sh`
  provides (uname, node, npm, dahrk) — no grep/cut/sed — which is also why it survives a minimal box.

### Fixed

- `install.sh` checks `npm prefix -g` is writable before installing, and explains the two fixes
  (user-owned prefix, or sudo) rather than letting npm emit EACCES; it also verifies `dahrk` landed on
  PATH afterwards.

  This is the very next wall after Node on a stock Debian box, and a known one:
  `dahrk-harness/testbed/bootstrap.sh:90-97` deliberately declines to pre-configure a user-writable
  prefix so that onboarding has to answer the question. This is the answer. An nvm-managed Node, a
  Homebrew Node and root all pass the check trivially, so it is invisible in the ordinary case.

  The PATH check came from the (previously divergent) dahrk-web copy of the script, which had it while
  the canonical copy did not; it pairs with the user-owned-prefix advice, whose common failure is a
  prefix that was set but never added to PATH.

- `createWorktree` resolves `WorkspaceRef.seedRef` through the remote-tracking form and, failing
  that, one targeted fetch; an unresolvable seed now throws instead of falling back to the base
  branch (DHK-1057).

  The seed had never once resolved in production. The hub names the preserved WIP ref by its BRANCH
  name (`dahrk/wip/<runId>`, the hub's `wipRefFor`), because that is what the DHK-264 backup push
  targets on the real remote. The mirror, though, fetches with `+refs/heads/*:refs/remotes/origin/*`,
  so the branch lands only as `refs/remotes/origin/dahrk/wip/<runId>`, and git's ref-resolution ladder
  cannot reach that from an unqualified name (it tries `refs/remotes/<name>`, never
  `refs/remotes/origin/<name>`). The old `gitOk(mirror, ["rev-parse", "--verify", "-q", seedRef])`
  therefore returned false every time, and the `? :` around it dropped the seed WITHOUT A WORD.

  The consequence was a billed no-op. A `conflict-resolution` re-entry branched off `origin/main`
  with none of the work it was sent to resolve, the resolve stage correctly reported "there is in fact
  no conflict to resolve", and `deliver` then had an empty delta — which on DHK-1057 surfaced to the
  user as a GitHub 422 (`PullRequest.head invalid`) from the hub opening a PR for a branch that was
  never pushed.

  The throw is the other half of the fix: a seed the hub explicitly asked for is load-bearing, so
  silently substituting the base is never an acceptable degradation. Absent `seedRef` keeps the old
  behaviour exactly (remote branch, else base).

## [0.4.3] - 2026-08-09

### Added

- `GitService.probeFootprint(ref, { base })` measures the worktree against the run's merge base
  without committing or pushing, and `stage-runner`'s `finish` attaches the result to
  `JobResult.footprint` (DHK-1053).

  The point is a sequencing problem, not a rendering one. A deliver gate opens BEFORE the deliver
  action runs (`host-run-object.ts` appends `gate-opened` and returns; the action only runs once the
  gate resolves), so `projection.push` — the only thing that had ever measured a diff — is always
  absent at the moment a human is asked to approve one. Stages never commit either: their output
  accumulates uncommitted in the shared worktree until `commitPending` squashes the lot during
  deliver. So nothing in the system had ever measured the change at the point of approval, and the
  gate comment could show no file count at all.

  Three details in the probe carry the correctness:

  - `git add -A --intent-to-add` first, or a stage that only ADDS files (the common docs/scaffold
    case) measures as zero. It stages empty blobs only, and the next git operation of the run is
    `commitPending`'s plain `add -A`, so the index mutation is inert — covered by a test that probes
    and then pushes real content.
  - The comparison point is `merge-base(base, HEAD)`, not the base ref. Diffing the base directly
    would report commits the base gained since the run branched as deletions the run had made.
  - Scratch and gitignored paths are filtered, so engine state never inflates the blast radius.

  `isScratchPath` and the base-ref ladder were hoisted out of `commitAndPush` into shared closures
  (`isScratchPath(worktreePath, p)`, `resolveBaseRef`) so the probe and the push cannot drift on what
  "base" or "a change" means; `commitAndPush` now calls `resolveBaseRef` for its `commitsAhead`.

  The stage-runner call site is doubly guarded: it skips scratch-only (telemetry) runs, whose `ref`
  is a bare non-git directory with an empty base, and `typeof`-checks the method so a git service
  predating it degrades to "no measurement". `finish` is the only path that returns a stage result,
  so a throw there would lose the whole stage and its trace.

- Requires `@dahrk/contracts` 0.17.0 for `DiffFootprint` and `JobResult.footprint`.

- **Live node health over the socket (DHK-1059).** New `node-health-request` / `node-health-report`
  frame pair, the first request/response pair on this socket - `upgrade`, `policy` and `cancel` are
  all fire-and-forget. `ws-client.ts` answers in-process: Node version, runtime resolution, disk and
  worktree writability, plus whatever the injected `probeHostChecks` adds. Advertised as the
  `health-probe` capability on `hello`, which is what the hub gates on rather than a client version,
  so an un-upgraded fleet is answered "your client is too old" instantly instead of eating the hub's
  timeout.

  Two facts are synthesised rather than probed: hub reachability and token validity. The request
  arrived on a live, welcomed socket, so that IS the evidence - and re-probing would open a second
  WebSocket and risk spending a one-shot enrolment token (the DHK-1041 shape).

  The repo checks (`checkRepo`/`probeRepo`) are deliberately excluded and stay in the CLI. That is
  structural, not stylistic: the hub summarises this report into a durable node event, and the repo
  checks are the only ones whose `detail` strings can carry a customer path. A gatherer that takes no
  repo path cannot leak one. "Can this node reach my repo" needs a clone and a credential, so it stays
  a preflight run - now pinnable to a chosen node via `JobRequest.pinnedNodeId`.

### Changed

- `SUMMARISE_PROMPT` now asks for one plain sentence of at most 30 words and explicitly forbids
  command names, flags, paths and counts (DHK-1053). The old prompt invited "which functions or files
  changed, whether the tests pass", and models answered with a command transcript that then hit the
  280-char recap cap and clipped mid-sentence. The counts it used to solicit are now rendered
  separately from measured data, so asking the model for them was both redundant and unreliable.

- `packaging/homebrew/README.md` updated to reflect that `dahrkai/homebrew-tap` exists; removed stale
  "does not exist yet" bootstrap steps. Documentation only, no packaging change. (#190)

- `CONTEXT.md` takes the shared-kernel block from the workspace-root `CONTEXT.md`: adds the
  Integration, Installation, Secret, Account and Repository entries and sharpens Connection and
  Workspace. Generated by `scripts/sync-context.sh`, whose `--check` mode is the CI gate; edit the
  kernel only in the root file and re-run it, never here. (#192)

- **The pure health-check builders moved from `apps/edge-node` into `packages/edge/src/node-health.ts`
  (DHK-1059).** `packages/edge` cannot import from `apps/edge-node` (the dependency runs the other
  way), so a socket handler answering "is this node healthy" would have had to reimplement it - and two
  implementations of a health check is how a node comes to report itself fine to one caller and broken
  to another. `doctor.ts` and `preflight.ts` re-export them, so their callers and tests are unchanged.

  Anything needing `node:child_process` deliberately did NOT move: this package is the wire client and
  stays free of it, the same line `onUpgrade` draws. The supervisor and PATH probes are injected as
  `EdgeOptions.probeHostChecks`, implemented in `apps/edge-node/src/node-health-probe.ts` with async
  `execFile` rather than the CLI's `execFileSync` - this runs on the socket's event loop, where a
  synchronous spawn would stall heartbeats and trace streaming for every run sharing the node.

- **The worktree-root probe must judge the nearest EXISTING ancestor, not the root itself.** The root
  is created on demand, so on a node that has not run a job yet it does not exist - and probing it
  directly makes `checkWorktreeRoot` fail, which the fold turns into `unsound`: a brand-new, perfectly
  healthy machine told no stage can run on it. That is the most damaging thing this report can say,
  and a new node is exactly the one whose health an operator checks first. The CLI's preflight already
  did this correctly (`nearestExisting`); the socket handler did not, and `nearestExisting` is now
  shared rather than duplicated. Caught by CI, not locally, because the default worktree root resolves
  under the author's home directory where it already existed - so `ws-client-health.test.ts` now pins
  `worktreesDir` to a path that does NOT exist, modelling a fresh node instead of a warm laptop.

- `apps/edge-node/src/doctor.ts` exports `hostPresence` so the socket probe reuses the
  manager/unit/lock/state resolution rather than copying it (the copy is how `service.ts` and
  `status.ts` once came to disagree about where the logs lived).

- **Catalog moved to `@dahrk/contracts` `^0.16.0`**, which carries the new wire frames and
  `NodeHealthReport`. Contracts publishes from `dahrk-harness` `main` on a `package.json` bump
  (`.github/workflows/publish-contracts.yml`), so that side had to land first: until it did, `^0.16.0`
  did not resolve and pnpm failed at INSTALL rather than at typecheck, which blocks `pnpm lint` and
  `pnpm test` outright. Hence the bump is the last commit on this branch rather than the first - worth
  remembering for the next cross-repo wire change, because the obvious ordering (bump first, then
  write the code) makes the whole branch unrunnable.

## [0.4.2] - 2026-08-08

### Fixed

- **An anchored path containing a space bypassed worktree confinement entirely (DHK-1019).** In
  `looksLikePath` (`packages/edge/src/shell-scan.ts`) a whitespace-is-prose short-circuit ran *before*
  the anchor test, so any argument that both looked anchored (`/…`, `~/…`, `../…`) and carried a
  space was classified as prose and waved through. Quoting or backslash-escaping the space was enough:
  all six shapes resolved to `ok` where they should have been `escape`. The fix makes the anchor
  authoritative by dropping the early return, so an anchor decides the classification and whitespace
  no longer overrides it.

  Note the ordering hazard this one exposed rather than the defect itself: the six cases already
  existed in `shell-scan.test.ts` as `todo`, which is why the gap was known but not closed. They now
  assert `escape`, with a deny/allow integration pair added in `fs-confine.test.ts`. (#188)

- **Changelog hygiene:** this PR's public note was written under `[Unreleased]` while the 0.4.1
  release PR was in flight, so once that PR rolled the heading the merge deposited the bullet inside
  the published `[0.4.1]` section. The 0.4.1 GitHub release body was cut from the release commit and
  is unaffected, but `CHANGELOG.md` on `main` briefly claimed this fix shipped in 0.4.1. Moved to
  `[Unreleased]` for this release. Worth knowing that a note authored during a release window can land
  in the wrong section without any conflict.

## [0.4.1] - 2026-08-08

### Added

- **`run-finished` is now handled end to end, closing the follow-up DHK-1045 left open (DHK-1047).**
  The frame has existed in `@dahrk/contracts` since DHK-373, but nothing on the edge read it, so the
  node could only ever *infer* that a run had ended. `StageRunner` gains `finishRun(runId)`, which
  guards on `isBusy` and delegates to the existing `teardownRun`, and `ws-client.ts` dispatches the
  `run-finished` frame to it. Teardown is idempotent and a stage still executing wins, so a stray or
  duplicated frame cannot pull a worktree out from under live work.

  This restores the idle rule to something it can actually carry. DHK-1045 made `isLive` runs exempt
  from `maxIdleMs` entirely, which was correct but left both age paths inert: with nothing telling the
  edge a run had ended, no run ever became collectable by age. Now the hub says so explicitly, and
  disk is reclaimed at the moment the run finishes rather than waiting for a restart to hand the
  whole set back to the reaper. (#186)

### Changed

- **`@earendil-works/pi-coding-agent` `0.83.0` -> `0.84.1`** in `apps/edge-node` and
  `packages/executor-worktree`, with the lockfile regenerated. The matching `pi-ai` bump and
  catalogue regeneration shipped from dahrk-harness first, because `scripts/check-pi-pin.mjs` reads
  `PI_CATALOG_VERSION` from the published `@dahrk/contracts`. Version pins and lockfile only, no
  source change. (#184)

### Fixed

- **The reaper collected the worktree of a run parked at a human gate (DHK-1045).** Run
  `run-d8f42887-0852-476c-accd-aa89cb657b5e-c1` finished reproduce/build/test at 20:48, opened the
  deliver gate, and had its worktree reaped 12 h later during an unrelated preflight job's retention
  pass (`reason: "idle"`, `maxIdleMs` 6 h). The approval landed 25 h after that and the push died with
  `worktree missing for push`. The run had done all of its work and cost $2.25.

  The cause is that idleness was standing in for "finished". `lastUsedMs` is the mtime of
  `.dahrk/scratch/state.json`, so a run is idle from the moment its last stage ends - a gated run and a
  completed run look identical - and the only guard, `isBusy`, means "a stage is executing right now",
  which a gated run is not. Every run gated for longer than `maxIdleMs` was exposed; this is the third
  occurrence in the node log (2026-07-29, 2026-07-31, 2026-08-08).

  The fix is `isLive`: the runs this node still holds a worktree for are exempt from the idle rule
  entirely, rather than given a longer window. A longer window only moves the cliff (a gate open over a
  long weekend would find it again), and the number would be a guess at human behaviour. `broken` and
  the `maxRuns` count cap still apply to a live run, so the disk stays bounded, and liveness is
  process-local so a restart still hands the whole disk back to the reaper - the DHK-371 leak cannot
  return. The in-memory LRU in `applyRetention` had the same defect through `policy.maxAgeMs` and gets
  the same guard. (#185)

  This leaves the node inferring liveness rather than being told. The `run-finished` frame that would
  make it a fact exists in `@dahrk/contracts` (DHK-373) but no hub sends it and this client does not
  handle it; wiring it end to end is the follow-up, and it is what would let an idle rule apply to
  genuinely finished runs again.

## [0.4.0] - 2026-08-06

### Removed

- **Skakel is gone from the env surface.** The `SKAKEL_*` aliases were supported two different ways,
  and the two did not cover the same callers. `main.ts` folded every `SKAKEL_FOO` into `DAHRK_FOO` on
  a *copy* of the env (`applyEnvAliases`), which only reached code handed that copy; anything reading
  `process.env` directly needed its own hand-written `?? process.env.SKAKEL_*`, and thirteen sites had
  one. Modules with neither - `doctor.ts` (`lockFile(process.env)`, `stateFile(process.env)`) and
  `preflight.ts` - fell through the gap: a node configured with `SKAKEL_STATE_DIR` ran out of one
  directory while `dahrk doctor` probed `~/.dahrk`, reporting on a node that was not there.

  Deleting the aliases closes the gap rather than patching it. With no `SKAKEL_*` name in existence,
  reading raw `process.env` is correct by construction, so `applyEnvAliases` and its nine call sites
  are gone, `envWithFlags` is just the flag overlay it claims to be, and `updateStateDeps` in
  `main.ts` - which existed *solely* to route `dahrk update`'s cache write through the alias-applied
  env - is deleted along with its three uses; `update.ts`'s own default is now identical.

  Also removed: `legacyStateDir` and the `~/.skakel/node.json` identity fallback in `resolveNodeId`.
  A pre-rename node that never upgraded re-mints its nodeId and needs re-enrolling.

  Sites cleared: `git-service.ts` (worktrees/mirrors dirs), `turn-loop.ts` (idle, first-reply,
  coalesce, max-turns), `mock-runner.ts`, `pi-container.ts`, `index.ts` (runner, Pi isolation),
  `stage-runner.ts` (batch stall), `spike/run.ts`, `ecosystem.config.cjs`, `.env.example`, `README.md`
  and two test files.

### Fixed

- `preflight.ts` derived the state dir with its own inline `env.DAHRK_STATE_DIR ?? join(homedir(),
  ".dahrk")` and never imported `state.ts` - a second copy of the fallback chain, which is precisely
  the drift `state.ts` hoisted `logDir` to stop when `service.ts` and `status.ts` disagreed about
  where the logs lived. It now calls `stateDir(env)`.

### Added

- Commit signing. `GitService` takes a `signingKey` (OpenSSH private key text) per push and applies
  `-c gpg.format=ssh -c user.signingkey=<path> -c commit.gpgsign=true` at all three commit sites: the
  main commit in `commitPending`, the push-time base merge, and the commit that completes a
  deterministically pre-resolved conflict. The key is materialised exactly like the askpass token -
  0600, in its own `mkdtemp` dir outside the worktree, removed in the operation's `finally` - so the
  stage agent can never read it and it never reaches git's argv or any config file. `user.signingkey`
  points at the private key; git derives the public half, so there is no `.pub` sidecar and no agent.

  The key is the Dahrk bot's own, registered on the `dahrk-ai` GitHub account, which is what makes
  GitHub render the commit `Verified`. It is brokered per push rather than held on the node, matching
  the git token, and arrives on `PushJob.signingKey`. `stage-runner` reads it defensively so a hub
  older than the field just sends nothing and commits go out unsigned.

### Fixed

- The node no longer inherits the host's `commit.gpgsign`. With no key configured it now passes
  `-c commit.gpgsign=false` explicitly. Left implicit, a node on a host whose global git config sets
  `commit.gpgsign = true` signed Dahrk's commit with the *host user's* key: attributed to Dahrk,
  vouched for by a human, and rejected by GitHub as `verification.reason: "unknown_key"`. That is the
  literal cause of the unverified commits on `dahrkai/dahrk-node` (e.g. `8647309`), and it also meant
  the node was quietly borrowing a host credential it is never meant to touch.

- Release CI commits and tags as `Dahrk <noreply@dahrk.ai>`, not a third `dahrk-release
  <release@dahrk.ai>` identity, and SSH-signs both from a new optional `DAHRK_SIGNING_KEY` secret. The
  release identity could never have verified: GitHub only marks a signature verified when the commit
  email is a *verified address on the account owning the key*, and `release@dahrk.ai` is not one. The
  tag becomes annotated when the secret is present (a lightweight tag is a bare ref and cannot carry a
  signature) and stays lightweight when it is not, so a repo without the secret is unaffected;
  `release.mjs` already dereferences tags with `^{commit}`.

- `PushJob.identity` is now honoured. The hub has computed a per-repo `CommitIdentity` since DHK-60 and
  put it on the push frame, but `stage-runner` passed only `message`/`branch`/`base`/`credentialToken`,
  so it was dropped on the floor and every commit used the node's hardcoded `Dahrk <noreply@dahrk.ai>`.
  Author and committer are now separate throughout (`GIT_AUTHOR_*` / `GIT_COMMITTER_*` env, since git
  config has no `committer.*` keys); a partial override echoes the author onto the committer rather
  than falling back to the service default, so it cannot read as somebody else.

### Changed

- Node groups are retired hub-side (DHK-1039). An enrolment token now names the TENANT a node joins
  rather than a group from which the tenant was then read. Nothing changes in the `hello` frame:
  `servesRepoIds` stays on the wire as an advisory hint that may only narrow, never widen, the repos a
  node will take, so this is not a breaking `@dahrk/contracts` change and no republish is needed. The
  hub's `welcome.allowedRepos` now carries every registered repo in the tenant instead of a group's
  explicit allow-list.

- The hub enforces a minimum client version at the handshake (`MIN_NODE_CLIENT_VERSION`, 0.4.0). It
  closes with `EDGE_CLOSE.ENROL_INVALID` (4401) and an upgrade instruction rather than a fresh close
  code, deliberately: a new code would be unknown to exactly the old clients a version refusal targets,
  and they would reconnect-loop against a hub that will never accept them. 4401 is already treated as
  fatal by every published client, and the close text is printed verbatim.

- The legacy one-way `advertise` frame is no longer bound. It carried no `clientVersion`, so the
  version gate would refuse every sender regardless.

### Fixed

- `CLIENT_VERSION` was `process.env.npm_package_version ?? "0.0.0"`, which only holds a real value when
  the process starts through a package-manager script. An INSTALLED node - the normal case - has no
  such variable and reported `0.0.0`. That was cosmetic while the version only drew an "outdated"
  badge; with a minimum-version gate it would have refused every installed node from the hub its own
  release ships with. It now reads `version` from the package manifest beside the bundle, falling back
  to the env var.

## [0.3.7] - 2026-08-05

### Changed

- Public changelog entries are now one sentence, 25 words maximum, present tense, no bold lead-in and
  no mechanism; the mechanism belongs in this file. `lint-changelog.mjs` fails any entry over the
  limit, and it already runs in CI on every PR (`ci.yml:44`), so the rule is enforced rather than
  imitated. `CLAUDE.md`, `release.mjs` and the `dahrk-release` command carry the same rule; the
  release audit now reads a PR diff to settle *is this user-visible* and *which heading*, not to
  source a paragraph.

  Entries had drifted to 80-140 word paragraphs because the only written rule was "match the
  surrounding entries", which is imitation as a specification, and it compounded every release. All
  40 historical sections were condensed (16,189 words to 3,622) so that instruction now points
  somewhere sane. Headings and every `(#N)` reference are unchanged. The published GitHub release
  bodies were rewritten to match, since dahrk.ai/changelog renders from the Releases API rather than
  this repo; that also repaired v0.1.5, whose body documented one of its four changes - the
  #22/#23/#24 incident. (#178)

### Fixed

- `AuthProfile.defaultModel` reached the Pi adapter and was dropped on the floor by the Claude one,
  which read `ctx.config.model` and nothing else. An operator setting a default model beside a
  connected provider therefore got it honoured on Pi stages and silently ignored on Claude ones, with
  nothing in the trace recording the divergence. Survivable while a runtime was picked by hand; not
  survivable once DHK-1013's fix derives the runtime from the account's auth profile, which makes
  `claude-code` the runtime for every Anthropic-bound account and so for most stages - an
  account-wide default model would have been ignored across the board.

  `selectClaudeModel` (`claude-adapter.ts`) mirrors Pi's `selectStageModel` precedence: stage model
  wins, profile `defaultModel` fills in, neither leaves the runtime to choose. It deliberately does
  NOT throw where Pi does. Pi reconciles a model id against a multi-provider catalogue, so an
  unresolvable id there is a wrong answer waiting to happen; Claude speaks to exactly one provider
  and the SDK reports an unknown model itself. The option is spread via `modelOption` rather than
  assigned, so an absent model omits the key entirely - the SDK distinguishes that from `undefined`.

  Paired with dahrkai/dahrk-harness#616 (DHK-1013), which is what makes this load-bearing.

## [0.3.6] - 2026-08-05

### Added

- `runtime-detect` probe (`stage-runner.ts` `runtimeDetectProbe`), the second user of the `CheckProbe` seam
  added in 0.3.5, plus an injectable `StageRunnerDeps.probeRuntimes`. Requires `@dahrk/contracts` >= 0.15.0
  (`CheckProbe: "runtime-detect"`, `RepositoryCheck/ResolvedCheck.probeRuntimes`).

  Replaces preflight's `claude-runtime` check, which was wrong on two independent axes. Mechanism:
  `command -v claude` is uncorrelated with the ability to run a `claude-code` stage, because neither
  runtime is a PATH binary - `claude-adapter.ts` calls `query()` from `@anthropic-ai/claude-agent-sdk`
  (which spawns the binary vendored INSIDE that SDK) and `pi-adapter.ts` runs `createAgentSession()`
  in-process. `detect-runtimes.ts` already says this in its header; the check predated the ambient-mode
  deletion that made it true. Target: the hub probed Claude unconditionally while `resolveStageRuntime`
  had already redirected preflight's agent stages onto `pi` for a non-Anthropic tenant, so the report
  attested "Claude runtime ok" for runs that never touched Claude (`preflight-e26fa3b20ae4`, whose
  `analyse`/`report` traces both carry `runtime: "pi"` against an `openai-codex` credential).

  Asserts `capable`, NOT `available`: `available` folds in the `CredentialLatch`, a refusal memory that
  only clears on restart, and a REQUIRED onboarding check a stale memory can fail is DHK-464 again.

  The hub sets `command: "true"` on these checks rather than a descriptive one, and that is deliberate:
  a node predating the probe name falls back to spawning `command`, and there is no honest shell
  equivalent for "is this SDK resolvable from `executor-worktree`" (anything run in the worktree
  resolves from the wrong root). A false negative on a REQUIRED check is worse than a green one, so the
  fallback passes.

  Catalog bumped to `@dahrk/contracts` `^0.15.0`, published from harness `main` (DHK PR #614), and
  verified against the published package rather than a local overlay.

  **OUTSTANDING: a release.** This probe reaches no real node until the next `dahrk-node` release ships
  and nodes upgrade. Worth watching, because the sibling probe demonstrated the gap: `0.3.4` was tagged
  BEFORE #174 landed, so `repo-fetch` kept failing on the live node for hours after its issue was
  closed - visible in `preflight-e26fa3b20ae4`. `0.3.5` has since shipped with it.

## [0.3.5] - 2026-08-05

### Added

- `CheckProbe` / `GitService.fetchProbe` / `createCheckRunner(..., probes)`: the seam for a check the
  NODE performs rather than spawns, because it needs a credential the check env deliberately lacks.
  Requires `@dahrk/contracts` >= 0.14.0 (`ResolvedCheck.probe`).

  Diagnosed from `preflight-79af58f15a3a` (DHK): `repo-fetch` ran `git fetch --dry-run` through
  `sh -c` with `process.env` and no askpass helper, so it could not authenticate on any brokered node
  and reported `could not read Password ... Device not configured` every time. As a REQUIRED probe
  that pinned preflight to `pass-with-findings` permanently, which is what made onboarding's
  finding-free gate unreachable (same shape as DHK-464).

  The alternative - reusing `setupAuth` to put `GIT_ASKPASS` + `DAHRK_GIT_TOKEN` into the check env -
  was rejected deliberately: check commands are REPO-DECLARED for ordinary runs, so it would hand a
  token scoped (ADR 0003) to clone, push and open PRs to every workflow-authored command. The probe
  moves to the node instead of the credential moving to the probe.

  An unimplemented probe name is a failed check naming the gap, never a silent fall-through to
  `command` - for a credentialed probe that command cannot pass, so the fall-through would report a
  mystery auth error instead of the real cause. `fetchProbe` uses `spawn`, not the sync `git()`
  helper: it is the one git call here that waits on the network for up to a minute, and blocking the
  event loop for that would cost the heartbeat and stall every other run on the node.

## [0.3.4] - 2026-08-04

### Fixed

- **One seam now answers "does the supervisor have this job, and is it switched off?"** `status`, `doctor`
  and `liveNodePid` all read it through `probeService` (`service.ts`), so they cannot drift on how the
  question is asked. `ServiceStatus` gained `loaded` (non-optional on purpose - every construction site is
  a compile error rather than a silent omission), `disabled` and `lastExit`; systemd's probe now also asks
  for `UnitFileState` and `Result`. launchd needs a second spawn (`launchctl print-disabled`) to name a
  disable, so it is run only once `launchctl list` has already said the job is not loaded - the healthy
  path costs exactly one probe, and there is a spawn-count test pinning that. (#172)
- **`resolvePresence` tests intent BEFORE loadedness, and the order is load-bearing.** `dahrk stop` is
  itself an `unload -w` / `disable`, so a deliberately stopped node has byte-identical supervisor facts to
  a node broken by an interrupted restart. `desired` is the only thing that separates them, and reversing
  those two branches would make every stopped node fail `isUnhealthy` and page someone. Pinned by a test
  that runs the same `ServiceStatus` through both intents. (#172)
- **The supervised-restart refusal is the seam no unit test can really prove.** `runNodeRestart` now trusts
  `DAHRK_SUPERVISED=1` over `liveNodePid()` (which can answer "nothing running" about the supervised
  process itself: the launchd probe races a live job, and the pidfile can be stale), and refuses the
  stop/start fallback from in there with `SUPERVISED_RESTART_REFUSED = 5` rather than killing the process
  that would have restarted it. Tests drive a fake supervisor only. **Confirming the honest-failure path
  end to end needs a real supervised node whose kickstart is made to fail.** The disable-flag half was
  verified for real: `launchctl unload -w`, then `status` / `doctor` on the resulting host. (#172)
- **Cross-repo follow-up, deliberately not fixed here.** During the outage the portal held `RESTARTING`
  and left the node's borrowed `active=false` well past `UPGRADE_DEADLINE_MS` (300s), so a node that had
  gone away stayed both "restarting" and disabled in the UI. That is hub-side
  (`dahrk-harness/packages/hub/src/node-upgrade.ts`, the `restarting` case and `restoreActive`) and wants
  its own issue. The node-side fixes here make such a node diagnosable from its own host in the meantime. (#172)

## [0.3.3] - 2026-08-04

### Fixed

- **The upgrade restart is the one thing in this release no test can prove.** `planRemoteUpgrade().apply()`
  runs inside the supervised process, so the old route (`launchctl unload -w` then load) killed the
  process executing it and left the agent disabled. Restart now delegates to the supervisor
  (`launchctl kickstart -k`, `systemctl restart`), which replaces the process; the stop/start route stays
  for a registered-but-stopped node and as the fallback when the supervisor refuses, and
  `UPGRADE_RESTARTING` is written before either, because it is the last line the process is guaranteed
  to reach. Unit tests cover the command selection only. **Confirming the node comes back by itself
  needs a real press of Update against a supervised macOS node** - worth doing before anyone trusts the
  portal's Update button again. (#170)
- **`classifyRuntimeError` was always able to classify the pre-turn failures; it was never asked.** The
  outer job catch in `ws-client.ts` shipped a bare `fail`, so the hub fell back to sniffing the summary,
  and its `external` rule matches any mention of a vendor - a missing credential for the bound
  subscription was therefore billed as an Anthropic outage. Both seams now classify, and an unrecognised
  error still carries no class on purpose, so the hub's heuristic applies rather than a guessed label.
  Harness-side counterpart: `dahrkai/dahrk-harness#611`. (#170)

## [0.3.2] - 2026-08-04

### Added

- **A test corpus for the confinement scanner, at the seam it already had.** `scanCommand` has always
  been a function of `(command, roots, cwd)`, but its only coverage ran through `buildRules` +
  `computeFsRoots` against a real `git init` worktree under `$HOME`, so every assertion about the
  lexer cost a filesystem. `packages/edge/test/shell-scan.test.ts` drives the same function with a
  hand-built `FsRoots` record: 118 cases across escapes, ordinary build traffic, fail-closed lexing
  and `cd` cwd-threading, in ~10ms and with no git. Both shipped defects are pinned as regressions -
  DHK-998 across all five no-path argv0s by all six separators, DHK-999 across paths, apostrophes,
  backticks and `$(` in comments. No production code changed and no new exports: `scanCommand`'s
  interface is untouched, so this is coverage bought at the existing seam rather than a new one.
  One drift-guard keeps the synthetic fixture honest against `computeFsRoots` by asserting shape
  only, and `test/fs-confine.test.ts` is left alone as the integration pact.

  The corpus found a third defect of the same family, recorded as a `todo` test rather than fixed
  here: an anchored path containing a space is not confined at all, because `looksLikePath` rejects
  whitespace-bearing tokens as prose before it tests the anchor. Six live cases, filed as DHK-1019 -
  making the anchor authoritative changes what the guard denies, so it wants its own change.

### Changed

- **`CONTEXT.md` points at the file the shared loop actually lives in.** The `RuntimeSession` entry
  named `runner-shared.ts`, which was split into five concern-named modules and deleted; the loops
  are `runInteractiveLoop` / `runBatchLoop` in `turn-loop.ts`, and the port is declared in
  `runtime-session.ts`. `CONTEXT.md` is the navigation entry point, so a dangling filename there
  costs every agent that starts from it.

## [0.3.1] - 2026-08-04

### Changed

- **The credential latch now owns the refusal verdict, and the stage runner accepts an injected one.**
  The latch was a `Set` with a rename: the judgement it exists for - is this the provider refusing our
  credential, or an ordinary failure - lived at the call site in `stage-runner.runJob`'s `finish`, as a
  `startsWith` against a constant imported from `@dahrk/executor-worktree`, guarded by three
  conditions, with no test anywhere in `packages/edge` reaching it. `CredentialLatch.record` now takes
  the whole `CredentialEvidence` (runtime, status, summary, isCheck) and decides; the call site is one
  unconditional line. `markRefused`/`markAccepted` are gone from the interface and `refused()` is
  deleted (it had no callers, despite its doc claiming `dahrk doctor` used it), taking the interface
  from four methods to two. `StageRunnerDeps.latch` mirrors `DetectOptions.latch`, defaulting to the
  process-wide singleton so the two halves still agree, and the module comment that claimed the stage
  runner already accepted an injected latch is now true rather than aspirational. No behaviour change.
  (DHK-998)
- `CONTEXT.md` gains **Credential latch** in the node-local language. ADR 0001 leans on the concept
  (the refusal is "the single credential signal that survives") but the glossary never defined it.

### Added

- **Tests for all three links of the refused-credential chain**, which previously had none end to end.
  `executor-worktree/test/shared-loop.test.ts` pins the summary SHAPE at its source - that the prefix
  is at index 0, for every refusal vocabulary - so rewording `RUNTIME_ERROR_SUMMARY.config` reddens the
  package that caused it instead of silently switching the latch off two packages away.
  `edge/test/stage-runner.test.ts` proves the stage runner delivers the evidence, driven for both
  runtimes. `edge/test/credential-latch.test.ts` covers the rule itself with no git repo or runner.
  (DHK-998)
### Fixed

- **Every check stage crashed in `runJob` (DHK-1017).** `stage-runner.ts` read `agentConfig.stallMs`
  unconditionally when arming the batch stall watchdog, but a check job has no `agentConfig` - the wire
  contract narrows it away - so it threw `TypeError` before one check command ran. The unconditional
  form was introduced by DHK-210 with a comment reasoning it "equivalent to the old
  interactive-short-circuit"; equivalent for interactive stages, but that short-circuit also covered
  checks. Fixed with an optional chain. It reached release because `packages/edge` had no check-job
  test of any kind; there are now two, and the whole job kind is no longer untested.
- **An interactive refusal reached the credential latch as an acceptance (DHK-1018).**
  `runInteractiveLoop` caught a thrown turn, set `exited: "gate"` and left `status` at its initialised
  `"ok"`, never calling `classifyRuntimeError`. `status: "ok"` is the latch's CLEAR branch, so a
  refused credential on an interactive stage cleared a standing refusal instead of setting one -
  DHK-1002 running backwards. The catch now classifies exactly as `runBatchLoop` does and settles
  `fail` with the prefixed summary and `failureClass`, ahead of the exit-kind branches so the dead
  session is never asked to summarise. Scoped deliberately to CLASSIFIED failures: an unclassified
  interactive throw keeps its gate-exit recap, which leaves it reporting `ok` where the batch loop
  reports `fail`. That asymmetry is pinned by a test and called out in DHK-1018 rather than changed
  under a credential-latch fix.

Both were found by the reproduction tests written for the latch work above, which are now flipped to
assert the fixed behaviour.

## [0.3.0] - 2026-08-03

### Changed

- **Documentation now matches the credential model 0.2.0 actually shipped.** `CONTEXT.md` still defined
  `Ambient node` as a term of the ubiquitous language, and `README.md` (the npm front door) still told a
  new user their node needs either a logged-in `claude` on the host or `ANTHROPIC_API_KEY` in the
  environment. Both were removed in 0.2.0. `Brokered node` was a tautology and is replaced by
  `Brokered credential`, and `docs/logging.md` now separates "never sent" from "never read at all".
  Docs only, no client behaviour changed. (#162, DHK-1006)

### Added

- **ADR 0001, a node reads no host credentials.** Records the decision behind the 0.2.0 credential
  broker, arguing from the failure modes rather than the tickets: a service whose capabilities depended
  on which shell started it, two credential stores that could disagree, and a token revocable with
  nothing local changing. Creates `docs/adr/`, per `docs/agents/domain.md`. Companion to
  dahrkai/dahrk-harness#593. (#162)

## [0.2.0] - 2026-08-01

### Changed

- DHK-1006: ambient credentials deleted end to end. Removed `ambient-claude-auth.ts` (Keychain +
  `~/.claude/.credentials.json` resolution), `piAmbientCredentialAvailable`, `openPrAmbient` and the
  `gh` helpers in `git-service.ts`, the `sshKeyPresent` preflight probe, and `DAHRK_CREDENTIAL_MODE`
  with its `resolveCredentialMode` / `isCredentialModeExplicit` helpers. `detect-runtimes.ts` collapses
  to a capability probe plus the refused-credential latch: no CLI `--version` probing, no PATH
  dependence, no injected `piAmbientCredential` / `resolveAmbientAuth` seams.
- `credentialMode` is gone from the wire in both directions (`hello`, `advertise`, `welcome`), so the
  hub no longer pushes a mode and the node no longer sends or corrects one.
- `@dahrk/contracts` catalog entry `^0.11.1` -> `^0.13.0`, across two bumps (#156, #158). 0.13.0 is the
  release that actually removes `credentialMode`, `PushJob.openPr` and the `PushResult` PR fields from
  the contract, so shipping on it is the confirmation rather than the migration: this release compiles
  against a contract where those fields do not exist, which is the only way to prove no stale reference
  survived. A caret cannot cross a pre-1.0 minor, which is why each step needed its own PR.
- `resolveDeliverOutcome` no longer takes an `OpenPrResult`: the node reports no PR fields at all, since
  the hub opens every PR through the GitHub App.

## [0.1.31] - 2026-07-31

### Fixed

- [DHK-1004](https://linear.app/skakel/issue/DHK-1004) Ambient host-credential resolution
  (`packages/executor-worktree/src/ambient-claude-auth.ts`). The node reads every credential store it
  knows about (macOS Keychain and `~/.claude/.credentials.json`), picks the freshest unexpired
  credential and passes it to the runtime under `CLAUDE_CODE_OAUTH_TOKEN`, rather than leaving store
  selection to the subprocess. Diagnosed on runs `run-b9e8b611-b730-4533-beeb-dded4f52c9f4` and
  `run-4de3fcdc-e81c-49d7-860e-0b09de8756a6`, where a launchd-supervised node read a revoked Keychain
  token while the file store held a valid one; reproduced under a purpose-built LaunchAgent, with every
  other variable (binary, environment, HOME, cwd, SDK code path) eliminated first.

  The resolver never refreshes and never writes: the provider rotates the refresh token on every use,
  so a refresh the node does not persist would strand the credential for whoever owns the store. The
  same reasoning already governs the brokered subscription path.

  `probeRuntimeStatuses` consumes the same resolver via an injectable `resolveAmbientAuth`, so
  detection and the stage answer identically, and `baseOpts` in the detection tests stubs it so the
  suite no longer depends on the developer's own Keychain.

## [0.1.30] - 2026-07-30

### Added

- `refresh-contracts` workflow, proposing the `@dahrk/contracts` bump that a caret range structurally
  cannot make. The catalog pin stopped the three manifests drifting apart from each other; it does
  nothing about all three being frozen a minor behind together, because `^0.x.y` cannot cross a
  pre-1.0 minor. Mirrors `refresh-pi-pin`: rolling branch, PR only, no cross-repo token. Compares the
  lockfile's resolved version against npm rather than the catalogue's specifier floor, since a caret
  still moves within its minor and comparing the floor would open a no-op PR on every upstream patch.
  Verify runs `check-pi-pin.mjs` first, because a new contracts is where a provider catalogue that has
  outrun our Pi pin arrives from.

### Changed

- **Pin `@dahrk/contracts` once, via a pnpm catalog, and adopt 0.11.0.** Three packages depended on
  it with their own caret ranges, all stuck on `^0.10.0`. A caret on a `0.x` version does not cross
  the minor, so the workspace could not resolve the newly published 0.11.0 at all and was silently
  frozen a minor behind the wire protocol. `pnpm-workspace.yaml` now carries a `catalog:` entry and
  `apps/edge-node`, `packages/edge` and `packages/executor-worktree` all say `"catalog:"`; bump the
  one entry from now on, not the three manifests. This is the drift that already bit once, when
  `apps/edge-node` sat on `^0.8.2` while the other two had moved to `^0.10.0`.

  Adopting 0.11.0 is safe despite it being a breaking contracts release: the break is the removal of
  the `codex` runtime, and the node side of that retirement already landed (DHK-510, below).
  Typecheck, build and all 277 tests pass against 0.11.0.

  Note that 0.11.0 is also the first `@dahrk/contracts` release actually published by CI. Every prior
  release was hand-published, because `publish-contracts.yml` had no matching npm trusted-publisher
  entry and its OIDC token exchange 404'd on every run since it landed.

- `@dahrk/contracts` catalog entry `^0.11.0` -> `^0.11.1` and `@earendil-works/pi-coding-agent`
  `0.82.1` -> `0.83.0`, together because they are one ordering constraint: contracts 0.11.1 carries
  `PI_CATALOG_VERSION` 0.83.0, so bumping it alone fails `check-pi-pin.mjs`.
- The Pi packages are excluded from the `minimumReleaseAge` gate by name rather than by pinned
  version. `pnpm up` writes a version-pinned entry, which would both block the bump `refresh-pi-pin`
  exists to propose and grow four lines per Pi release.

### Fixed

- `refresh-pi-pin` now bumps **both** Pi manifests (`packages/executor-worktree` and `apps/edge-node`)
  rather than only the first, and asserts they converged before installing. Bumping one left
  `scripts/check-pi-pin.mjs` failing in the Verify step, so the 0.83.0 refresh never opened a PR.

- The release workflow's `Notify dahrk-web` step is now fatal instead of `continue-on-error` with a
  bare `::warning::`. `WEB_DISPATCH_PAT` had lost its `Contents: write` scope on `dahrkai/dahrk-web`,
  so every `repository_dispatch` 403'd while the release runs stayed green: dahrk.ai/changelog sat on
  v0.1.27 through both v0.1.28 and v0.1.29, and it was found by reading the site rather than from any
  CI signal. Two edits were needed, since the `if gh api ...; then ... else ... fi` construct swallows
  the non-zero exit on its own; the else branch now emits `::error::` and exits 1, naming the
  permission to check and the recovery command. The step deliberately stays **last**, after
  `npm publish` and the GitHub release, so a failure here loses only the site refresh. The Homebrew
  tap bump and the `Notify dahrk-harness` dispatch stay non-fatal, and an unset secret still skips.
  The PAT has been reissued and the site backfilled by hand; the real end-to-end test is this
  release's run. See also dahrkai/dahrk-web#57 for the nightly rebuild there.

## [0.1.29] - 2026-07-30

### Changed

- **DHK-971: remove the mock runner's read of the dead `StageConfig.tools` field.**
  `packages/executor-worktree/src/mock-runner.ts` `runBatch` read `ctx.config.tools?.[0]` to
  pick the tool name it emits in the mock action trace event. No other code in the node reads
  the field. The line is replaced with the literal `"shell"` (the previous fallback) so the mock
  trace is unchanged. No test depended on the tools-array path; all 277 tests pass. The field
  still exists in `@dahrk/contracts` — its removal is the follow-up DHK-984 (harness side).

- **DHK-980: reconciled the Pi event union against the shipped SDK declarations and retired the spike
  posture.** `packages/executor-worktree/src/pi-mappers.ts` carried a "SPIKE POSTURE" header saying its
  `PiEvent` shapes were authored to vendored docs and "MUST be reconciled against the real SDK types"
  (a sentence left unfinished). Each variant is now checked against the installed
  `@earendil-works/pi-coding-agent@0.82.1` declarations (`AgentSessionEvent`, the base
  `@earendil-works/pi-agent-core` `AgentEvent`, and `@earendil-works/pi-ai`'s `AssistantMessage` /
  `AssistantMessageEvent` / `Usage`). Two substantive corrections: `tool_execution_end` carries
  `result`, not `content` (the mapper read the wrong field, emptying every Pi tool observation - see the
  public note), and eight event types the SDK emits but the union did not classify (`agent_settled`,
  `entry_appended`, `session_info_changed`, `thinking_level_changed`, `summarization_retry_scheduled`,
  `summarization_retry_attempt_start`, `summarization_retry_finished`, `bash_execution_update`) are now
  recognised noise rather than falling through as unknowns. The noise list is a single `const`
  (`PI_NOISE_EVENT_TYPES`) driving both the `PiNoiseType` union and the `mapPiEvent` classification, so
  the two can no longer drift apart. New `packages/executor-worktree/src/pi-event-conformance.ts` is a
  type-only compile-time guard (the analogue of `test/pi-sdk-exports.test.ts` for event shapes) that
  reddens `tsc` if a Pi bump renames a mapped field or adds an unclassified event type; `pi-adapter.ts`
  loads the SDK by dynamic import, so this static assertion is the only thing that surfaces such drift.
  The normalised envelope is unchanged - the existing cross-runtime acceptance test still asserts Pi and
  Claude produce identical envelopes.
- **DHK-975: Correct stale Codex and tool-policy comments in the runtime adapters.**
  Removed Codex references from `overlay.ts` (file-header and inline branch comment) and
  `pi-adapter.test.ts` (file-header and test title). Replaced the superseded "policy enforcement is
  M6 future work" note in `claude-adapter.ts` `baseOptions` with a description of the wired
  `canUseTool` gate. No behaviour change.

### Added

- **Shared runtime conformance suite driving both adapters (#144).** New
  `packages/executor-worktree/test/runtime-conformance.test.ts` drives `createClaudeRunner` and
  `createPiRunner` through one identical assertion set via their existing injected session-factory
  seams, so a behaviour either adapter is meant to share is now asserted in one place rather than
  duplicated per-adapter. Covers trace-envelope parity, the buffered-response rule, the pre-execution
  gate on both batch and interactive (closing the Claude-side gap), elicitation, cost, cancel /
  timeout / burst, and error classification: 43 assertions across both rows, no skips. No production
  change. A deliberate-regression check was run to confirm a break reddens only the offending
  adapter's row. Known nits carried forward: the session fakes are duplicated across three test files,
  and the elicitation drive touches an SDK-private field.

- **DHK-982: container-isolated Pi reports cost and honours the stage model (#139).** `PiRpcSession`
  gains `getSessionStats()` with a `#refreshCost` that queries `get_session_stats` over RPC after
  `agent_end`, cached and never fabricating a `0`. A new `resolveStageModelId` in `pi-adapter.ts`
  reuses the tested `selectStageModel` / `pickAuthedModel` path and `pi-container.ts` passes the
  resolved id as `--model <id>`, failing loudly when it cannot resolve. Brokered MCP stayed out of
  scope. Watch item from review: `prompt()` awaits `get_session_stats` through the timeout-less
  `#send`, so a container Pi that does not implement that command would hang the stage.

- **DHK-973: Stage-runner integration suite now runs for both runtimes (claude-code and pi).**
  `packages/edge/test/stage-runner.test.ts` is parameterised over both runtimes via `forBothRuntimes`:
  16 runtime-agnostic scenarios (trace/finalise, telemetry-only, tenant matching, retention, watchdogs,
  cancellation, runtimeEnv injection, deny recording, progress relay, toolUseId correlation, setup step,
  DHK-371 busy-leak guard) now produce a `[claude-code]` and a `[pi]` variant each (32 tests). The
  "Claude-style" qualifier is removed from the pre-execution authorisation test name now that it is
  proven to hold for Pi too. One scenario (tenant-guard refuses) stays single-runtime with an inline
  note (guard fires before makeRunner is called; runtime is irrelevant). Non-runtime scenarios
  (artifact resolution, runPush, runtimeUsesMcpGateway) are unchanged.

- **DHK-972: Claude brokered-MCP gateway integration test and auth-profile coverage.**
  `packages/edge/test/claude-mcp-brokered.test.ts` runs the Claude adapter against the real node
  gateway and a real MCP server, asserting the brokered token never appears in the agent-facing
  config. `packages/executor-worktree/test/claude-runtime-env.test.ts` is extended with four
  auth-profile tests: multi-key `runtimeEnv`, opaque key names, `runtimeAuth` hint present alongside
  `runtimeEnv`, and ambient node with hint but no credentials. `buildBrokeredMcpServers` is now
  exported from `@dahrk/executor-worktree` so the edge integration test can import it symmetrically
  with `buildBrokeredPiMcpServers`.

## [0.1.28] - 2026-07-29

### Added

- **A packaging guard for the inlined-workspace seam.** `apps/edge-node/test/packaged-deps.test.ts`
  scans every bare import reachable from the three source trees tsup inlines into `dist/main.js` and
  asserts each one is a Node builtin or a declared dependency of the published manifest. This is the
  gap that shipped the Pi and MCP SDKs missing: `noExternal` inlines the workspace packages' code but
  leaves their dependencies to resolve from `apps/edge-node/package.json`, and nothing checked that
  the two agreed. A source checkout resolves either way, so the monorepo could not see the break.
  `scripts/check-pi-pin.mjs` now also reads both manifests and fails if their `pi-coding-agent` pins
  disagree, since the published one is what actually resolves the specifier the adapter imports.

### Changed

- **DHK-510: node-side codex retirement finished.** `makeRunner` no longer falls through to the Claude
  runner; `codex` is out of the local `RUNTIMES` accept-lists in `main.ts` and `state.ts` (so it is
  filtered from `DAHRK_RUNTIMES` and from a legacy `node.json`, which is the whole migration - unknown
  values were already dropped there). The wire-level `Runtime` union in `@dahrk/contracts` still
  carries `codex`: removing it is a harness-side change that must be published first, since
  `@dahrk/contracts` is hand-published and a bump without a release strands this repo. Nothing here
  depends on that landing.

- **Runtime detection split into capability + credentials.** `detect-runtimes.ts` no longer treats a
  `--version` response as the routing signal. `RuntimeStatus` is now
  `{runtime, capable, credential, available, detail, cliVersion?}`; `detectRuntimes`/
  `probeRuntimeStatuses` take an options object (`credentialMode`, `env`, `homeDir`, injectable
  `canResolve` / `piAmbientCredential`) instead of positional timeouts. Two traps worth recording:

  1. Capability must be resolved from `executor-worktree`, not `edge` - `import.meta.resolve` is
     relative to the importing package, and `edge` depends on neither SDK. Getting this wrong is
     invisible in the published bundle (one file, one resolution root) and breaks only source
     checkouts. Hence the new `runtime-sdks.ts` owning `RUNTIME_SDK` + `canResolveSdk`.
  2. The first draft asserted a Pi stage can never authenticate ambiently, reasoning from the hermetic
     per-stage config dir. Wrong: Pi reads provider keys straight off `process.env`, verified against
     the real SDK. `piAmbientCredentialAvailable` now asks Pi (`ModelRuntime.getAvailable()` over a
     throwaway config dir) rather than guessing from a hardcoded env-var list that would drift as Pi
     adds providers. Covered live in `test/runtime-sdks.test.ts`. Cold ~740ms (the SDK import), ~2ms
     warm, and skipped entirely under `brokered`.

  The CLI probe survives only as the ambient-login hint for Claude, where it is the best signal there
  is (macOS keeps the OAuth token in the Keychain, so there is no file to stat). It now takes its env
  from `opts.env` rather than inheriting the process's, so both halves answer about the same host.
  `main.ts` threads a mutable `credentialMode`, corrected from `welcome` via an `onEnrolled` hook that
  is now unconditional (an ephemeral node persists nothing but is the shape most likely to be
  brokered); `doctor` re-probes when the hub disagrees with its ambient assumption.

- **DHK-926: type the Pi SDK import and assert its exports at boot.** Replaced the untyped
  `const mod: any = await import(spec)` with a cast to a local `PiSdkModule` interface that
  declares every symbol `defaultCreatePiSession` destructures. Added `assertSdkSymbol` runtime
  checks that name the missing symbol and the installed SDK version, so a bump that removes an
  export fails at session-factory construction rather than mid-inference. Added
  `test/pi-sdk-exports.test.ts` which resolves the real installed `@earendil-works/pi-coding-agent`
  and asserts each required export is present. Also migrated the live factory from the removed
  `AuthStorage` + `ModelRegistry` pair to `ModelRuntime` (DHK-925 fix): `ModelRuntime.create`
  now receives the hermetic `authPath`/`modelsPath`, brokered API keys are applied via the
  existing `applyApiKeyAuth` helper (now async to match `ModelRuntime.setRuntimeApiKey`),
  and `createAgentSession` receives `modelRuntime` in place of the defunct pair.
  `packages/executor-worktree/src/pi-adapter.ts`, `src/pi-auth.ts`, `test/pi-auth.test.ts`,
  `test/pi-sdk-exports.test.ts`.

- **DHK-764: point the four ajv `$ref`s at the `dahrk.ai` schema `$id`.** Updated
  `packages/executor-worktree/test/claude-mappers.test.ts`,
  `packages/executor-worktree/test/pi-mappers.test.ts`,
  `packages/executor-worktree/test/pi-adapter.test.ts`, and
  `packages/executor-worktree/spike/run.ts` from
  `https://skakel.io/schemas/trace.schema.json#/$defs/event` to
  `https://dahrk.ai/schemas/trace.schema.json#/$defs/event`. Bumped `@dahrk/contracts`
  dependency range from `^0.8.2` to `^0.9.0` in all three package manifests.

- Render the run's Linear comment thread and one-hop issue manifest into the stage prompt
  (`commentsBlock` / `relatedBlock` in `prompt-assembly.ts`) and onto the worktree
  (`writeComments` / `writeRelatedIssues` in `stage-runner.ts`). Consumes the new
  `JobRequest.comments` / `JobRequest.relatedIssues` snapshotted hub-side at intake.

  Comments get their OWN inline budget (`MAX_INLINE_COMMENTS_TOTAL_CHARS`) rather than sharing the
  documents pool: the documents loop spends its budget in list order and breaks when exhausted, so a
  shared pool would let a noisy comment thread silently evict the attached spike findings a stage
  exists to build against. Comment truncation also keeps the NEWEST entries, the opposite of the
  documents block — a conversation's current state is at its end.

- Bumped `@dahrk/contracts` from `^0.9.0` to `^0.10.0` in all three manifests, which is the release
  carrying `JobRequest.comments` / `relatedIssues`. 0.10.0 rather than a patch because that release
  also retires the `skakel.io` schema `$id` (already repointed here by DHK-764 above), and a breaking
  change must not reach `^0.9.0` consumers automatically.

## [0.1.27] - 2026-07-26

### Fixed

- **`selectStageModel`: an unresolvable model id throws instead of falling through to Pi's default.**
  The adapter wrote `if (!resolved?.error) { ... }`, which discarded `resolveCliModel`'s error and left
  the selection `undefined`, so Pi ran the stage on its own default model and the run reported success.
  This is the mechanism that hid a stale provider catalogue for two minor Pi versions: the portal
  offered `claude-opus-5`, nodes pinned to 0.80.6 could not resolve it, and every affected run went
  green on a different model.

  The decision was extracted from the dynamic-import factory into a pure exported
  `selectStageModel(...)` so it is unit-testable without a live Pi install, matching how `pi-auth.ts`
  and the mappers are already tested; `defaultCreatePiSession` is now a thin caller that owns only the
  config-dir teardown on the throw path. Seven tests added in `pi-model-provider.test.ts`, including
  the no-error-no-model shape that actually caused the silent downgrade.

### Added

- **`scripts/check-pi-pin.mjs`, run in CI.** Asserts this repo's `@earendil-works/pi-coding-agent` pin
  is `>=` the `PI_CATALOG_VERSION` exported by the INSTALLED `@dahrk/contracts`. Nothing compared the
  two repos' Pi pins before, and they drifted (0.80.6 here vs 0.80.10 in the catalogue), which is what
  made the portal offer ids this node could not resolve. Deliberately `>=`, not `==`: a node ahead of
  the catalogue knows a superset and is harmless, so this repo can still ship ahead of a harness
  release. Reading the version from the published package also sequences the cross-repo bump correctly,
  since `@dahrk/contracts` is hand-published.

### Changed

- Bumped `@earendil-works/pi-coding-agent` 0.80.6 -> 0.82.1, matching the harness's pi-ai bump. Paired
  with `ARG PI_CODING_AGENT_VERSION` in the harness's `deploy/Dockerfile.edge`, which is guarded there
  by `deploy/test/pi-version.test.sh`.

- **Comments and fixtures that contradicted the post-rename code (Skakel → Dahrk residue).** The source
  here migrated some time ago; these were the descriptions of it that did not, so each one misstated
  what the code does. `stage-complete-tool.ts` described "the in-process `skakel` MCP server" while the
  exported name is `mcp__dahrk__dahrk_stage_complete`; a pi-container test asserted a container name
  "starting with `skakel-pi-`" when the source produces `dahrk-pi-`, so the title contradicted its own
  assertion; and ~40 branch fixtures across `git-service`, `worktree-reaper` and `stage-runner` used the
  `skakel/` prefix, which are test INPUTS, so they implied a prefix the code has not produced since
  DHK-332. Comment- and fixture-only; no behaviour change.

  The four ajv `$ref`s at `https://skakel.io/schemas/*` are deliberately untouched: they resolve
  against the published `@dahrk/contracts`, so they move only once that package ships the new `$id`
  (DHK-764, blocked on DHK-762/763).

## [0.1.26] - 2026-07-25

### Fixed

- **`runRepoSetup` had never executed in production (DHK-729/731).** The hub attaches the resolved
  setup step at `workspaceRef.setup`, and `@dahrk/contracts` declares it there, but the node read
  `(job as { setup?: ... }).setup` - the Job ROOT, where nothing ever sets it. `undefined?.command` is
  merely falsy, so setup silently never ran: no trace event, no warning, and both tickets marked done.
  The `as` cast is what hid it, defeating the compiler on exactly the seam it exists to guard, and the
  node's own tests set `setup` at the root too, so the bug was invisible to CI. The read is now
  `job.workspaceRef?.setup` and the two DHK-731 tests carry the real wire shape, so they exercise the
  feature for the first time.
- **`JobResult.verifications` had no producer (DHK-666).** The contract, the projection fold, the Card
  renderer and the tests all shipped, but `finish()` in the stage runner builds its result object
  field by field and never forwarded the key. Now forwarded for every stage, not just check jobs, so a
  stage-exit hook or an agent-run gate can populate it too.

### Added

- **`createCheckRunner` (DHK check stages).** Implements the `Runner` port, so the stage wall clock,
  `cancel()`, the trace writer, progress streaming and `finish()` all work unmodified -
  `createMockRunner` is the precedent for an LLM-free runner. Uses `spawn` with streaming capture
  rather than the `execFileSync` the setup and hook paths use: a check stage runs `pnpm test`, and
  blocking the event loop for minutes would stop the WebSocket heartbeat (so the hub's lease reaper
  would read this node as dead), stop progress and trace streaming, and stall every other run sharing
  the node. Reports `runtime: "check"` in the trace rather than impersonating an agent runtime.
- **`hello.capabilities`.** The node advertises `["check"]`, and the hub default-denies a check job to
  any node that does not. This is a safety gate, not an optimisation: `makeRunner()` falls through to
  Claude rather than erroring on an unknown job shape, so an older client handed a check job would boot
  an unbounded write-access agent with the `"Begin the stage."` fallback instruction, report `ok`, and
  let the run reach deliver green having run no checks at all.

### Changed

- **The batch stall watchdog is disabled for a check job.** `bumpStall` is only called from `onTrace`,
  and a check emits nothing between a command's `action` and its `observation`, so any check slower
  than the 300s default would have been cancelled as stalled - `pnpm test` on a real repo. The bounds
  are the per-check `timeoutSeconds` and the stage's own `timeout_seconds`.
- **`runner.summarise()` is not an inference call for a check job.** It is unconditional on an ok batch
  stage, so without the check runner's own deterministic summary a check stage would have spent a real,
  billed model turn describing a lint run - and stopped being a zero-cost stage.
- **Take `@dahrk/contracts` `^0.8.2`** for the check Job shape, `hello.capabilities`,
  `CheckFailureContext` and the widened `Runner.runtime` / `TraceRuntime`.

## [0.1.25] - 2026-07-23

### Changed

- **Take `@dahrk/contracts` `^0.7.0` and drop the last forward-compat shims for it.** 0.7.0 declares
  the three fields the node was reaching through casts (`PushResult.changedPaths` /
  `changedPathsTruncated`, and `RunnerContext.runtimeAuth`), so:
  - `push-outcome.ts` loses `PushResultWithFootprint` (`PushResult & Partial<DiffFootprint>`) and
    `PushResultWithWip` - both resolver signatures return a plain `PushResult`, and `PushMode` is now a
    `NonNullable<PushJob["mode"]>` alias rather than a hand-written union.
  - `pi-auth.ts` stops mirroring the hint types locally: `ApiKeyProviderHint` / `OAuthProviderHint` /
    `ProviderHint` / `CustomProviderModel` are re-exported from the contract, `PiAuthHint` aliases
    `RuntimeAuthHint`, and `readAuthHint` is a plain `ctx.runtimeAuth` read (was a structural cast).
  - `stage-runner.ts` drops the `(job as { runtimeAuth? })` cast on the job-run passthrough and the
    now-unused `PiAuthHint` / `PushJobWithMode` imports.
  No behavioural change - all three fields already rode the plain-JSON wire; this is type-declaration
  catch-up. Typecheck and the full suite pass unchanged.

## [0.1.24] - 2026-07-22

### Changed

- **Take `@dahrk/contracts` `^0.6.0` (was `^0.4.0`).** A caret range on a `0.x` version does not cross
  the minor, so the three consumers (`apps/edge-node`, `packages/edge`, `packages/executor-worktree`)
  were pinned to 0.4.0 and could not see anything published since. 0.6.0 carries the generated Pi
  provider/model catalog (36 providers, 1072 models) plus the auth-profile registry it now derives, so
  the hub can broker any provider Pi supports rather than the five that were hand-listed. No source
  change was needed here: typecheck and the full suite pass unchanged.
- **Two forward-compat shims are now removable** (follow-ups, deliberately not in this bump):
  `PushResultWithFootprint` in the deliver path, which 0.1.22 left in place because
  `@dahrk/contracts@0.4.0` omitted `numstat`/`scope`/`changedPaths`/`changedPathsTruncated` on
  `PushResult` - 0.6.0 has them, so the shim can go and the flat names can align. And `readAuthHint`'s
  structural cast in `executor-worktree/src/pi-auth.ts`, written against a `runtimeAuth` field that did
  not exist in the published contract - 0.6.0 declares it on the Job, so the cast can become a plain
  typed read.

## [0.1.23] - 2026-07-22

## [0.1.22] - 2026-07-21

### Added

- **Footprint source: the node computes the diff footprint and forwards it on the push result
  (DHK-615).** New pure `footprint.ts` (`parseNumstat` + `deriveFootprint`) in `@dahrk/executor-worktree`
  handles numstat binary/rename rows, sums files/added/removed, derives `scope`, and caps `changedPaths`
  at 100 with a `changedPathsTruncated` marker. `commitAndPush` computes it once from the existing
  `FETCH_HEAD...HEAD` range (reusing the noop scratch filter) and attaches `footprint` to `CommitPushResult`
  on the clean and conflict outcomes; `resolveDeliverOutcome` spreads the flat fields onto the wire
  result. The wire fields ride a forward-compat shim (`PushResultWithFootprint`) because the blocking
  DHK-613 contract republish (`numstat`/`scope`/`changedPaths`/`changedPathsTruncated` on
  `PushResult`/`PushOutcome`) has not shipped: `@dahrk/contracts@0.4.0` still omits them. Drop the shim
  and align the flat names once the contract is republished.
- **Give the Claude adapter an injectable session seam + characterisation tests (DHK-592).** Wrapped
  the Claude Agent SDK `query()` (and the interactive streaming `ManagedMailbox`) behind an injectable
  factory (`ClaudeRunnerDeps.createSession` / `ClaudeSessionLike`), mirroring Pi's
  `PiRunnerDeps.createSession` / `PiSessionLike`; the default remains the live `query()`-backed
  session, so production behaviour is unchanged. Added a scripted `FakeClaudeSession` and a
  `claude-adapter.test.ts` that drives `createClaudeRunner` without live inference or credentials -
  Claude's interactive settle logic is now covered end-to-end for the first time, pinning every exit
  kind (tool-exit, gate-summarise, idle-timeout, cancel, burst-coalescing) plus the batch/summarise
  outputs. Supporting change: `StageCompleteTool` gained a `capture()` entry point (the body the live
  MCP handler already runs) so the fake can drive a tool-exit without the SDK.

### Changed

- **Give the CYPACK-1177 settle rule one home (`response-rule.ts`).** "The response is the last
  assistant text, and never a tool-ended turn's body" was implemented twice - `consumeClaudeMessage`
  and `consumePiEvent` each had the settle decision inline, an invariant the two had to keep in
  lock-step. Extracted the decision into a shared `decideResponse(bufferedText, endedOnTool, status)`
  both mappers now defer to. The accumulators are deliberately NOT shared (Claude replaces the buffer
  per whole assistant message, Pi appends streamed `text_delta`s - forcing one accumulator would be a
  false abstraction); only the identical settle decision moved. New `response-rule.test.ts` pins every
  veto and the trimming; the mappers' existing fixture suites still cover the accumulation end to end.
  Behaviour-neutral.
- **Validate Pi RPC events at the wire boundary (`parsePiEvent`).** `PiRpcSession.#onLine` cast raw
  parsed JSON straight to `PiEvent` (`msg as PiEvent`) before forwarding to the mapper - an unvalidated
  spike type as the interop contract. A JSON `null`, a primitive, or a malformed `message_update` would
  crash the mapper on first field access (`ev.type`, `ev.assistantMessageEvent.type`) inside the stdout
  `data` handler. Added `parsePiEvent(unknown): PiEvent | null` in `pi-mappers.ts` (the type's owner),
  pinning exactly the invariants the mappers dereference unconditionally - an object with a string
  `type`, and a `message_update` whose `assistantMessageEvent` is an object - and routed `#onLine`
  through it, dropping anything that fails. Unknown `type`s still pass through as mapper noise. The
  embedded SDK back-end (real typed events) is unaffected. New coverage in `pi-mappers.test.ts` and
  `pi-rpc-client.test.ts` (a garbage-line stream that must not reach subscribers or throw).
- **Extract the push-outcome ladder out of `stage-runner.runPush` into a pure `push-outcome.ts`.** The
  deliver/backup/conflict/diverged/noop decision - ~90 lines of `PushResult` construction with its exact
  summaries and forwarded git fields - lived inside `runPush`'s closure, reachable only through a full
  push run. Lifted it into `resolveDeliverOutcome` / `resolveBackupOutcome` (plus the `PushMode` /
  `PushJobWithMode` / `PushResultWithWip` forward-compat shims), leaving `runPush` to own only the I/O:
  the repo-allowlist guard, worktree resolution, the `gitService` push calls, and the ambient PR open.
  The one behaviour-neutral reshuffle: the PR open is now computed right after `commitAndPush` and passed
  into the resolver, rather than inside the former clean-path branch - identical because only the clean
  path pushes (`r.pushed`), so `pr` is `undefined` for every non-clean outcome exactly as before. New
  `push-outcome.test.ts` pins all eleven branches of the ladder (status, integration/conflictFiles/PR
  fields, and each human summary); the existing `stage-runner.test.ts` push cases are unchanged. Pure
  internal refactor; production behaviour unchanged.
- **Hand the `RuntimeSession` its `hooks` immutably at construction; kill the mutated `hooks.ask`
  handshake.** The interactive elicitation `ask` genuinely depends on loop-owned state (the elicit
  router + the live `awaitingFirstReply` flag), so it must be built by the loop - but the session was
  built by the adapter *before* the loop ran. The old workaround was a temporal handshake across three
  files: the adapter seeded `hooks.ask` with a throwaway `defaultAsk`, wired the runtime's
  structured-question tool to read `hooks.ask` *lazily*, and `runInteractiveLoop` then *reassigned*
  `hooks.ask` mid-loop. Inverted it: the loop now owns session construction via the (previously dead)
  `RuntimeSessionFactory` port - it assembles the complete `{ emit, ask }` and calls
  `makeSession(hooks)`, so the session receives its final `ask` at construction. `runInteractiveLoop`'s
  signature is now `(ctx, turns, emit, makeSession, opts)`; both adapters hoist their interactive
  session build into a `makeSession` closure; the interactive-path `defaultAsk` placeholder, the lazy
  reads, and the `ctx as PolicyAwareRunnerContext` cast in the loop are gone. `runBatchLoop` is
  unchanged (batch never elicits). `shared-loop.test.ts` migrated to the new call shape and gained a
  case asserting a session's mid-turn `ask` routes through the shared router - coverage the mutation
  previously made awkward to write. Pure internal refactor; production behaviour unchanged.
- **Split `runner-shared.ts` into five concern-named modules.** The 666-line file had accreted six
  unrelated tenants behind one filename; a pure move (no signature, logic, or behaviour change)
  relocated them into `prompt-assembly.ts` (stage-prompt building + defang), `mailbox.ts`
  (`ManagedMailbox`, still exported from `index.ts`), `runtime-session.ts` (the `RuntimeSession` port,
  `TurnResult`, hooks, `makeEmit`/`EmittableEvent`, `PolicyAwareRunnerContext`, `SUMMARISE_PROMPT`),
  `elicit-router.ts` (the DHK-344 one-at-a-time router), and `turn-loop.ts` (`runInteractiveLoop` /
  `runBatchLoop` + idle/coalesce timing). Dependency direction is strictly acyclic. Import sites in
  both adapters, the mappers, and the test suites were repointed and `runner-shared.ts` deleted; the
  `PolicyAwareRunnerContext` back-compat re-export in `pi-adapter.ts` went with it. No test bodies
  changed - the existing `executor-worktree` suite is the safety net.
- **Move the Claude adapter onto `RuntimeSession`; both runtimes drive one loop (DHK-594).** Converted
  `createClaudeRunner` to build a `RuntimeSession` (`makeClaudeRuntimeSession`) over the existing
  `ClaudeSessionLike` transport and deleted its private seed → race → coalesce → settle loop: `runBatch`
  and `runInteractive` are now thin callers of the shared `runBatchLoop` / `runInteractiveLoop` from
  DHK-593, so that loop and the elicit `ask` map exist exactly once in the package (the adapter-local
  `COALESCE_MS` is gone). The session keeps the Claude-specific concerns above the transport seam:
  the buffered-response mapping (`consumeClaudeMessage`), stage-complete detection and its handed-back
  document (`TurnResult.artifact`), the recap-only `summarising` flag the `canUseTool` closure reads,
  and `sessionId`/`costUsd` capture; the `claude_code` preset, `sandboxOptions`, `runtimeEnvOptions`,
  `maxTurns`, brokered MCP, and the `AskUserQuestion` shadow-tool/`toolAliases` redirect stay in
  `runInteractive`. `summarise()` and `cancel()` remain Claude-specific `Runner` methods. Every
  `TurnResult` (tool-exit / gate-summarise / timeout / cancel, plus the document artifact and costUsd)
  is preserved: the DHK-592 characterisation suite passes unchanged, now driven through the shared loop.
- **Introduce the `RuntimeSession` port + shared loop; move Pi (embedded + container) onto it
  (DHK-593).** Defined a turn-level `RuntimeSession` port (`sendTurn` / `summariseTurn` / `cost` /
  `dispose`) plus `TurnResult` / `RuntimeSessionHooks` in `runner-shared.ts`, and lifted the interactive
  and batch orchestration out of `pi-adapter.ts` into `runInteractiveLoop` / `runBatchLoop` there. The
  loops own the seed → race → coalesce → settle state machine (tool-exit / gate-summarise / timeout /
  cancel) and reference only the port, never a `PiEvent`. A single `PiRuntimeSession` wrapper over the
  existing `PiSessionLike` transport holds the `consumePiEvent` mapping and stage-complete detection, so
  both Pi back-ends - embedded (`defaultCreatePiSession`) and container (`PiRpcSession` via
  `createIsolatedPiRunner`) - drive the one shared loop; the container `summariseTurn` tool-denial stays
  a documented no-op. The loop is now proven runtime-agnostically in a new `shared-loop.test.ts` against
  a `FakeRuntimeSession`, and the self-seed orchestration assertion migrated out of `pi-adapter.test.ts`,
  which keeps its Pi-specific coverage (trace envelope, cost, model resolution, MCP, DHK-504 gate,
  DHK-505 elicit, DHK-511 teardown). Per-exit `TurnResult` output (summary / status / artifact /
  sessionId / costUsd) is preserved; the one deliberate unification is that the interactive gate-exit
  summarise now denies tools and emits no trace, matching the batch summarise path. Seeds the
  `RuntimeSession` glossary entry in `CONTEXT.md`.
- **Unify the shared runtime-adapter helpers (DHK-591).** Collapsed the pieces the Pi and Claude
  adapters copied between themselves into single shared definitions in `runner-shared.ts`, with no
  behaviour change: `PolicyAwareRunnerContext` is now defined once and imported by both adapters
  (`pi-adapter.ts` re-exports it so existing consumers keep resolving the name), and the elicit
  outcome→text mapping lives in one `elicitOutcomeReply` helper used by both adapters and the Pi
  no-handler fallback, so the four tool-result strings appear exactly once. Also swept the stale
  "Codex" references (left over from the removed runtime, DHK-510) out of the executor-worktree
  adapter/mapper/shared comments.

## [0.1.21] - 2026-07-19

### Added

- **Wire brokered MCP into the Pi adapter via the node-local gateway proxy (DHK-507).** Added
  `buildBrokeredPiMcpServers` (pure, mirrors the Claude adapter's `buildBrokeredMcpServers`) and
  `createBrokeredMcpExtension` (an inline Pi extension whose async factory acts as an MCP client:
  connect over Streamable HTTP to `mcpProxyBaseUrl/<id>`, list tools, register each via
  `pi.registerTool`) in `pi-adapter.ts`; `defaultCreatePiSession` appends it alongside the tool-gate
  extension when the stage declares brokered servers. Widened the `stage-runner.ts` gateway gate from
  `claude-code` to a `runtimeUsesMcpGateway` predicate (Claude + Pi, not Codex). Declared
  `@modelcontextprotocol/sdk@1.29.0` as a direct dependency of `executor-worktree` (was a transitive
  peer of the Pi SDK) and a devDependency of `edge` (stub MCP server in the e2e test). Tests:
  `pi-mcp.test.ts` (pure builder + extension against a direct stub), a `runtimeUsesMcpGateway` unit in
  `stage-runner.test.ts`, and `pi-mcp-brokered.test.ts` (real gateway + extension, asserting the token
  is injected upstream and never reaches the agent-facing config). Pi 0.80.6 kept; no SDK upgrade.

### Changed

- **Clarify the batch stall-watchdog window computation (DHK-210).** Split the nested
  `stallMs` expression in `stage-runner.ts` into a `stallSource` fallback (config `stall_seconds` →
  env → 300s default) and a separate non-negative-integer clamp that mirrors `killMs`. No behaviour
  change: reading env has no side effects, so computing the source unconditionally is equivalent to
  the old interactive short-circuit.

- **Tidy the Pi adapter and its test path (DHK-508).** In `pi-adapter.ts`, `runInteractive` now casts
  `ctx` to the module's existing `PolicyAwareRunnerContext` (which already declares `emitElicit`)
  instead of an ad-hoc inline `RunnerContext & { emitElicit? }` that duplicated it, so both the
  tool-gate and elicit paths reach the ctx through one named shape. Removed a dead unused `here`
  binding from `pi-adapter.test.ts` and `pi-mappers.test.ts`. Type-only / test-only; no behaviour
  change (the 202 executor-worktree tests are unchanged and pass).

### Removed

- **Remove the `.skakel/scratch` transition scaffolding (DHK-565).** Deleted `installCompatSymlink`
  and `SCRATCH_DIR_COMPAT` from `git-service.ts`; removed the `.skakel/scratch` entry from
  `excludeScratchLocally`, the `git rm --cached` for the compat symlink in `commitPending`, the
  `SCRATCH_DIR_COMPAT` path checks in `isScratchPath`, and the `--exclude .skakel/scratch` from the
  `git clean` in `reconcileInterrupted`. Removed `SCRATCH_OUTPUT_DIR_LEGACY` and its fallback loop
  from `stage-runner.ts`. Removed the `.skakel/scratch/state.json` candidate from
  `worktree-reaper.ts`. Dropped `.skakel/scratch/` from `.gitignore`. Updated test assertions that
  checked for the compat path. No behaviour change for any worktree that was set up after 2/7.

- **Remove the Codex runtime adapter (DHK-510).** Deleted `codex-adapter.ts`, `codex-mappers.ts`, and
  their three test files; dropped the `codex` branch from `makeRunner`; removed the `codex --version`
  probe from `detect-runtimes`; removed `@openai/codex-sdk` from `packages/executor-worktree` and
  `apps/edge-node`. Pi reaches GPT/Codex models through OpenAI auth, so no model coverage is lost.

## [0.1.20] - 2026-07-18

### Added

- **CI: smoke-test `scripts/release.mjs` on every PR** (DHK-393). A new `smoke-release-script` job
  in `ci.yml` runs `node scripts/release.mjs <next-patch> --dry-run --no-ai` on every push to main
  and every pull request. Exercises `sanitizeNotes`, `rewriteChangelog`, `rollInternalChangelog`, and
  `bumpPackage` — the code paths that failed in the 0.1.11 incident — without writing files or
  touching git. Also catches changelog edits that would choke the rewriter.

- **`release.yml` now tells dahrk-web when a client is published.** A second `repository_dispatch`
  (`dahrk-node-released`, gated on a `WEB_DISPATCH_PAT` secret) fires alongside the existing harness
  notify, triggering the marketing site's deploy. `dahrk.ai/changelog` is generated from this repo's
  GitHub Releases feed, so a release changes that site without any commit landing there and nothing
  would otherwise rebuild it: the page would lag every release until an unrelated push happened to
  refresh it. Non-fatal and last, like the tap bump and the harness notify: npm and the GitHub release
  are the release, and an unreachable downstream repo must never fail a publish. If the secret is
  unset the step is skipped and the page can be refreshed by hand
  (`gh workflow run deploy.yml --repo dahrkai/dahrk-web`).

### Fixed

- **`scripts/release.mjs`: the commit-log range no longer crashes on a not-yet-created tag.** The
  `smoke-release-script` guard (DHK-393) runs the script in dry-run on every PR, including the release
  PR itself - where `[Unreleased]` is already rolled into a dated heading, so `prevTag` resolves to the
  version being released, a tag not created until merge. `draftSection` ran `git log v<version>..HEAD`
  against that missing revision and exited 128. The range now uses the tag only when
  `git rev-parse --verify` confirms it exists, falling back to full history otherwise. No effect on a
  real release (which always carries hand-written `[Unreleased]` notes and never enters `draftSection`).

### Changed

- **`GitService`: fold the repeated brokered-or-ambient credential setup into one `resolveRemoteAuth`
  helper** (DHK-252). The three real-remote network paths (`commitAndPush`, `backupPush`,
  `reconcileInterrupted`) each open-coded the same two lines - `setupAuth(token)` for the transient
  `GIT_ASKPASS` helper and `withTokenUser(url)` for the `x-access-token@` remote - so the shared
  credential plumbing the DHK-252 clean-up will build on now lives in one named place. Pure refactor:
  the helper returns the same `{ remote, authEnv, cleanup }` each site used before (raw `authEnv` so
  `commitAndPush`'s local merge still gets the exact env it did), so behaviour is byte-for-byte
  unchanged. `createWorktree` keeps its own auth handling: it drives the mirror through `ensureMirror`
  (which owns URL rewriting) and needs no real-remote URL.

## [0.1.19] - 2026-07-15

## [0.1.18] - 2026-07-14

### Added

- **`release.yml` now tells dahrk-harness when a client is published** (DHK-437, #69). A `repository_dispatch`
  carrying the new version fires at the end of the publish job and triggers the harness's
  `update-platform-node` workflow, so the platform edge node tracks the latest published client instead of a
  hand-maintained pin in the harness Dockerfile. That stale pin is what shipped a client which could not
  authenticate (#63) and silently stopped the harness's admin loop. Guarded like the Homebrew tap bump
  directly above it: last in the job, `continue-on-error: true`, and skipped entirely when
  `HARNESS_DISPATCH_PAT` is absent - npm and the GitHub release *are* the release, so an unreachable
  downstream must never fail a publish. Needs a new **optional** repo secret `HARNESS_DISPATCH_PAT` (a
  fine-grained PAT on `dahrkai/dahrk-harness`, Contents: read and write); without it the step no-ops and the
  harness is updated by hand with `gh workflow run update-platform-node.yml`.

### Changed

- **A rejected node now parks in-process rather than trusting its supervisor to stop it** (DHK-436, #68). The
  exit-78 contract only ever held on systemd (`RestartPreventExitStatus`) and pm2 (`stop_exit_codes`);
  launchd's `KeepAlive` takes no exit code, so macOS respawned the process forever. Parking is the only
  mechanism that actually stops the loop on all three, and it buys a rotated token healing a live node with no
  restart. The exit-78 path survives only for a node with no durable token source (`--ephemeral`, CI), which
  has nothing to re-read and so must fail fast.

- **`serviceEnv` no longer bakes `DAHRK_ENROL_TOKEN` into the unit; `~/.dahrk/node.json` is the single home**
  (DHK-436, #68). Two homes plus an env-over-disk preference is what made re-enrolment a no-op. No migration
  shim was written: a unit from an older client differs from what we render today, so the existing "is the unit
  on disk the one I would write?" self-heal rewrites it, and a supervised node prefers the disk in the
  meantime. `dahrk start --token` validates against the hub before writing, but only an outright rejection
  blocks the write - an unreachable hub is not evidence about the token.

## [0.1.17] - 2026-07-14

### Changed

- **Cost capture is now per-adapter, and only Claude and Pi can actually price a run** (DHK-434, #66). Pi reads
  the aggregate `getSessionStats().cost` its own session already computes, so a single read at settle covers the
  batch turn, every interactive turn, and the engine-owned summarise turn on the warm session. `getSessionStats`
  is declared **optional** on `PiSessionLike`: an older or minimal session omits it, and the adapter then reports
  no cost rather than a fabricated `0`. Any new fake session in a test that asserts on `costUsd` has to supply it.

- **Codex's cost gap is a deliberate known-unknown, not an oversight** (DHK-434, #66). The Codex SDK's `Usage` is
  token-only (`input_tokens` / `cached_input_tokens` / `output_tokens` / `reasoning_output_tokens`); there is no
  price field anywhere in its types, and a real figure would need a pricing table the client does not carry. So
  `codex-adapter.ts` leaves `costUsd` unset and emits `CODEX_COST_UNAVAILABLE_NOTE` on stderr, the same channel
  the adapter already uses for its other known-unknowns (MCP, interactive tool-exit). If a pricing table ever
  lands, that note is the thing to delete. Do not "fix" the $0 by writing a zero.

## [0.1.16] - 2026-07-13

### Changed

- **`runUpdate` now takes `saveResult` as an injected dep** and the test harness always supplies a fake (#62).
  Worth knowing because the bug it fixes is latent elsewhere: the `Partial<Deps>` + real-`defaultDeps` pattern
  used throughout the client means a test that simply omits a dep falls through to the real one. Here that
  meant the update tests wrote the developer's actual `~/.dahrk/node.json` - which they did, before the fake
  went in. Any new test against a `Partial<Deps>` entry point should assume an omitted dep is a live one.

- **The Pi model fix lives in `packages/executor-worktree/src/pi-adapter.ts`** and leans on Pi's own
  `registry.getAvailable()` rather than a hard-coded provider list (#63). Family matching strips a region or
  vendor prefix and a `-v1:0` revision, so `us.anthropic.claude-opus-4-8` and `claude-opus-4-8` are matched as
  one model. The model ids in the tests were read out of the built edge image, not invented, and the fix was
  exercised against the live SDK in that image.

## [0.1.15] - 2026-07-13

### Changed

- **New `apps/edge-node/src/ui.ts`: the client's one presentation layer.** Colour, status symbols, the
  key/value row, next-step hints, durations, and the confirm prompt now live in one module that every command
  renders through. Before this, each command had invented its own formatting (`status` had a padded label
  gutter, `doctor` had `[PASS]`/`[WARN]`/`[FAIL]` tags, `preflight` was the only place that had ever used a
  tick) and the identical `process.stdout.write` sink was copy-pasted into seven modules.

  Zero new dependencies: colour is `node:util`'s `styleText`, which has been in Node since 22 - the floor the
  client already requires. The capability gate (TTY / `NO_COLOR` / `TERM=dumb` / `FORCE_COLOR`) is our own
  rather than `styleText`'s, because that only learned to check the stream in 22.8 and we support 22.0, and
  because doing it ourselves makes the decision injectable and therefore testable.

- **`ServiceDeps.run` captures instead of inheriting stdio**, returning `{ code, output }`. `runCommands`
  prints the captured text only when a non-`ignoreFailure` command fails. This is what silences the
  `launchctl` chatter; the previous `ignoreFailure` flag suppressed the exit code but the output had already
  been streamed to the terminal by the time anyone looked at it. `spawnUpgrade` in `update.ts` does the same
  for the package manager.

- **`runNodeRestart` in `service.ts`**, replacing the `stop()`-then-`start()` composition in `main.ts`. It
  passes `alwaysLoad` to `runNodeStart`, which is a correctness fix, not an optimisation: `launchctl` returns
  before the job has finished going away (the race `foreignNodePid` already documents), so re-probing "is it
  running?" after the unload could see the node still up, no-op the start half, and leave it DOWN. A restart
  has already decided; it does not ask again.

- **`status.ts` splits into `gatherFacts` (IO) and `renderStatus` (pure)**, so `start` / `restart` / `stop`
  render the same canonical block rather than three hand-rolled summaries. New facts enter as fields on
  `StatusFacts` plus an injectable dep, keeping the renderer testable: pidfile liveness (via `resolvePresence`,
  which is what fixes the foreground node reading as "not installed"), `probeRuntimeStatuses` for versions,
  the job ledger for in-flight work, and `lastConnection` over the `EDGE_*` markers in `node.jsonl`.

  The two contracts `status` is built on are unchanged and still enforced by tests: it makes NO network
  request, and the only process it spawns is the supervisor probe. Every new fact is a local file read
  precisely so that stays true.

- `dahrk diagnose` strips ANSI from the doctor's report before writing it into the support bundle: stdout is a
  TTY when an operator runs it, so the report is correctly coloured, but the bundle is a JSON file someone
  will read in an editor.

## [0.1.14] - 2026-07-13

### Node announces its in-flight jobs on connect, and persists them across a restart, DHK-416

The node half of DHK-415 (whose hub-side adoption path shipped live but **dormant**: `reconcileAnnouncedJobs`
does nothing until a node actually emits `hello.inFlightJobs`). This is the activation switch.

- **`@dahrk/contracts` bumped `^0.2.0` -> `^0.3.0`** across `packages/edge`, `packages/executor-worktree`
  and `apps/edge-node`. Note 0.3.0 existed in the harness repo but **had never been published to npm** -
  DHK-415 bumped the version and did not release it, so `inFlightJobs`, `JobRequest.payloadVersion` and
  `isPayloadVersionSupported` were unreachable from here and no node-side work was buildable. Published as
  part of this ticket. A caret on a `0.x` version does not cross the minor, so the dep bump is load-bearing,
  not cosmetic.
- **New `packages/edge/src/job-ledger.ts`**: a durable JSON ledger (`~/.dahrk/jobs.json`, 0600, atomic
  temp+rename, corrupt reads degrade to empty). Injected through `EdgeOptions.jobLedger` rather than
  constructed in `packages/edge`, which has no dependency on the CLI app where the state-dir convention
  lives - the same seam as `onEnrolled`. Ephemeral nodes get the null ledger.
- **`ws-client.ts`**: `running` widened from `Set<jobId>` to `Map<jobId, JobLedgerEntry>` and written
  through to the ledger on start/finish for both the job and push paths; `sendHello` announces
  `inFlightJobs`; a new boot reconciliation runs (awaited) before `connect()`, ahead of the DHK-371
  worktree reap, which must not run first or there would be no worktree left to preserve a tail from.
- **`git-service.ts`**: new `reconcileInterrupted` (preserve the uncommitted tail on a local + remote
  `dahrk/wip/<runId>` ref, then hard-reset to the last completed commit). Not `backupPush`, though it
  shares `commitPending`: `backupPush` leaves HEAD advanced onto the tail (right before a reap, wrong
  before a re-run) and throws when it cannot reach the remote (wrong at boot, which runs before the socket
  is up and must still yield a clean tree offline). `refFor` now also carries `branch`, which it computed
  and dropped.

**The announce filter is a safety property, not tidiness.** The hub's gate version-rejects an announced job
whose `payloadVersion` is absent or malformed: it calls `markDispatchDead`, sends `cancel`, and fails the
awakeable. So announcing a job we cannot version-stamp does not fail to help, it **kills a healthy stage**.
`announceableJobs` therefore drops any entry without a version - which is exactly a push (`PushJob` carries
no `payloadVersion`; only `JobRequest` got the DHK-415 field) and any stage from a pre-DHK-415 hub. Pushes
are still ledgered, because their worktrees still need reconciling; they are just never announced.

**Two-state, not three.** The earlier refine answer called for `running` / `interrupted` / `abandoned`, but
the shipped wire frame is `{ jobId, payloadVersion }` with no `status` and no `checkpoint`, so it cannot
express them. This ships what the contract supports: announced = alive in this process, hub adopts; omitted
= not running, the DHK-414 lease lapses and the reaper re-dispatches. Resume-from-checkpoint is deferred -
it needs a checkpoint transport that does not exist on either side yet.

**Not done: killing the orphaned agent subprocess.** The runner is owned by the vendor SDK (`query()` /
`createAgentSession`), which surfaces no pid - cancellation is an in-process `AbortController` - so there is
nothing to signal. In practice the child dies with us (its stdio pipes break), and the dirty-tail reset is
what stops a hypothetical survivor's writes being mistaken for the agent's real output.

**Also stale in the ticket:** point 3's "heartbeat renews the DHK-414 lease" was already shipped hub-side in
DHK-414 (`bridge.ts` calls `store.renewNodeLeases(nodeId, ...)` off the existing heartbeat, keyed on the
socket). It needs no wire field and no node change; the ticket predates that merge.

### Pin the pi SDK to an installable version, DHK-343

- `pi-adapter` loaded `@earendil-works/pi-coding-agent` without the package being a declared dependency,
  and its docstring still described `0.73.1` as "unavailable on npm". Pinned to an exact `0.80.6` in
  `packages/executor-worktree/package.json` and refreshed the lockfile; `pnpm-workspace.yaml` sets
  `allowBuilds: false` for the `@google/genai`/`protobufjs` build scripts the new dependency pulls in, so
  `--frozen-lockfile` stays clean in CI.
- The ticket's premise - that the SDK had removed the model-resolution API - was checked and is false:
  `0.80.6` still exports `resolveCliModel`, so the working resolution path is left untouched. The change is
  a dependency pin plus a corrected docstring, no behaviour change. Three adapter tests added for the
  previously uncovered `runBatch` catch and `summarise` paths (143/143, `tsc` clean).
- **Not verified:** the runtime path against `0.80.6`. The SDK is loaded as `any` and the tests inject
  fakes, so the pin is proven to install and typecheck, not to execute.

### The changelog gate is now self-serviceable

- The `changelog` CI job was the single biggest source of red PRs: four of the last five failures, every
  one resolved by a human hand-pushing the note the author had missed. The harness half of that is already
  fixed - `eca1004` (dahrk-harness #346) added a changelog step to the code-writing stage prompts - but it
  landed at 16:48 UTC on 12 Jul, *after* both #54 (07:39) and #56 (15:51) had already gone red. Those two
  failed with no instruction in play at all.
- What was still missing is what that instruction points at. The prompt says "the README or contributor
  guide says which file takes which kind of change", and no such guide existed: `CLAUDE.md` - the one file
  every stage auto-loads - said nothing about the changelog, and there is no `CONTRIBUTING.md`. The routing
  rule lived only in `README.md` and this file's header.
- The rule now lives in one place, `scripts/check-changelog.mjs`, which `ci.yml` calls instead of
  reimplementing it in inline bash. It is also exposed as `pnpm check:changelog`, and locally it diffs the
  **working tree** (uncommitted and untracked included), so an agent mid-stage - which has not committed
  anything, since the edge node only commits at deliver - sees the real verdict rather than a vacuous pass.
- `CLAUDE.md` now states the rule categorically: a path under `packages/*/src` or `apps/*/src` needs a note,
  full stop, including comment-only and dependency-only edits; an internal note always satisfies the gate;
  omit the PR ref when you cannot know it. The gate's behaviour is unchanged - replayed against PRs #49-#56
  it returns the identical verdict on every one.

## [0.1.13] - 2026-07-12

### Multi-question AskUserQuestion no longer discards questions 2..N, DHK-406 (#54)

- `buildElicitFromQuestions` mapped `questions[0]` and threw the rest away, folding a prose note into the
  prompt asking the agent to "ask the rest later". The agent could not: the tool call had already returned.
  So the questions were not deferred, they were lost, and the stage continued on answers it never got. The
  degrade was designed under DHK-223's D5 philosophy (no denial, no forced retry loop) on the belief that
  the elicit surface could only ever carry one question — which is true of the *surface*, but was never a
  reason to drop the others.
- Replaced by an exported `async askQuestionsSequentially(questions, ask)` that maps each question and
  `await`s `ask` in turn. The router's one-elicit-in-flight rule forbids only *concurrent* asks, and `ask`
  clears `ref.settle` after each reply, so a sequential drain never trips it. One-question batches return
  the bare answer exactly as before; multi-question batches return answers labelled `Q1..QN` so the model
  can tie each reply back to its question.
- **Note for the next reader:** this deletes `buildElicitFromQuestions`, which #49 extracted and pinned
  only one release ago. That test asserted the drop *as correct behaviour* — it was, in the end, the
  reproduction for this bug. A test can pin a defect just as faithfully as a feature; #49's real value was
  making the behaviour visible enough to argue with.
- **Deliberately out of scope:** the second half of the issue title — a later reply falling through to
  `extractGate` and killing the stage. That gate hazard was confirmed **absent from this repo**; it lives
  in `dahrk-harness` and must be fixed there. Nothing in this change addresses it, and DHK-406 should not
  be read as closing it.
- Regression tests: both questions in a batch reach the human, and a "deny"-containing mid-interview reply
  is relayed intact rather than being read as a refusal. Suite 140/140, `tsc` clean.

## [0.1.12] - 2026-07-12

### Fix the flaky replay race that reddened main (#52)

- Tests only, no `src/` change. `main` went red on `build (22)` with the replay test seeing 1 received
  frame where it expected 2. Not fallout from #51: that branch already contained main's tip, so the merged
  tree was byte-identical to the branch head that went green — CI ran the same code twice and disagreed.
  A pre-existing race, first lost on a loaded runner.
- The replay path in `ws-client.ts` sends the cached frame and *then* logs the marker. `send()` only
  queues bytes; the hub's `message` handler pushes onto `inbound` a tick or more later. The test waited on
  the stdout marker and asserted on the hub's frame count — waiting on a *proxy* for the thing it asserts.
  Loopback delivery wins that race on an idle box and loses it on a starved runner.
- Fix: wait on the assertion's own observable (the inbound frame count), assert the markers after. Safe in
  that direction because the marker is written synchronously before the frame can reach the server. The
  `JOB_REPLAY` / `PUSH_REPLAY` assertions are retained, moved from wait-condition to assertion, so the
  tests still pin that the frame came off the replay path rather than a re-run. No sleeps, no tolerances.
  Send-then-log stays: it is the correct order.
- Closed, not won: injecting a 50ms delay into the hub's `message` handler makes the *old* assertions fail
  (reproducing the CI signature in both replay tests) and the new ones pass. Suite stressed 20x under CPU
  contention, 0 failures.

### Brokered runtime auth injection for Claude/Codex adapters, DHK-89 (#51)

- The hub already minted the provider key into `JobRequest.runtimeEnv` (gated on brokered credential-mode)
  and the edge already threaded it onto `RunnerContext` — but only the **Pi** adapter read it. So a
  `claude-code` or `codex` stage on a credential-less node (managed, or containerised) failed to
  authenticate with all the plumbing already in place. This wires the remaining two runtimes.
- `claude-adapter`: `runtimeEnv` becomes the Claude Agent SDK `query()` `env`, spread over `process.env` —
  load-bearing, because the SDK's `env` *replaces* the inherited environment rather than layering onto it,
  so a bare pass-through would strip `PATH`. One exported `runtimeEnvOptions` helper feeds `baseOptions`,
  so batch, interactive and summarise all authenticate.
- `codex-adapter`: `runtimeEnv` as the Codex SDK `env` at the single `new Codex()` site, filtering
  `undefined` values to satisfy the SDK's `Record<string, string>` type.
- Inert on ambient nodes by construction: no `runtimeEnv` means no `env` option, so the SDK keeps the
  operator's ambient login. Self-managed nodes are unchanged. The key rides the child-process env only,
  never the agent's tool surface.
- `claude-runtime-env.test.ts` / `codex-runtime-env.test.ts` pin both helpers (brokered key injected over
  an inherited env; ambient → no `env`).
- **Left open:** the E2E — a credential-less brokered node running a real `claude-code` stage authenticated
  only by the brokered key — has not been run. It needs a pool `runtime-cred` holding a live
  `ANTHROPIC_API_KEY`. Still tracked on DHK-89. Companion hub-side hardening PR landed in `dahrk-harness`.

### Runtime detection: retry, re-probe, and say so, DHK-390 (#50)

- Two independent faults compounded. `probe()` in `detect-runtimes.ts` mapped *every* failure — error,
  non-zero exit, timeout — to "not installed", on a single attempt with a 3s budget. And
  `resolveRuntimes()` ran once in `main.ts` and froze its answer into `EdgeOptions.runtimes`, which every
  `hello` and heartbeat then read for the life of the process. A transient miss was therefore latched:
  conflating "slow" with "absent" is the first bug, never re-asking is what made it permanent.
- The trigger we think we saw: a cold Node-based CLI on a host mid-IO-churn, which is precisely the state
  a node is in in the seconds after `dahrk update` restarts it. Reproduced deterministically — under a
  tight timeout the probe returns `[]`; on a calm host, `['claude-code','codex']`.
- `probeOnce` now distinguishes retryable from definitive: `ENOENT` (not on `PATH`) short-circuits with no
  retry, since waiting cannot conjure a binary; anything else (timeout, spawn hiccup, non-zero exit) is
  retried. Two attempts, 5s each. A CLI that keeps erroring is still, correctly, not advertised — the
  change narrows what counts as absence, it does not paper over a genuinely broken runtime.
- `ws-client.ts` gains the re-probe seam: `currentRuntimes` (mutable, replacing reads of the frozen
  `opts.runtimes`), an extracted `sendHello()`, and an interval (`runtimeRecheckMs`, default 60s,
  `unref`'d) that re-advertises when the detected set changes. Relies on the hub's `handleAdvertise`
  accepting a later `hello` as a re-advertisement. `reprobeRuntimes` is optional, so tests and embedders
  keep the old frozen-set behaviour; `main.ts` wires it to `resolveRuntimes`, which keeps `DAHRK_RUNTIMES`
  authoritative — a pinned override must never re-probe itself into something else.
- Observability, the part the incident actually lacked: `RUNTIMES_DETECTED` at boot, and
  `RUNTIMES_DEGRADED` when a runtime advertised on the *previous* boot is missing now. That diff needs the
  prior set, so `NodeState.runtimes` is persisted in `node.json` (skipped for `--ephemeral`, which has no
  disk). `readState` filters to the known runtime ids, so a hand-edited or future-client value cannot
  smuggle a bogus runtime into the diff.
- Regression test fails on the old single-attempt code: a fake `claude` that times out on the first probe
  and answers on the second. Plus round-trip and validation tests for the persisted set.
- Note for whoever reviews: the run's `reproduce`, `build` and `test` stages each reported "one or more
  tool actions were blocked by a deny-only policy guard" — the new `fs_confine` rule from #47 biting on a
  Dahrk-authored run. Worth a look at what it denied; it did not stop the work, but it is the first
  in-the-wild signal about that rule's false-positive rate.

### Test coverage for the AskUserQuestion degrade path, DHK-344 (#49)

- No behaviour change. DHK-344 itself was already delivered by #25 (`d8f3b5e`) — the
  `AskUserQuestion` → `elicit` wiring across `ask-user-question-tool.ts`, `claude-adapter.ts`,
  `stage-runner.ts` and `ws-client.ts` was fully in place, so the ticket needed no implementation.
  (The PR title says otherwise; it oversells what is really a test extraction.)
- What was actually missing was a test. The multi-question degrade rule — v1 surfaces only the first
  question and folds a note into its prompt rather than denying the call or forcing a retry loop
  (the DHK-223 D5 degrade philosophy) — lived inlined in the tool handler, reachable only through the
  MCP tool, and so was never asserted on directly.
- Extracted it verbatim into a pure `buildElicitFromQuestions` in `ask-user-question-tool.ts` and
  pinned both branches: a single question carries no note, and >1 surfaces only the first question's
  options with the total count named in the prompt.
- Known gap, left out of scope: a question with `multiSelect` set still emits no `console.warn`.

## [0.1.11] - 2026-07-11

### Filesystem confinement, DHK-392 (#47)

- Found in the wild: a stage agent ran a `find` rooted at `/` and scanned the operator's whole Mac,
  mounted network volumes included. Nothing stopped it and nothing could — `shell_guard` is a blocklist
  of seven commands (a root-anchored `find` is not one), `write_scope` only ever inspected the worktree's
  git *branch* and the repo name (a `Write` to `~/.zshrc` passes on an in-scope branch), `Read`/`Grep`/
  `Glob` were in no rule's tool set at all, and the Claude adapter set only `cwd`. The gap was already
  pinned in our own tests: they assert an env-file search and a credential-exfil `curl` *leak* under
  `shell_guard`.
- `fs_confine` (`packages/edge/src/builtins.ts`, `fs-roots.ts`, `shell-scan.ts`) is a path-aware rule, on
  by default whenever a Job has a worktree. Deliberately a **node default, not a workflow policy**: a run
  always has a worktree, so it needs no declaration and ships without a `@dahrk/contracts` release, and it
  fails closed. A future `fs_scope` policy widens the same roots — the shape is already there.
- The load-bearing subtlety: a linked worktree's `.git` is a *file* pointing into
  `~/.dahrk/mirrors/<repo>`, where index, refs and objects actually live. Deny the mirror and *every* git
  command in the worktree fails. Read-only allowances (`/usr`, `/opt`, `/etc/gitconfig`, TLS roots,
  `~/.gitconfig`, the pnpm store) exist for the same reason: deny them and `git commit` and every HTTPS
  call break. `~/.ssh`, `~/.aws`, `~/.gnupg`, keychains and `/Volumes` are denied above every allowance.
- The shell scanner is not a shell parser. It rests on one property: a token can only escape the worktree
  if it is *anchored* outside it (`/`, `~`, `$HOME`, or a `..` that climbs out); everything else resolves
  inside by construction. The work is in not mistaking a **pattern** for a path — which is precisely what
  `find / -path <glob>` is made of.
- Verified against real traffic rather than fixtures: 118 shell commands pulled from three run worktrees,
  each scanned against *its own* run's roots. Two denied, both the whole-disk scan itself; zero false
  positives. That corpus caught a bug fixtures never would have — `2>/dev/null` appears on roughly a third
  of all commands and the first cut denied it as an out-of-worktree write. Pinned as a test.
- Two limits, stated in the public note as well. Codex and Pi expose no pre-tool hook, so a breach is only
  detectable *after* the command ran; there the stage now fails loudly instead of leaving "one or more
  actions were blocked" at the end of a green run. The real fix for those runtimes is containerisation
  (out of scope). And this is a tool-argument guard, not a syscall sandbox: a path assembled inside a
  script and never named in the command is invisible to it. `DAHRK_SANDBOX=1` wires the Claude SDK's
  OS-level sandbox, which does close that, but stays opt-in — the SDK's doc comment ("filesystem
  restrictions come from permission rules, not these sandbox settings") contradicts its own schema, which
  exposes `filesystem.allowWrite`/`denyRead`. Not defaulting on behaviour unproven on a real run.
- Rollout: no running node picks this up by itself (`update-check.ts` only *logs* that an update exists),
  so the operator must `dahrk update` and restart. `DAHRK_FS_CONFINE=0` and `DAHRK_FS_EXTRA_ROOTS` are in
  the README because this fails closed on machines we cannot hot-patch.

## [0.1.10] - 2026-07-11

## [0.1.9] - 2026-07-11

### Observability, ring 0 of DHK-376 (#40)

- The node had **no logging library at all** — ~18 raw `process.stdout.write` calls, no levels, no
  timestamps, no correlation ids, no crash handlers. DHK-360 (half-open sockets), DHK-216 (reconnect
  zombies) and DHK-109 (WS flaps) were all diagnosed the hard way because of it.
- The worst finding: `GitService` has **always** had a `GitLogger` seam with meaningful calls on every
  clone, mirror refresh and worktree create, but **no production call site ever passed one**, so it
  resolved to `noopLogger`. Every git operation on every node ever run was silent. One-line fix.
- `packages/edge/src/logger.ts` — pino, two sinks, no transports (worker threads would break under the
  tsup bundle). stdout keeps the exact line-tagged markers byte-for-byte: `ws-client.test.ts` asserts
  `line.startsWith("JOB_STARTED:")` and the harness greps them to time a kill, so the markers are a
  contract, not laziness. The file sink (`~/.dahrk/logs/node.jsonl`) is always at `debug`.
- `packages/edge/src/redact.ts` — adapted from cyrus's `sentryScrubber` (Apache-2.0, credited in NOTICE),
  applied on pino's single `logMethod` choke point so no call site can forget it. Two additions over the
  original: inline token redaction (it only matched a token as a whole *string*, so
  `fatal: Authentication failed for 'https://ghp_x@github.com/o/r.git'` sailed through — and git errors
  are exactly what we now log), and URL credentials (`https://user:secret@host`).
- Correlation ids come from a per-job child logger bound from the same fields that build `TraceMeta`, so
  `dahrk logs --run <id>` and the hub's `/api/runs/:runId` describe one run from both ends. Reconnects
  log a `connectCount`.
- `apps/edge-node/src/process-safety.ts` mirrors the hub's `installProcessSafetyNet`. Crash records live
  in `logs/crashes/` separately from the log because the log rotates and a crash-loop pushes its own
  first cause out of it.
- Ring 0 is deliberately local-only: no telemetry SDK, no vendor key in an Apache-2.0 binary, no
  log-shipping path. `dahrk diagnose` writes a bundle and has no upload flag.
- Two bugs found while verifying: **EPIPE recursion** (`dahrk start | head` → closed stdout → EPIPE →
  uncaughtException → crash handler logged it *through the same stdout sink* → EPIPE again, writing bogus
  crash records; regression test added), and **Pi's container stderr was piped and never read** — an
  unread pipe fills its ~64 KB buffer and blocks the writer, a latent hang rather than a lost message.
- Follow-ups filed: **DHK-376** (the epic; ring 1 is fleet health over the WS `heartbeat` frame, today an
  empty `{type:"heartbeat"}` and so a free backwards-compatible insertion point, plus a `node_health`
  table and alerting). **DHK-374** (urgent) and **DHK-375**: the live privacy policy claims source code
  "never leaves your machine", which `data-boundary.md` contradicts, and promises a retention mechanism
  that is not built. Both gate any ring-1 telemetry disclosure.
- Docs: `docs/logging.md` here; `dahrk-harness/docs/data-boundary.md` §5 updated to classify the
  node-local log surface as non-crossing.

### Worktree and mirror, DHK-371 (#39)

- Every run was failing at stage start with `fatal: '<branch>' is already used by worktree at ...`. That
  was the visible symptom of three interacting defects, one of which was silently destroying uncommitted
  work.
- **D1, the dangerous one.** `ensureMirror` cloned with `--mirror`, which sets `remote.origin.mirror=true`
  and the refspec `+refs/*:refs/*`, so a fetch force-syncs *local* refs to match origin. Run branches live
  only in `refs/heads/*` until `deliver` pushes them and the forge deletes them again on merge, so origin
  has zero `skakel/issue-*` branches — and every mirror refresh deleted the branch of any run in flight.
  Fixed with a namespace split (`init --bare` + `+refs/heads/*:refs/remotes/origin/*` + `fetch --prune`).
  `git clone --bare` is deliberately not used: it copies remote heads straight into `refs/heads/*`,
  reintroducing the same footgun. `migrateMirrorConfig` converts existing mirrors in place, lazily, on the
  next refresh — no re-clone, no operator step, idempotent. It also unsets `remote.origin.mirror`, which
  would otherwise make any `git push origin` from the mirror a destructive mirror push.
- **D2, 65 GB.** `teardownWorktree` existed but its only caller returned early unless a retention policy
  was configured, and even then consulted an *in-memory* map, so every worktree from a previous process was
  orphaned for ever. One node reached 92 registered worktrees and 65 GB. There is no `run-finished` frame
  in `HubToEdge` (only `job`, `welcome`, `push`, `cancel`, `blob-put-url`), so the edge cannot be *told* a
  run is over and teardown cannot be signal-driven. New `worktree-reaper.ts` reconciles on-disk ∪
  git-registered state, never process-local memory, using `.skakel/scratch/state.json`'s mtime as a durable
  per-run clock and an activity grace to guard a second node process (there is no IPC).
- **D3.** Once D1 deleted the ref, `createWorktree` fell to `git worktree add -b` with no `--force`, and
  `die_if_checked_out` aborted on the stale worktree's dangling symref — while *leaving the branch ref
  re-created*, so the next attempt took the `--force` path and would base the run on the stale run's commit.
  Creation now prunes and evicts stale claims first but fails fast if the holder is a genuinely in-flight
  run (two live runs on one issue is a routing bug; a truthful error beats stomping a live worktree). Start
  point resolves `seedRef` (DHK-264 re-entry) → `origin/<branch>` → `origin/<baseBranch>`; a leftover local
  head is never a start point, which structurally kills the stale-base hazard. `--force -B` is transactional
  with the checkout, and a local tip holding unique commits is parked at `refs/dahrk/salvage/<branch>/<sha>`
  first.
- An `inFlight` leak would have defeated the reaper: it was incremented at job start but decremented only
  inside `finish`, which a throw before it (exactly the D3 failure) skipped, so the run stayed "busy" for
  the life of the process and every reaper pass keyed on `isBusy` skipped precisely the runs that most
  needed collecting. Moved to a `finally` around `runJob`.
- Five git-service regressions and an `inFlight` leak test, each verified to fail on the old code, plus
  five reaper tests including the restart-safety proof. Verified against the live `skakel-harness` mirror:
  it migrated in place, the in-flight run's branch survived, and a subsequent `fetch --prune` — the exact
  command that used to destroy every run branch — left it intact.

### Daemon-first CLI (#38)

- The upgrade hazard, and why it is handled: units written by 0.1.8 invoke **bare `dahrk start`**. Once
  `start` means "ensure running", the daemon's own `start` sees the service running (it *is* the service),
  exits 0, and `KeepAlive` restarts it into the same no-op every 10s — every service-installed node would
  silently stop serving Jobs on upgrade. Two mechanisms cover it: new units are explicit (`--foreground` in
  argv, `DAHRK_SUPERVISED=1` in the env block), and daemon-mode `start` **self-heals** by re-rendering the
  unit and rewriting + reloading it when it differs from disk. The self-heal is only sound because the
  render is deterministic — otherwise "differs → rewrite → reload" is an infinite restart loop, not a
  repair. A test pins exactly that, with a fallback to the foreground worker when there is no cached token
  to re-render with.
- The single-instance lock (`~/.dahrk/node.pid`) exits **non-zero** on refusal. The first cut exited 0,
  which a supervisor reads as a clean exit and restarts into the same refusal; there is now an end-to-end
  regression test.
- The update check fails open by construction: capped at one registry read a day, never prompts without a
  TTY, and a registry that *hangs* is aborted at 1.5s (there is a test for it), so it can never delay or
  fail a start.
- Follow-up: `install.sh` lives in another repo. It should default to an always-on node (`dahrk start` now
  does the install), opt out with `--no-service`, and print `dahrk status` / `logs -f` / `stop` as next
  steps. It pipes into a shell, so its `start` is not a TTY and the update check will never prompt.

## [0.1.8] - 2026-07-11

- Make a release one PR instead of two, and drop the approval gates. `scripts/release.mjs` now accepts
  uncommitted edits confined to the two changelogs and carries them onto the release branch, so notes
  backfilled by the audit land in the same commit as the version bump; previously they had to be
  committed to `main` first, which forced a separate changelog PR (#33 before #34 in 0.1.7). It also
  ignores untracked files, which cannot reach the release commit anyway (`git commit -am` stages only
  tracked paths) but used to fail preflight. `/dahrk-release` now runs straight through to the PR and
  asks nothing, halting only on a real blocker (failed preflight, a `@dahrk/*` dep that is unpublished
  or ships `src`, a failed smoke). It never merges: the PR is the review surface and the merge is the
  publish trigger.

- Protect `main`. It had no protection at all, so nothing stopped a red PR being merged — and since the
  merge is what tags and publishes, that meant a broken release could reach npm, which is unfixable
  (a version can never be reused). `build (22)`, `build (24)` and `changelog` are now required checks,
  with force-pushes and deletion blocked. Admins are not bound, so a solo maintainer can still merge
  their own release PR without a second reviewer. Also created the `no-changelog` label that `ci.yml`
  has always tested for but which did not exist, leaving the documented escape hatch unusable.

- Persist the enrolment token. New `apps/edge-node/src/state.ts` owns `~/.dahrk/node.json` (it was an
  inline read/write of `{nodeId}` in `main.ts`): a merging `writeState` so persisting a token cannot
  drop the id, `0600`/`0700` modes with an explicit `chmod` on write (`writeFileSync`'s `mode` only
  applies on create, so a pre-existing `0644` file from an older client is tightened the first time we
  write a token into it), and a corrupt file reading as empty state.
- Token resolution is now flag -> `DAHRK_ENROL_TOKEN` -> cached, shared by `start` / `doctor` / `run` /
  `service install`. `buildEdgeOptions` stays pure over env: `start` resolves the token and sets
  `DAHRK_ENROL_TOKEN` on its env copy before building the options.
- The cache is written from a new `EdgeOptions.onEnrolled` hook fired by the `welcome` handler in
  `ws-client.ts`, not at dial time, so only a hub-accepted token is ever persisted. It is wrapped in a
  try/catch: a disk failure logs `EDGE_ENROL_PERSIST_FAILED` and must never take down a healthy node.
  Persisting is a no-op when the token already on disk matches, so the reconnect loop does no IO.
- Sound because the token is a reusable pool-join token, not one-shot: the wire contract requires
  `enrolToken` on every `hello`, and the client already re-sent the same one on every reconnect.
- `onEnrolled` also carries the `welcome`'s `name` / `tenantId`, cached into `node.json` so `status` can
  name the node offline. The no-op-if-unchanged guard now spans all three fields, so the reconnect loop
  still does no IO in the steady state.
- `service.ts`: unit files are written `0600` + explicit `chmod` (same create-only-`mode` trap as
  `node.json`). The unit's env block carries the token, so the module's "never leaks through `ps`"
  claim was true of argv and false of the file it wrote.
- `service.ts`: new `stableNodeBin`. `process.execPath` resolves symlinks, so a Homebrew Node reports its
  versioned Cellar path; `brew upgrade node` then deletes the binary the unit execs, and launchd's
  `KeepAlive` + `ThrottleInterval: 10` crash-loops it silently forever. We now map `.../Cellar/<formula>/
  <version>/bin/node` to `.../opt/<formula>/bin/node`, but only when that alias CURRENTLY realpaths to the
  same binary - a stale symlink is never trusted. nvm / system layouts have no alias and pass through.
- New `status.ts` (+ `unitPath` / `statusCommand` / `parseServiceStatus` in `service.ts`): a local report,
  pure renderer + injected IO, no network by design. Exits 1 only on installed-but-not-running. Reports
  `envToken` separately from the cached token, so a node whose token comes from the unit's env block (or a
  pre-cache client) does not read as "not enrolled". The token is never printed, not even a prefix.

## [0.1.7] - 2026-07-11

- Default an interactive stage's exit to `either` rather than `gate` in all three runtime adapters
  (claude / codex / pi). With `gate`, `wantsTool` is false so the stage-complete tool is never
  offered, leaving the hub's allow-keyword scan as the only `ok` path. (DHK-363, #31)

- Harden the release process after the 0.1.5 incident: `scripts/smoke-pack.sh` packs the client,
  installs the tarball into a clean tree and runs `dahrk version` (wired into `ci.yml` and as the
  last gate before publish in `release.yml`); the build matrix now covers Node 22 and 24;
  `scripts/lint-changelog.mjs` rejects internal tracker keys; and a PR gate requires a changelog
  note for changes under `packages/*/src` or `apps/*/src` (escape: the `no-changelog` label). (#29)

- Backfill the 0.1.5 notes and correct the 0.1.4 section: `dahrk service install` was misfiled under
  0.1.4, and the read-only policy, worktree-base advertisement and interactive elicitation were
  undocumented. (#28)

- Introduce this internal changelog and the split-changelog convention. `pnpm release` now rolls both
  files; CI's "changelog entry required" gate accepts a note in either file; the public changelog lint
  and GitHub-release extraction stay scoped to `CHANGELOG.md`. (#32)

