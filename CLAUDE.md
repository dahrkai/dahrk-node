# dahrk-node

The open-source **Dahrk** edge client: the installable software (`dahrk-node`) that, once run and
enrolled with the hub, becomes a **node** and executes workflow stages in a git worktree. Apache-2.0,
copyright Skakel Labs.

## Dahrk brand & naming (canonical: github.com/dahrkai/dahrk-hq)

Naming conventions for this repo (summary; the source of truth is `dahrk-hq`):

- **Entity model.** Product and agent = **Dahrk** / **@Dahrk**, a product of **Skakel Labs**. Product
  repos live under `github.com/dahrkai`.
- **Naming conventions.** npm `@dahrk/<x>` (one scope). Env vars `DAHRK_<AREA>_<NAME>`; there is no
  `SKAKEL_*` alias, and no `~/.skakel`. Dotdir `.dahrk/`. Binary `dahrk-node`. Architecture
  words (Hub, Edge, Node, Engine, Run, Stage, Workflow, Broker) are concepts; do not brand them.
- **Domains.** `dahrk.ai` is canonical (docs at `dahrk.ai/docs`). The hub endpoint this client dials
  is **`api.dahrk.ai`**: use the `api` surface name in client config (`DAHRK_API_URL`,
  `DEFAULT_API_URL`, `wss://api.dahrk.ai`), not `hub`.
- **Nodes.** Client = the installable (this repo); Node = an enrolled running worker. **Managed** node
  (Dahrk-run) vs **self-managed** node (user-run: local machine, Docker, their cloud). Never say
  "unmanaged".
- **Credentials.** Every credential is **brokered**: the hub mints a short-lived, repo-scoped git token
  from the GitHub App, opens pull requests itself through that App, and hands the node an inference
  credential per stage from the AuthProfile the run resolves - the stage's own, else the account default.
  There is no ambient mode; a node never
  reads the host's SSH key, `gh` login, `claude` login, Keychain, or provider env vars.
- **Voice.** British English, no em dashes. Amber `#f5a524` is the only brand accent.

## Contributing: every source change needs a changelog note

**If your diff touches `packages/*/src/` or `apps/*/src/`, you must add a changelog note, or CI fails
the PR.** This is not a judgement call. The gate matches on the *path*, so a comment-only edit, a
dependency bump, or a type-only change under `src/` all need a note just as much as a new feature.
"No behavioural change, so no note" is the reasoning that reddens this repo most often; it is wrong.

Add the entry under the `[Unreleased]` heading of exactly one of:

- **`CHANGELOG.md`** for a change a self-hoster would notice (behaviour, flag, fix). British English,
  no em dashes, under `### Added` / `### Changed` / `### Fixed`. **Never** put an internal tracker key
  (`DHK-…`) in this file - `pnpm lint:changelog` rejects it.
- **`CHANGELOG.internal.md`** for anything else: refactor, dependency plumbing, test, tooling,
  comment-only edit. Tracker keys are welcome here. This always satisfies the gate, so when in doubt
  it is the right answer - an internal note beats no note.

### A public note is one sentence

**One sentence per bullet, 25 words maximum.** `pnpm lint:changelog` fails the build above 25, so
this is a hard limit, not a preference. Write the new behaviour in the present tense and stop:

- **No bold lead-in.** A bolded claim reads as a headline, and a headline invites the paragraph that
  used to follow it. Just write the sentence.
- **Leave out the mechanism.** Not what used to happen, not the root cause, not why it was wrong, not
  how it was fixed. A reader who wants that follows `(#N)` to the pull request.
- **One bullet per distinct change.** Do not merge two unrelated fixes to stay under the limit, and
  do not split one fix into three to sound busier.
- **If it will not fit, you are explaining.** A user-visible change can always be stated in a
  sentence; 25 words is generous for one. Length is the symptom, explanation is the cause.

The detail is not lost - it belongs in `CHANGELOG.internal.md`, which is never published. Put the
mechanism, the root cause and the before/after narrative there, at whatever length is useful.

Before, as this file used to be written (105 words):

> - **The `repo-fetch` health check could never pass on a node using brokered credentials.** It ran a
>   bare `git fetch` as an ordinary check command, and a check command deliberately does not carry the
>   repo's git credential: the node holds that token only for the life of its own git operations. So
>   the fetch fell through to a password prompt and, with no terminal attached, died as `could not
>   read Password... Device not configured` on every run. […] (#174)

After (13 words):

> - The `repo-fetch` health check now passes on nodes using brokered credentials. (#174)

Public entries cite the GitHub PR as `(#N)`. **If you do not know the PR number, leave the reference
out** rather than inventing one; the release audit backfills it. (Your commit is created before the
PR is opened, so during a workflow stage you cannot know N. That is expected.)

**Before you finish, run `pnpm check:changelog`.** It is the same check CI runs, it sees your
uncommitted work, and it tells you exactly what is missing. A red `changelog` job is always
preventable.

## Agent skills

### Issue tracker

Issues live in Linear (`skakel` workspace, Dahrk / DHK team), filed via the `capture-issue`
skill. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
