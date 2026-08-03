# ADR 0001 - A node reads no credentials from the machine it runs on

**Confidentiality:** Public
**Status:** DRAFT - UNREVIEWED

## Context

A node used to be able to authenticate with whatever the host already had. Git went out over your SSH
key or your `gh` login, pull requests were opened with your `gh` session, and a Claude stage borrowed the
login in your macOS Keychain or `~/.claude/.credentials.json`. It was appealing: nothing had to be handed
to the hub, and a developer with a Claude subscription could point a node at their own machine and have
it work immediately.

What it produced in practice was a node whose capabilities depended on state nobody could see or check.

- **Which shell started it mattered.** `dahrk start` installs a launchd agent or systemd user unit, and
  the unit captures the invoking shell's `PATH`. A node started from one terminal could see a `claude`
  binary that a node started from another could not, and the difference showed up only as jobs that were
  never routed to it.
- **Two credential stores could disagree.** On macOS the Claude login lives in both the Keychain and a
  file. Refreshing rotates one; a per-item Keychain ACL could let `claude` read an item while `security`
  could not. A node under launchd could therefore read a revoked copy and fail every stage with
  `401 OAuth access token has been revoked`, while the same login worked perfectly from a terminal.
- **Nothing local changed when a credential died.** A token revoked at the provider, or an account that
  hit a spend cap, left every local signal intact. The node kept advertising a runtime it could no longer
  authenticate, and each job it accepted burned a run at $0.00 with an error that read like the agent's
  fault.
- **A credential could not be verified from the other end.** Neither you nor the hub could answer "will
  this node's next stage authenticate?" without running one.

Every one of those is the same shape: an invisible dependency on the host, discovered only by failure.

## Decision

**A node authenticates only with the credentials the hub attaches to a job.** It does not read the host's
SSH key, `gh` login, `claude` login, macOS Keychain, `~/.claude/.credentials.json`, or provider
environment variables, and there is no mode or flag that re-enables any of that.

Concretely: git authenticates with a short-lived, repository-scoped token supplied per job and presented
over HTTPS through a `GIT_ASKPASS` shim that keeps it out of argv and `git config`; pull requests are
opened by the hub, not by the node; and inference authenticates on the credential configured for the
node's pool. Your own credentials are not merely un-transmitted - they take no part in a run at all.

**Runtime advertisement therefore asks one question: can this process execute the runtime?** That is
whether the runtime's SDK resolves, which has nothing to do with `PATH` - the agent runtimes run from
SDKs bundled with the client, never from a CLI on your machine.

The single credential signal that survives is a credential the provider has **refused**. That is not a
guess about the host: it is the runtime having tried to authenticate and been told no. A refusal
withdraws that runtime from the node's advertisement until a later stage authenticates successfully, so
a node stops accepting work it has just proved it cannot do.

## Consequences

- **The host contract is small and checkable**: Node 22+, `git`, and a writable worktree directory with
  disk. `dahrk doctor` no longer warns about a missing SSH key, `gh`, or `claude` login, because none of
  them is consulted when a stage runs and warning about them pointed at the wrong thing.
- **What a node can serve no longer depends on how it was started.** The service still records a `PATH`,
  but only so the daemon can find `git`.
- **A node in a container is not a special case.** It has no host logins to inherit, which used to make it
  the awkward profile; it is now simply a node.
- **Your machine is a smaller target.** A stage's agent runs with no path to your personal GitHub or
  Anthropic credentials, because they were never made available to the process in the first place.
- **`DAHRK_CREDENTIAL_MODE` is removed**, along with the `ambient` concept it selected. A node that cannot
  be credentialled by the hub does not start work; it does not quietly fall back to yours.

## Sources

- Behaviour: `packages/edge/src/detect-runtimes.ts` (capability probe),
  `packages/edge/src/credential-latch.ts` (the refusal signal),
  `packages/executor-worktree/src/git-service.ts` (the askpass shim).
- Released in `dahrk-node` 0.2.0; see `CHANGELOG.md`.
- The hub-side counterpart to this decision is recorded in the harness repository.
