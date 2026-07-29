# dahrk-node

The installable **Dahrk** edge client. Install it, run it with an enrolment token, and it becomes a
self-managed **node** that executes Dahrk workflow stages in an isolated git worktree. It dials OUT to
the hub over WebSocket (no inbound ports), works out which agent runtimes (Claude Code, Pi) it can
serve, and streams progress and results back.

The npm package is `dahrk-node`; the command it installs is `dahrk`.

## Install

Needs **Node 22+** and a way to authenticate stages: a logged-in `claude` on this host, a provider key
in the environment, or enrolment into a brokered pool (which needs neither). The agent runtimes
themselves ship inside the client - there is nothing else to install. Run `dahrk doctor` to check.

```bash
npm install -g dahrk-node                          # npm
brew install dahrkai/tap/dahrk                     # Homebrew
curl -fsSL https://dahrk.ai/install.sh | sh        # curl
```

## Use

```bash
dahrk --token <enrolment-token>                    # connect a node
dahrk --version
dahrk --help
```

Get an enrolment token from [app.dahrk.ai](https://app.dahrk.ai). The node mints and persists a stable
id under `~/.dahrk/node.json`. Configuration is via flags or `DAHRK_*` env vars (`--hub-url` /
`DAHRK_HUB_URL`, `--name` / `DAHRK_NODE_NAME`, `DAHRK_RUNTIMES`, and more) - see the
[repository README](https://github.com/dahrkai/dahrk-node#configuration) for the full reference.

## Licence

Apache-2.0. Copyright Skakel Labs.
