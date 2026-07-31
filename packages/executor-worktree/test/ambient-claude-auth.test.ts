/**
 * Ambient host-credential resolution (DHK-1004).
 *
 * The defect these pin: on macOS the Claude login lives in two stores, and an OAuth refresh rotates
 * the token in one while leaving the other holding a token the provider has since revoked. Which store
 * a process reaches depends on the security session it was started in, so a node under launchd read
 * the stale one and failed every stage on its first turn, at $0.00, on a host whose login was valid.
 *
 * The contract asserted here is that resolution is a decision the node makes and can explain, and that
 * it never depends on how the node was started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAmbientClaudeAuth, type AmbientAuthDeps } from "../src/ambient-claude-auth.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

/** A store payload in Claude Code's own shape. */
const store = (token: string, expiresAt?: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt === undefined ? {} : { expiresAt }) } });

/** Darwin by default: the two-store case is the one that broke. */
const deps = (over: Partial<AmbientAuthDeps> = {}): AmbientAuthDeps => ({
  platform: "darwin",
  now: () => NOW,
  homeDir: "/home/test",
  readKeychain: () => undefined,
  readFile: () => undefined,
  ...over,
});

test("DHK-1004: a stale Keychain and a fresh file resolve to the fresh one, not to whichever store won the race", () => {
  const r = resolveAmbientClaudeAuth(
    deps({
      readKeychain: () => store("sk-stale", NOW - HOUR),
      readFile: () => store("sk-fresh", NOW + HOUR),
    }),
  );
  assert.equal(r.chosen?.token, "sk-fresh");
  assert.equal(r.chosen?.source, "file");
});

test("the freshest wins regardless of which store holds it, so the Keychain is not second-class", () => {
  const r = resolveAmbientClaudeAuth(
    deps({
      readKeychain: () => store("sk-keychain", NOW + 2 * HOUR),
      readFile: () => store("sk-file", NOW + HOUR),
    }),
  );
  assert.equal(r.chosen?.token, "sk-keychain");
  assert.equal(r.chosen?.source, "keychain");
});

test("divergence is reported even when resolution succeeds, because the host still needs repairing", () => {
  const r = resolveAmbientClaudeAuth(
    deps({
      readKeychain: () => store("sk-stale", NOW - HOUR),
      readFile: () => store("sk-fresh", NOW + HOUR),
    }),
  );
  assert.equal(r.diverged, true, "two stores holding different tokens is a divergence");
  assert.match(r.detail, /keychain/, "the detail names the store holding the older token");
  assert.match(r.detail, /claude \/login/, "and tells the operator how to bring them back into line");
});

test("stores agreeing is not a divergence", () => {
  const r = resolveAmbientClaudeAuth(
    deps({ readKeychain: () => store("sk-same", NOW + HOUR), readFile: () => store("sk-same", NOW + HOUR) }),
  );
  assert.equal(r.diverged, false);
  assert.equal(r.chosen?.token, "sk-same");
});

test("every store expired resolves to nothing, and says so rather than handing back a doomed token", () => {
  const r = resolveAmbientClaudeAuth(
    deps({ readKeychain: () => store("sk-a", NOW - HOUR), readFile: () => store("sk-b", NOW - 2 * HOUR) }),
  );
  assert.equal(r.chosen, undefined, "an expired credential is worse than none: it fails on the first turn");
  assert.equal(r.candidates.length, 2, "but both are still reported, so the operator knows they exist");
  assert.match(r.detail, /expired/);
});

test("no store at all resolves to nothing, naming both places it looked", () => {
  const r = resolveAmbientClaudeAuth(deps());
  assert.equal(r.chosen, undefined);
  assert.deepEqual(r.candidates, []);
  assert.match(r.detail, /Keychain/);
  assert.match(r.detail, /credentials\.json/);
});

test("a credential with no stated expiry is usable, but ranks below a dated one", () => {
  const undated = resolveAmbientClaudeAuth(deps({ readFile: () => store("sk-undated") }));
  assert.equal(undated.chosen?.token, "sk-undated", "we cannot show it is expired, so we use it");

  const both = resolveAmbientClaudeAuth(
    deps({ readKeychain: () => store("sk-undated"), readFile: () => store("sk-dated", NOW + HOUR) }),
  );
  assert.equal(both.chosen?.token, "sk-dated", "a credential we can show is live beats one we cannot");
});

test("the Keychain is consulted on darwin only, so a Linux node never pays for a read that cannot work", () => {
  let reads = 0;
  const r = resolveAmbientClaudeAuth(
    deps({
      platform: "linux",
      readKeychain: () => {
        reads += 1;
        return store("sk-keychain", NOW + HOUR);
      },
      readFile: () => store("sk-file", NOW + HOUR),
    }),
  );
  assert.equal(reads, 0, "no Keychain read is attempted off darwin");
  assert.equal(r.chosen?.source, "file");
});

test("an unreadable or malformed store is skipped, not fatal: it is a store we do not use", () => {
  for (const bad of ["", "not json", "{}", JSON.stringify({ claudeAiOauth: {} }), "null"]) {
    const r = resolveAmbientClaudeAuth(deps({ readKeychain: () => bad, readFile: () => store("sk-ok", NOW + HOUR) }));
    assert.equal(r.chosen?.token, "sk-ok", `malformed payload ${JSON.stringify(bad)} does not break resolution`);
    assert.equal(r.diverged, false, "a store we could not parse is not a divergence");
  }
});
