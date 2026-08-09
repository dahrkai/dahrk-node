/**
 * The confinement scanner's own test surface (DHK-392).
 *
 * `test/fs-confine.test.ts` drives this same code through `buildRules` + `computeFsRoots` against a
 * real worktree - the integration pact, and it should stay that way. But `scanCommand` is already a
 * function of (command, roots, cwd), so a case costs nothing here: no `git init`, no `mkdtemp`, no
 * worktree under `$HOME`. That is what lets this file carry a corpus rather than a handful of
 * examples.
 *
 * Both defects this guard has shipped were false verdicts at exactly this interface:
 *   - DHK-998: a raw `\n` was swallowed as whitespace, so `echo hi\ncat <outside>` scanned as ONE
 *     segment whose argv0 (`echo`) takes no path operands - a silent worktree ESCAPE.
 *   - DHK-999: a `#` comment was lexed as live shell, so an apostrophe or a path inside one denied an
 *     innocent command - a false DENY.
 * They are the two failure modes, and they are not equal: a false deny is noise an operator can see,
 * a false allow is the escape this module exists to prevent. The `ESCAPES` table is therefore the one
 * that earns the coverage, and every case added to it should be an anchored path that resolves
 * outside every root.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { computeFsRoots, realish, type FsRoots } from "../src/fs-roots.js";
import { scanCommand } from "../src/shell-scan.js";

/**
 * A synthetic root set with the same SHAPE `computeFsRoots` produces, minus the machine probing.
 *
 * The worktree is nested as production nests it (`<state>/worktrees/<runId>/<repo>`), because DEPTH is
 * load-bearing: from a worktree one level below `/`, `cat ../../etc/passwd` resolves to `/etc/passwd`
 * and is a legitimate toolchain read, so a shallow fixture would quietly assert the wrong thing. It
 * sits under neither `$HOME` (whose config paths are readable) nor tmp (itself an rw root, which
 * would make `cd ..` legal). `realish` on a path that does not exist walks up to `/` and hands the
 * spelling back unchanged, so nothing here has to be created on disk.
 *
 * The `~`-derived roots use the REAL `homedir()` because `expandPath` does - a test that invented a
 * home would not exercise the deny list at all. `driftGuard` below pins this shape to production.
 */
const RUN_DIR = "/dahrk-test-wt/worktrees/run-1";
const WT = realish(join(RUN_DIR, "primary-repo"));
/** A second repo of the same run (DHK-251): a writable root, one level up and across. */
const SIBLING = realish(join(RUN_DIR, "other-repo"));
/** The run directory itself is deliberately NOT a root: it holds every repo plus the engine's
 *  scratch, so making it writable would hand the agent the lot as one tree. `cd ..` must deny. */
const SCRATCH = realish(join(RUN_DIR, ".dahrk", "scratch"));
/** Anchored outside every root: the canonical escape target for this file. */
const OUT = "/dahrk-test-outside";

const roots = (): FsRoots => ({
  rw: [
    WT,
    SIBLING,
    SCRATCH,
    ...[tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map(realish),
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/tty",
    "/dev/fd",
  ],
  ro: ["/usr", "/bin", "/sbin", "/etc", "/opt", "/Library", "/System", join(homedir(), ".gitconfig"), join(homedir(), ".config"), join(homedir(), ".cache")].map(
    realish,
  ),
  deny: [join(homedir(), ".ssh"), join(homedir(), ".aws"), join(homedir(), ".gnupg"), join(homedir(), "Library", "Keychains"), "/Volumes", "/etc/shadow", "/etc/sudoers"],
  cwd: WT,
});

const scan = (cmd: string) => scanCommand(cmd, roots());

// ── The escapes. A regression here is a stage reading or writing the operator's machine. ──────────

const ESCAPES: Array<[string, string]> = [
  // The original report (DHK-392): a whole-filesystem scan.
  ["find / -path '*/@dahrk/contracts/*job*'", "the root is the escape, the glob is innocent"],
  ["ls /", "the filesystem root is under no rw or ro root"],

  // Plain anchored operands.
  [`cat ${OUT}/secret.md`, "absolute read outside every root"],
  [`rm -rf ${OUT}`, "WRITE_ALL: every operand is a write"],
  [`cp inside.txt ${OUT}/copy`, "WRITE_LAST: the destination is the escape"],
  [`mv ${OUT}/a ${OUT}/b`, "WRITE_LAST: the source is still read-checked"],
  [`cat "${OUT}/secret.md"`, "a quoted path is still a path"],
  [`grep -r password ${OUT}`, "PATTERN_FIRST consumes the regex, not the root"],

  // Climbing out, and the home anchors.
  ["cd .. && ls", "`..` from the worktree lands outside it"],
  ["cat ../../etc/passwd", "a climbing relative path"],
  ["cat ./sub/../../escape", "`/../` mid-path climbs out"],
  ["cat ~/.ssh/id_ed25519", "deny beats ro"],
  ["cat $HOME/.ssh/id_ed25519", "`$HOME` is expanded, not treated as opaque"],
  ["cat ${HOME}/.ssh/id_ed25519", "braced `${HOME}` too"],
  ["cat /etc/shadow", "deny beats ro on a readable root"],
  ["ls /Volumes", "a mounted volume is denied outright"],

  // Read is granted on `ro`; write is not.
  [`echo pwned > /etc/foo`, "ro grants reads only, so a redirect write escapes"],
  [`echo pwned > ${OUT}/x`, "a redirect target is checked regardless of argv0"],
  [`cat < ${OUT}/x`, "an input redirect is a read of the target"],
  [`pnpm build >> ${OUT}/log`, "append is a write"],
  [`pnpm build 2> ${OUT}/err`, "stderr redirect is a write"],

  // Wrappers: the command they carry is the command.
  [`sh -c 'cat ${OUT}/x'`, "a shell operand is recursed into"],
  [`bash -c "find / -name x"`, "double-quoted shell operand too"],
  [`sudo cat ${OUT}/x`, "sudo is a wrapper, not the command"],
  [`env FOO=1 cat ${OUT}/x`, "env is a wrapper"],
  [`xargs cat ${OUT}/x`, "xargs is a wrapper"],
  [`cat $(cat ${OUT}/x)`, "a `$(...)` body is scanned in its own right"],
  [`cat \`cat ${OUT}/x\``, "a backtick body too"],
  [`sh -c 'sh -c "cat ${OUT}/x"'`, "nested wrappers recurse"],

  // Flags whose operand is always a path.
  [`git -C ${OUT} status`, "DIR_FLAGS: a directory even when it looks like a flag operand"],
  [`git --git-dir ${OUT}/.git log`, "--git-dir is a path"],

  // Segmentation: every separator must split, so a benign argv0 cannot cover the rest (DHK-998).
  ...(["echo hi", "printf hi", ":", "true", "false"] as const).flatMap((argv0) =>
    ([";", "\n", "&&", "||", "|", "&"] as const).map(
      (sep): [string, string] => [`${argv0} ${sep} cat ${OUT}/x`, `\`${sep === "\n" ? "\\n" : sep}\` splits the segment (DHK-998)`],
    ),
  ),
  [`echo hi # a comment\ncat ${OUT}/x`, "a comment stops AT the newline, which still splits (DHK-998/999)"],
  [`cd /tmp\ncat ${OUT}/x`, "a `cd` on its own line does not hide the next line"],

  // `cd` rebinds the cwd for the rest of the command, and the rebound cwd is still confined.
  [`cd ${OUT} && ls`, "the cd target itself is checked"],
  ["cd /tmp && cat ../../etc/shadow", "the rest is judged from where the shell now stands"],
];

test("commands that reach outside the roots are escapes", () => {
  for (const [cmd, why] of ESCAPES) {
    const out = scan(cmd);
    assert.equal(out.kind, "escape", `expected escape (${why}): ${JSON.stringify(cmd)}`);
  }
});

test("an escape reports the offending path and the access it needed", () => {
  const read = scan(`cat ${OUT}/secret.md`);
  assert.deepEqual(read, { kind: "escape", path: `${OUT}/secret.md`, need: "read" });

  const write = scan(`rm -rf ${OUT}/build`);
  assert.deepEqual(write, { kind: "escape", path: `${OUT}/build`, need: "write" });

  // The destination of a WRITE_LAST command is the write; the source is a read.
  assert.equal(scan(`cp ${OUT}/a ${OUT}/b`).kind, "escape");
  const dest = scan(`cp inside.txt ${OUT}/b`);
  assert.deepEqual(dest, { kind: "escape", path: `${OUT}/b`, need: "write" });
});

/**
 * An anchored path containing a space is still a path (DHK-1019). `looksLikePath` used to reject any
 * token carrying whitespace as prose (`git commit -m "/usr is broken"`), which ran after tokenising,
 * so a quoted or backslash-escaped path was indistinguishable from a sentence by that rule alone -
 * even though `Token.quoted` was introduced to keep the two facts apart. Every case below is a real
 * read or write outside every root, and each must now be an escape.
 *
 * The anchor is authoritative: whitespace no longer outranks it. The one whitespace-prose shape that
 * motivated the old rule (`git commit -m "…"`) is covered upstream by PATTERN_FLAGS skipping `-m`'s
 * operand, so the guard against a false deny lives in the ALLOWED table below, not here.
 */
test("an anchored path containing a space escapes confinement", () => {
  for (const cmd of [
    String.raw`cat /dahrk-test-outside/a\ b`,
    `cat "${OUT}/my notes.md"`,
    `cat '${OUT}/my notes.md'`,
    `rm -rf "${OUT}/build dir"`,
    `cp inside.txt "${OUT}/copy here.md"`,
    `cat "${join(homedir(), "Library", "Application Support", "secrets")}"`,
  ]) {
    assert.equal(scan(cmd).kind, "escape", `expected escape: ${JSON.stringify(cmd)}`);
  }
});

// ── The ordinary commands a build stage runs all day. A regression here is noise, not a breach. ───

const ALLOWED: Array<[string, string]> = [
  // Everyday build traffic.
  ["pnpm test", "a bare command name resolves inside the worktree"],
  ["pnpm -r build", "flags are not operands"],
  ["git status", ""],
  ["git push origin HEAD", "a branch is not a path"],
  ["node --version", ""],
  ["cat package.json", "a relative path resolves from the worktree"],
  ["ls node_modules/@dahrk/contracts", ""],
  ["rm -rf node_modules", "a write inside the worktree"],
  ["mkdir -p dist/nested", ""],
  ["cd packages/edge && pnpm test", "a cd that stays inside"],
  ["pnpm build 2>/dev/null", "/dev/null is an rw sink"],
  ["pnpm build > /dev/stdout", ""],
  ["git rev-parse --show-toplevel", ""],
  ["cat .dahrk/scratch/state.json", "the scratch dir is rw"],

  // Reads the toolchain legitimately needs.
  ["cat /etc/hosts", "ro grants reads"],
  ["cat ~/.gitconfig", "the git identity a commit needs"],
  ["/usr/bin/env node -e 'console.log(1)'", "an absolute argv0 is an execution under ro"],

  // Patterns that merely look like paths.
  ["rg -e '/api/v1' src/", "PATTERN_FLAGS: the operand is a regex"],
  ["rg '/api/v1' src/", "PATTERN_FIRST: the first operand is the regex"],
  ["grep -r TODO packages/", ""],
  ["find . -name '*.ts' -print0", "a -name glob is a pattern"],
  ["find . -path '*/dist/*' -delete", ""],
  ["sed -n '/^\\/usr/p' file.txt", "a sed script is a pattern"],
  ["git log --grep '/etc/passwd'", "--grep is not a path flag, and the operand carries no anchor"],

  // Prose, URLs and opaque expansions.
  ['git commit -m "fix: /usr/local was the problem"', "a path inside a commit message is prose"],
  ['git commit -m "/usr is broken"', "an anchored path with spaces in a PATTERN_FLAGS operand is still prose (DHK-1019)"],
  [`git commit -m "don't touch /etc"`, "an apostrophe inside prose"],
  ["curl -s https://registry.npmjs.org/@dahrk/contracts", "a URL is not a path"],
  ["echo $HOME", "echo prints, it does not open"],
  ["printf '%s\\n' /etc/passwd", "printf prints, it does not open"],
  ['test -f "$SOME_VAR"', "an opaque variable: the shell knows, we do not"],
  ["cd $(git rev-parse --show-toplevel)", "a substitution leaves an opaque token, not a path"],

  // Comments are DATA, not shell code (DHK-999).
  ["ls # /etc/passwd is not touched here", "a path inside a comment"],
  ["ls # don't touch anything", "an apostrophe inside a comment must not open a quote"],
  ["ls # see `uname -a` and $(whoami)", "a backtick and a `$(` inside a comment are inert"],
  ["pnpm test  # ../../escape", "a climbing path inside a comment"],
  ["#!/usr/bin/env bash\npnpm test", "a shebang line is a comment"],
  ["ls foo#bar", "a `#` mid-word is not a comment"],
  ["git log --pretty=%h#x", "nor is one inside a flag value"],

  // Heredoc bodies are DATA too (DHK-394).
  ["cat <<'EOF'\n/etc/passwd\n../../escape\nEOF", "a quoted heredoc body is never path-scanned"],
  ["cat <<EOF\nimport x from '../../y'\nEOF", "an unquoted body either"],
  ["cat <<-EOF\n\t/etc/shadow\n\tEOF", "`<<-` allows a tab-indented terminator"],
  ["cat <<EOF\nbody\nEOF\ngit status", "lexing resumes after the terminator"],
  ["grep foo <<< 'inline /etc/passwd data'", "a here-string is data, not a path"],

  // The cwd threads through a `cd`, so a later relative path is judged from where the shell stands.
  ["cd packages && cat edge/package.json", "relative after a cd, still inside (DHK-394)"],
  ["cd /tmp && rm -rf junk", "tmp is an rw root, so work there is legal"],
];

test("the ordinary commands a build stage runs are not mistaken for escapes", () => {
  for (const [cmd, why] of ALLOWED) {
    const out = scan(cmd);
    assert.equal(out.kind, "ok", `expected ok${why ? ` (${why})` : ""}: ${JSON.stringify(cmd)}`);
  }
});

// ── Fail closed. A command we cannot lex is denied; it would fail in the shell anyway. ────────────

const UNPARSEABLE: Array<[string, string]> = [
  ['cat "unbalanced', "an unbalanced double quote"],
  ["cat 'unbalanced", "an unbalanced single quote"],
  ["cat $(echo unterminated", "an unterminated substitution"],
  ["cat `echo unterminated", "an unterminated backtick"],
  ["cat <<EOF\nbody that never ends", "a heredoc whose terminator never arrives"],
  ["cat <<", "a heredoc operator with no delimiter"],
  ["cat <<'EOF\nbody\nEOF", "an unterminated quote in the delimiter word"],
];

test("a command that cannot be lexed fails closed", () => {
  for (const [cmd, why] of UNPARSEABLE) {
    const out = scan(cmd);
    assert.equal(out.kind, "unparseable", `expected unparseable (${why}): ${JSON.stringify(cmd)}`);
  }
});

test("an empty or whitespace-only command is ok", () => {
  for (const cmd of ["", "   ", "\n", "\t\n "]) assert.equal(scan(cmd).kind, "ok");
});

// ── The cwd handed back is the seam the caller threads into the next Bash call (DHK-394). ────────

test("the scanner hands back where the shell now stands", () => {
  const plain = scan("git status");
  assert.equal(plain.kind, "ok");
  assert.equal(plain.kind === "ok" ? plain.cwd : undefined, WT, "no cd: still the worktree");

  const moved = scan("cd packages/edge");
  assert.equal(moved.kind === "ok" ? moved.cwd : undefined, join(WT, "packages", "edge"));

  const twice = scan("cd packages && cd edge");
  assert.equal(twice.kind === "ok" ? twice.cwd : undefined, join(WT, "packages", "edge"));

  // A cwd carried in from an earlier Bash call is what the next one is judged from.
  const carried = scanCommand("cat package.json", roots(), join(WT, "packages", "edge"));
  assert.equal(carried.kind, "ok");
  assert.equal(scanCommand("cat ../../../escape", roots(), join(WT, "packages", "edge")).kind, "escape");
});

// ── Keep the synthetic fixture honest against what `computeFsRoots` really builds. ────────────────

test("the synthetic roots have the same shape computeFsRoots produces", () => {
  // `computeFsRoots` shells out for the git object store and the pnpm store; both fail soft, so a
  // bare temp dir is enough to compare the SHAPE without a `git init`.
  const dir = mkdtempSync(join(tmpdir(), "dahrk-roots-shape-"));
  try {
    const real = computeFsRoots({ worktreePath: dir, scratchPath: join(dir, "scratch") });
    const fake = roots();

    assert.equal(real.cwd, realish(dir), "cwd is the worktree");
    assert.ok(real.rw.includes(real.cwd), "the worktree is rw");
    assert.ok(fake.rw.includes(fake.cwd), "and so is the fixture's");

    // Every category the fixture asserts against must exist in production, spelled the same way.
    for (const p of [realish(tmpdir()), "/dev/null"]) {
      assert.ok(real.rw.includes(p), `production rw is missing ${p}`);
      assert.ok(fake.rw.includes(p), `fixture rw is missing ${p}`);
    }
    for (const p of [realish("/usr"), realish("/etc"), realish(join(homedir(), ".gitconfig"))]) {
      assert.ok(real.ro.includes(p), `production ro is missing ${p}`);
      assert.ok(fake.ro.includes(p), `fixture ro is missing ${p}`);
    }
    for (const p of [join(homedir(), ".ssh"), "/Volumes", "/etc/shadow"]) {
      assert.ok(real.deny.includes(p), `production deny is missing ${p}`);
      assert.ok(fake.deny.includes(p), `fixture deny is missing ${p}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- DHK-358: sibling repos are roots; their parent is not ---------------------------------------

const scanFrom = (cmd: string, cwd = WT) => scanCommand(cmd, roots(), cwd);

test("DHK-358: a sibling repo of the same run is reachable and writable", () => {
  // The whole point of a multi-repo run: change a contract and its consumer in one stage.
  for (const cmd of [
    "cd ../other-repo && pnpm test",
    "git -C ../other-repo status",
    "cat ../other-repo/package.json",
    "mkdir -p ../other-repo/dist",
  ]) {
    assert.equal(scanFrom(cmd).kind, "ok", cmd);
  }
});

test("DHK-358: an unanchored token after a legal `cd` resolves inside the sibling, and is allowed", () => {
  // This is the premise the header states: every cwd the scanner can reach is a writable root, so a
  // bare name after a rebind cannot escape.
  const out = scanFrom("cd ../other-repo && cat package.json");
  assert.equal(out.kind, "ok");
  assert.equal(out.kind === "ok" ? out.cwd : "", SIBLING, "and the cwd really did rebind");
});

test("DHK-358: the run directory holding both repos is NOT a root", () => {
  // It contains every repo plus the engine's scratch. Making it writable would hand the agent the lot.
  assert.equal(scanFrom("cd ..").kind, "escape");
  assert.equal(scanFrom("cat ../secret.txt").kind, "escape");
  assert.equal(scanFrom("cat ../../other-run/repo/x").kind, "escape", "nor is another run's directory");
});

test("DHK-358: escaping is still denied from EVERY worktree root, not only the primary", () => {
  for (const cwd of [WT, SIBLING]) {
    assert.equal(scanFrom(`cat ${OUT}/secret`, cwd).kind, "escape", `anchored escape from ${cwd}`);
    assert.equal(scanFrom("cat ~/.ssh/id_rsa", cwd).kind, "escape", `deny-listed read from ${cwd}`);
  }
});

test("a `cd` into a read-only root is refused, so an unanchored read cannot follow it", () => {
  // The escape this closes: `cd` used to be checked for READ, and `withinRoots` grants reads on `ro`
  // roots - which include `/etc`. So the cwd rebound into `/etc`, and `cat shadow` was then never
  // checked at all: `looksLikePath` returns false for a bare name, so `deny` was never consulted.
  assert.equal(scanFrom("cd /etc && cat shadow").kind, "escape");
  assert.equal(scanFrom("cd /usr/local").kind, "escape");
  // A writable root is still a legal destination, which is what `cd` is for.
  assert.equal(scanFrom("cd /tmp && rm -rf junk").kind, "ok");
});

test("a bare `cd`, `cd ~` and `cd -` do not silently leave the cwd behind", () => {
  // Returning "ok" without rebinding sent the real shell to $HOME while the scanner went on judging
  // relative paths against the worktree - and `builtins.ts` carries that cwd across tool calls, so the
  // mistake compounds for the rest of the session.
  assert.equal(scanFrom("cd").kind, "escape");
  assert.equal(scanFrom("cd ~").kind, "escape");
  assert.equal(scanFrom("cd -").kind, "escape");
});
