# dahrk-node

The open-source **Dahrk** edge client: the installable software (`dahrk-node`) that, once run and
enrolled with the hub, becomes a **node** and executes workflow stages in a git worktree. Apache-2.0,
copyright Skakel Labs.

## Dahrk brand & naming (canonical: github.com/dahrkai/dahrk-hq)

Naming conventions for this repo (summary; the source of truth is `dahrk-hq`):

- **Entity model.** Product and agent = **Dahrk** / **@Dahrk**, a product of **Skakel Labs**. Product
  repos live under `github.com/dahrkai`.
- **Naming conventions.** npm `@dahrk/<x>` (one scope). Env vars `DAHRK_<AREA>_<NAME>` (legacy
  `SKAKEL_*` read as an alias during migration). Dotdir `.dahrk/`. Binary `dahrk-node`. Architecture
  words (Hub, Edge, Node, Engine, Run, Stage, Workflow, Broker) are concepts; do not brand them.
- **Domains.** `dahrk.ai` is canonical (docs at `dahrk.ai/docs`). The hub endpoint this client dials
  is **`api.dahrk.ai`**: use the `api` surface name in client config (`DAHRK_API_URL`,
  `DEFAULT_API_URL`, `wss://api.dahrk.ai`), not `hub`.
- **Nodes.** Client = the installable (this repo); Node = an enrolled running worker. **Managed** node
  (Dahrk-run) vs **self-managed** node (user-run: local machine, Docker, their cloud). Never say
  "unmanaged".
- **Credentials.** Self-managed nodes default to **ambient credentials** (git config, `gh`, SSH agent;
  no secrets through Dahrk). **Brokered credentials** (via the Broker) enable containers and CI.
- **Voice.** British English, no em dashes. Amber `#f5a524` is the only brand accent.
