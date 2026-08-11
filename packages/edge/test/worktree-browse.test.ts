/**
 * Answering a worktree-browse request (DHK-1104).
 *
 * Two properties carry this file. The first is CONFINEMENT: a browse reply is built from paths a
 * caller supplied, so every test that matters here is a test that the caller cannot name a path
 * outside the run - by `..`, by an absolute path, or by a symlink whose own name gives nothing away.
 * The second is that a refusal is always a typed answer: the union has no literal for "escaped" or
 * "this node does not hold that run", so both come back as `not-found`, and never as a throw and never
 * as an empty listing, which would read as "the directory is there and has nothing in it".
 *
 * The fixture is a real git repository, because the exclusion rules are git's: asserting that a
 * gitignored file is hidden against a mocked git would assert only that the mock was written to agree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKTREE_READ_MAX_BYTES } from "@dahrk/contracts";
import { realish } from "../src/fs-roots.js";
import type { BrowseRoot } from "../src/stage-runner.js";
import { listDirectory, readFile, resolveBrowsePath } from "../src/worktree-browse.js";

const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
};

/** A run directory holding one or more repositories side by side, the layout a run actually has.
 *  `realish` because macOS resolves the temp dir through a symlink, and a root that is not already
 *  canonical would make every containment check compare two spellings of the same place. */
function fixture(repoDirs: string[] = ["alpha"]): { browse: BrowseRoot; runDir: string; cleanup: () => void } {
  const base = realish(mkdtempSync(join(tmpdir(), "dahrk-browse-")));
  const runDir = join(base, "worktrees", "run-1");
  mkdirSync(runDir, { recursive: true });
  const repos = repoDirs.map((dir) => {
    const worktreePath = join(runDir, dir);
    mkdirSync(worktreePath, { recursive: true });
    git(worktreePath, ["init", "-q"]);
    writeFileSync(join(worktreePath, ".gitignore"), "node_modules/\nbuilt.log\n");
    writeFileSync(join(worktreePath, "README.md"), `# ${dir}\n`);
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    writeFileSync(join(worktreePath, "src", "index.ts"), "export const x = 1;\n");
    return { dir, worktreePath };
  });
  return { browse: { root: runDir, repos }, runDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const names = (r: ReturnType<typeof listDirectory>): string[] => (r.ok ? r.entries.map((e) => e.name) : []);

// --- confinement -------------------------------------------------------------

test("a `..` segment cannot climb out of the run", () => {
  const { browse, cleanup } = fixture();
  try {
    for (const path of ["..", "../..", "alpha/../..", "alpha/../../../etc"]) {
      const r = listDirectory(browse, path);
      assert.equal(r.ok, false, `climbed out via ${path}`);
      assert.equal(r.ok === false && r.reason, "not-found", `wrong refusal for ${path}`);
    }
  } finally {
    cleanup();
  }
});

test("an absolute path is refused rather than served", () => {
  const { browse, cleanup } = fixture();
  try {
    assert.equal(listDirectory(browse, "/etc").ok, false);
    const r = readFile(browse, "/etc/hosts");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "not-found");
  } finally {
    cleanup();
  }
});

test("a symlink pointing outside the run is refused, and is not listed either", () => {
  const { browse, runDir, cleanup } = fixture();
  const outside = realish(mkdtempSync(join(tmpdir(), "dahrk-browse-outside-")));
  try {
    writeFileSync(join(outside, "secret.txt"), "not yours\n");
    // The name says nothing; only resolution reveals where it goes. This is why confinement resolves
    // before it compares, rather than inspecting the spelling of the path.
    symlinkSync(outside, join(runDir, "alpha", "escape"));

    const read = readFile(browse, "alpha/escape/secret.txt");
    assert.equal(read.ok, false);
    assert.equal(read.ok === false && read.reason, "not-found");
    assert.equal(listDirectory(browse, "alpha/escape").ok, false);

    // And it is absent from the listing: advertising a path that a read then refuses would look like
    // a fault rather than like the boundary working.
    assert.ok(!names(listDirectory(browse, "alpha")).includes("escape"));
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink INSIDE the run is followed, so confinement is not just a ban on links", () => {
  const { browse, runDir, cleanup } = fixture();
  try {
    symlinkSync(join(runDir, "alpha", "src"), join(runDir, "alpha", "link-to-src"));
    const r = listDirectory(browse, "alpha/link-to-src");
    assert.equal(r.ok, true);
    assert.deepEqual(names(r), ["index.ts"]);
  } finally {
    cleanup();
  }
});

test("resolveBrowsePath admits the root itself, which is what makes `\"\"` and `.` mean the root", () => {
  const { browse, runDir, cleanup } = fixture();
  try {
    assert.equal(resolveBrowsePath(runDir, ""), runDir);
    assert.equal(resolveBrowsePath(runDir, "."), runDir);
    assert.equal(resolveBrowsePath(runDir, ".."), undefined);
    // A NUL would truncate the name inside any syscall that received it.
    assert.equal(resolveBrowsePath(runDir, "alpha\0/etc"), undefined);
  } finally {
    cleanup();
  }
});

// --- listing -----------------------------------------------------------------

test("the run root lists its repositories, and a multi-repo run lists both", () => {
  const { browse, cleanup } = fixture(["alpha", "beta"]);
  try {
    const r = listDirectory(browse, "");
    assert.equal(r.ok, true);
    assert.deepEqual(names(r), ["alpha", "beta"]);
    assert.ok(r.ok && r.entries.every((e) => e.kind === "dir"));
    // Each descends independently: a sibling is a first-class part of the run, not a decoration.
    assert.deepEqual(names(listDirectory(browse, "beta/src")), ["index.ts"]);
  } finally {
    cleanup();
  }
});

test("a listing reports kinds and sizes, directories first", () => {
  const { browse, cleanup } = fixture();
  try {
    const r = listDirectory(browse, "alpha");
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.deepEqual(
      r.entries.map((e) => e.kind),
      ["dir", "file", "file"],
    );
    assert.deepEqual(names(r), ["src", ".gitignore", "README.md"]);
    const readme = r.entries.find((e) => e.name === "README.md");
    assert.equal(readme?.size, "# alpha\n".length);
  } finally {
    cleanup();
  }
});

test("a file path yields not-a-directory, and a missing one not-found", () => {
  const { browse, cleanup } = fixture();
  try {
    const f = listDirectory(browse, "alpha/README.md");
    assert.equal(f.ok === false && f.reason, "not-a-directory");
    const m = listDirectory(browse, "alpha/nope");
    assert.equal(m.ok === false && m.reason, "not-found");
  } finally {
    cleanup();
  }
});

// --- exclusions --------------------------------------------------------------

test("scratch and gitignored paths are excluded, matching what the footprint probe filters", () => {
  const { browse, runDir, cleanup } = fixture();
  try {
    // The engine's own directory, at the run root, where it is a symlink to the shared scratch and so
    // sits outside any repository's ignore rules entirely.
    mkdirSync(join(runDir, ".dahrk", "scratch"), { recursive: true });
    writeFileSync(join(runDir, ".dahrk", "scratch", "state.json"), "{}\n");
    assert.ok(!names(listDirectory(browse, "")).includes(".dahrk"));

    // Ignored by the repository's own .gitignore.
    writeFileSync(join(runDir, "alpha", "built.log"), "noise\n");
    mkdirSync(join(runDir, "alpha", "node_modules"), { recursive: true });
    writeFileSync(join(runDir, "alpha", "node_modules", "x.js"), "\n");
    const listed = names(listDirectory(browse, "alpha"));
    assert.ok(!listed.includes("built.log"), "gitignored file listed");
    assert.ok(!listed.includes("node_modules"), "gitignored directory listed");
    assert.ok(listed.includes("README.md"), "a tracked file went missing with them");

    // git's own store is machinery, not work under review.
    assert.ok(!listed.includes(".git"));
  } finally {
    cleanup();
  }
});

test("an ignore rule is judged per repository, not across the run", () => {
  const { browse, runDir, cleanup } = fixture(["alpha", "beta"]);
  try {
    // `built.log` is ignored in alpha by the fixture; beta ignores something else entirely.
    writeFileSync(join(runDir, "beta", ".gitignore"), "other.log\n");
    writeFileSync(join(runDir, "beta", "built.log"), "kept\n");
    assert.ok(names(listDirectory(browse, "beta")).includes("built.log"));
  } finally {
    cleanup();
  }
});

test("an ignored file nested below the listed directory is still excluded", () => {
  const { browse, runDir, cleanup } = fixture();
  try {
    // The ignore question is asked with repository-relative paths, so a nested listing has to map
    // both ways. A rule written for the repository root must still bite two levels down.
    writeFileSync(join(runDir, "alpha", ".gitignore"), "src/generated.ts\n");
    writeFileSync(join(runDir, "alpha", "src", "generated.ts"), "// generated\n");
    const listed = names(listDirectory(browse, "alpha/src"));
    assert.ok(!listed.includes("generated.ts"), "nested ignored file listed");
    assert.ok(listed.includes("index.ts"));
  } finally {
    cleanup();
  }
});

// --- reading -----------------------------------------------------------------

test("a text file is returned whole, with its size", () => {
  const { browse, cleanup } = fixture();
  try {
    const r = readFile(browse, "alpha/src/index.ts");
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.equal(r.content, "export const x = 1;\n");
    assert.equal(r.encoding, "utf8");
    assert.equal(r.size, "export const x = 1;\n".length);
    // Echoed back as asked, so the hub can correlate the reply with the request.
    assert.equal(r.path, "alpha/src/index.ts");
  } finally {
    cleanup();
  }
});

test("a binary file answers binary rather than raw bytes", () => {
  const { browse, runDir, cleanup } = fixture();
  try {
    writeFileSync(join(runDir, "alpha", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const r = readFile(browse, "alpha/logo.png");
    assert.equal(r.ok === false && r.reason, "binary");
  } finally {
    cleanup();
  }
});

test("an oversized file answers too-large", () => {
  const { browse, runDir, cleanup } = fixture();
  try {
    writeFileSync(join(runDir, "alpha", "big.txt"), "a".repeat(WORKTREE_READ_MAX_BYTES + 1));
    const r = readFile(browse, "alpha/big.txt");
    assert.equal(r.ok === false && r.reason, "too-large");
    // The boundary itself is readable, so the cap is not off by one against a file of exactly the cap.
    writeFileSync(join(runDir, "alpha", "edge.txt"), "a".repeat(WORKTREE_READ_MAX_BYTES));
    assert.equal(readFile(browse, "alpha/edge.txt").ok, true);
  } finally {
    cleanup();
  }
});

test("a directory answers not-a-file, and a missing path not-found", () => {
  const { browse, cleanup } = fixture();
  try {
    assert.equal(readFile(browse, "alpha/src").ok === false && readFile(browse, "alpha/src").reason, "not-a-file");
    const m = readFile(browse, "alpha/nope.txt");
    assert.equal(m.ok === false && m.reason, "not-found");
  } finally {
    cleanup();
  }
});

// --- layout ------------------------------------------------------------------

test("a legacy flat layout browses the worktree and cannot reach its siblings", () => {
  // Before the run-level layout a worktree WAS the run directory, so its parent is the worktrees dir,
  // holding every other run on the node. A browse rooted there would serve all of them.
  const base = realish(mkdtempSync(join(tmpdir(), "dahrk-browse-flat-")));
  try {
    const worktreesDir = join(base, "worktrees");
    const flat = join(worktreesDir, "run-1");
    mkdirSync(flat, { recursive: true });
    git(flat, ["init", "-q"]);
    writeFileSync(join(flat, "README.md"), "# flat\n");
    mkdirSync(join(worktreesDir, "run-2"), { recursive: true });
    writeFileSync(join(worktreesDir, "run-2", "other.txt"), "another run\n");

    const browse: BrowseRoot = { root: flat, repos: [{ dir: "", worktreePath: flat }] };
    assert.deepEqual(names(listDirectory(browse, "")), ["README.md"]);
    assert.equal(readFile(browse, "../run-2/other.txt").ok, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
