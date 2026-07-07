# Changelog

All notable changes to the `dahrk-node` edge client are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2]

- Add `pnpm release`: AI-drafted changelog + PR + auto-tag publish (#8)
Replace the manual release prep (hand-edit CHANGELOG, bump version, tag,
push) with one command, `pnpm release <version>`:

- scripts/release.mjs: preflight guards (clean tree, on main, tag free, gh
  authed) -> branch release/x.y.z -> resolve the changelog section
  (hand-written [Unreleased] wins; otherwise draft from `git log` via
  claude-opus-4-8, with a graceful fallback to the raw commit list) -> bump
  apps/edge-node + root package.json -> rewrite CHANGELOG (fresh [Unreleased],
  new [x.y.z], repointed compare links) -> commit, push, open a "Release
  x.y.z" PR with the section as the body. Flags: --dry-run, --ai-polish,
  --no-ai. Rewrites done in JS, no `sed -i` portability trap.
- tag-release.yml: on merge to main, push the vX.Y.Z tag (via RELEASE_PAT, so
  the default GITHUB_TOKEN doesn't suppress the tag-driven publish) to trigger
  the existing release.yml. No-ops safely if the tag exists or the PAT is
  unset.
- Add @anthropic-ai/sdk devDependency + the `release` script; document
  RELEASE_PAT / ANTHROPIC_API_KEY in the README and release.yml header.

The AI-drafted text is one reviewed source that flows CHANGELOG section -> PR
body -> GitHub Release notes.

Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
- Edge: implement mode:"backup" push in runPush (companion to DHK-264 work preservation) (#7)
- plan: Added a merge-free `backupPush` to `GitService` (git-service.ts) and `mode:"backup"` routing plus a retention/in-flight worktree-survival guard to `runPush` (stage-runner.ts) that force-pushes the run
- build: Verified the complete DHK-284 edge implementation: a merge-free `backupPush` in `git-service.ts` (force-pushes HEAD to `dahrk/wip/<runId>` with no base merge or PR), `mode:"backup"` routing in `runPus
- test: All four scope items are implemented and green: `backupPush` (merge-free force-push to `dahrk/wip/<runId>`) added to `packages/executor-worktree/src/git-service.ts`, `mode:"backup"` routing added to `
- simplify: Verified DHK-284 is fully implemented — `GitService.backupPush` (git-service.ts) force-pushes HEAD to `dahrk/wip/<runId>` with no base merge or PR, `runPush` (stage-runner.ts) routes `mode:"backup"` t
- review: Verified the DHK-284 edge implementation is complete and green: `git-service.ts` has a merge-free `backupPush()`, `stage-runner.ts` `runPush` routes `mode:"backup"` to it (returning `PushResult.wipRef

Co-authored-by: Dahrk <noreply@dahrk.ai>
- fix(executor-worktree): stop masking push-integration merge failures (#6)
Run run-a3361b8b (DHK-256) failed at deliver with an opaque
`push failed: Command failed: git merge --abort` /
`fatal: There is no merge to abort (MERGE_HEAD missing)`.

Root cause: the push-time base merge hit "refusing to merge unrelated
histories" and failed WITHOUT starting a merge (no MERGE_HEAD), but the
conflict-recovery catch ran `git merge --abort` unconditionally. That abort
threw ("no merge to abort") and masked the real error, destroying the
diagnostic evidence.

- Distinguish a content conflict (MERGE_HEAD present -> abort + `conflict`)
  from a merge that never started (no MERGE_HEAD): classify unrelated/diverged
  histories as a new `diverged` outcome, and re-throw any other merge-start
  failure truthfully instead of masking it.
- Add a merge-base short-circuit before the merge, and a fail-fast guard in
  createWorktree so a run never proceeds on an unborn HEAD.
- stage-runner forwards `diverged` as a truthful failure (forward-compat note
  for when @dahrk/contracts ships the wire value).
- Regression test: unrelated histories now report `diverged`, push nothing,
  leave no half-merge, and never throw the masked abort error.

Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

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

[Unreleased]: https://github.com/dahrkai/dahrk-node/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/dahrkai/dahrk-node/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/dahrkai/dahrk-node/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dahrkai/dahrk-node/releases/tag/v0.1.0
