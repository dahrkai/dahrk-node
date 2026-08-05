#!/usr/bin/env node
// Two gates on the PUBLIC changelog. Both exist because `release.yml` publishes a version's section
// verbatim into the GitHub release, and dahrk-web renders that release body onto dahrk.ai/changelog —
// so whatever lands here is what the world reads, uncorrected.
//
// 1. No internal tracker keys. `scripts/release.mjs` (`sanitizeNotes`) strips them from generated
//    notes, but a hand-written key in a versioned section would sail through.
//    Keep the key prefixes in sync with sanitizeNotes in scripts/release.mjs.
//
// 2. No entry over MAX_WORDS. The changelog had drifted to 80-140 word paragraphs per bullet — each
//    narrating the mechanism, the root cause and the remedy — because the only style rule written
//    down was "match the surrounding entries", and the surrounding entries were already paragraphs.
//    A word limit is the one rule that breaks that loop, because it is the one rule imitation cannot
//    satisfy. The detail belongs in CHANGELOG.internal.md, which is never published. See "A public
//    note is one sentence" in CLAUDE.md.
import { readFileSync } from "node:fs";

const KEY = /\b(?:DHK|SKA|LABS|TEST|HAR|SL)-\d+\b/;
const MAX_WORDS = 25;
const path = new URL("../CHANGELOG.md", import.meta.url);
const lines = readFileSync(path, "utf8").split("\n");

let failed = false;

// --- Gate 1: internal tracker keys ------------------------------------------------------------
const hits = [];
lines.forEach((line, i) => {
  const m = line.match(KEY);
  if (m) hits.push({ line: i + 1, key: m[0], text: line.trim() });
});

if (hits.length > 0) {
  console.error("CHANGELOG.md contains internal tracker keys — replace each with its GitHub PR ref (#N):\n");
  for (const h of hits) console.error(`  CHANGELOG.md:${h.line}  ${h.key}  ->  ${h.text}`);
  console.error(`\n${hits.length} leaked key(s). Public notes reference the PR, never the tracker key.`);
  failed = true;
}

// --- Gate 2: entry length ---------------------------------------------------------------------
// Count the words a reader sees, not the markdown. Strip the `(#N)` reference (bookkeeping, not
// prose), inline code spans, emphasis markers and link URLs, so an entry is never pushed over the
// limit by syntax it needs.
function wordCount(text) {
  const prose = text
    .replace(/\(#\d+\)/g, "") // the PR reference is not prose
    .replace(/`[^`]*`/g, "x") // a code span reads as one word however long it is
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // keep the link text, drop the URL
    .replace(/[*_]/g, "")
    .trim();
  return prose ? prose.split(/\s+/).length : 0;
}

// Walk the file collecting "entries": a bullet plus its indented continuation lines, or a bare prose
// paragraph under a version heading (0.3.2 shipped as one, with no bullets at all). Headings, link
// definitions, fenced code and the file's own preamble are not entries.
function collectEntries(src) {
  const entries = [];
  let inSection = false; // inside a `## [version]` section
  let inFence = false;
  let current = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  src.forEach((raw, i) => {
    const line = raw.trimEnd();

    if (/^\s*```/.test(line)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    if (/^## /.test(line)) {
      flush();
      // `## [Unreleased]` is gated identically: it is exactly where new drift enters.
      inSection = /^## \[/.test(line);
      return;
    }
    if (!inSection) return;
    if (/^### /.test(line) || /^\[[^\]]+\]:/.test(line) || line.trim() === "") {
      flush();
      return;
    }

    if (/^\s*[-*] /.test(line)) {
      flush();
      current = { line: i + 1, text: line.replace(/^\s*[-*] /, "") };
      return;
    }
    if (current) {
      current.text += " " + line.trim(); // an indented continuation of the bullet above
      return;
    }
    current = { line: i + 1, text: line.trim() }; // a bare paragraph under a version heading
  });

  flush();
  return entries;
}

const long = collectEntries(lines)
  .map((e) => ({ ...e, words: wordCount(e.text) }))
  .filter((e) => e.words > MAX_WORDS);

if (long.length > 0) {
  if (failed) console.error("");
  console.error(
    `CHANGELOG.md has ${long.length} ${long.length === 1 ? "entry" : "entries"} over ${MAX_WORDS} words. ` +
      "A public note is ONE SENTENCE stating the new behaviour:\n",
  );
  for (const e of long) {
    const preview = e.text.length > 90 ? e.text.slice(0, 90) + "…" : e.text;
    console.error(`  CHANGELOG.md:${e.line}  ${e.words} words  ->  ${preview}`);
  }
  console.error(
    "\nWhat makes an entry long is explaining the mechanism, the root cause, or what used to happen.\n" +
      "That belongs in CHANGELOG.internal.md, which is never published; a reader who wants it follows\n" +
      "(#N) to the PR. See 'A public note is one sentence' in CLAUDE.md.",
  );
  failed = true;
}

if (failed) process.exit(1);
console.log(`changelog lint OK: no internal tracker keys, no entry over ${MAX_WORDS} words`);
