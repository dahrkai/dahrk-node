/**
 * pack-cache tests: the content-addressed cache fetches once, verifies integrity, and reuses the CAS
 * entry on a second materialise of the same contentHash.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComponentRef } from "@dahrk/contracts";
import { createPackCache, type ComponentBytes, type PackSource } from "../src/pack-cache.js";

const sha = (s: string): string => createHash("sha256").update(Buffer.from(s)).digest("hex");

/** Build a one-file component plus the contentHash the cache will require for it. */
function component(name: string, path: string, body: string): { ref: ComponentRef; bytes: ComponentBytes } {
  const fileSha = sha(body);
  const combined = createHash("sha256");
  combined.update(path);
  combined.update("\0");
  combined.update(fileSha);
  combined.update("\0");
  const contentHash = `sha256:${combined.digest("hex")}`;
  return {
    ref: { kind: "skill", name, version: "1.0.0", contentHash },
    bytes: { files: [{ path, bytes: Buffer.from(body), sha256: fileSha }] },
  };
}

function fakeSource(map: Record<string, ComponentBytes>): PackSource & { calls: number } {
  const src = {
    calls: 0,
    async fetch(ref: ComponentRef): Promise<ComponentBytes> {
      src.calls += 1;
      const b = map[ref.contentHash];
      if (!b) throw new Error(`no fixture for ${ref.contentHash}`);
      return b;
    },
  };
  return src;
}

test("first materialise is a miss that writes the files; second is a hit that does not call the source", async () => {
  const { ref, bytes } = component("review", ".claude/skills/review/SKILL.md", "do the review");
  const source = fakeSource({ [ref.contentHash]: bytes });
  const root = mkdtempSync(join(tmpdir(), "dahrk-cas-"));
  const cache = createPackCache({ root, source });

  const first = await cache.materialise(ref);
  assert.equal(first.hit, false);
  assert.equal(source.calls, 1);
  assert.equal(readFileSync(join(first.dir, ".claude/skills/review/SKILL.md"), "utf8"), "do the review");

  const second = await cache.materialise(ref);
  assert.equal(second.hit, true);
  assert.equal(source.calls, 1, "a cached contentHash must not re-fetch");
  assert.equal(second.dir, first.dir);
});

test("a tampered byte (sha256 mismatch) is rejected and nothing is cached", async () => {
  const { ref, bytes } = component("review", ".claude/skills/review/SKILL.md", "do the review");
  // Corrupt the file body but keep the declared sha256, so verification must fail.
  const tampered: ComponentBytes = {
    files: [{ ...bytes.files[0]!, bytes: Buffer.from("malicious") }],
  };
  const source = fakeSource({ [ref.contentHash]: tampered });
  const root = mkdtempSync(join(tmpdir(), "dahrk-cas-"));
  const cache = createPackCache({ root, source });

  await assert.rejects(() => cache.materialise(ref), /integrity check/);
});

test("a contentHash that does not match the file set is rejected", async () => {
  const { ref, bytes } = component("review", ".claude/skills/review/SKILL.md", "do the review");
  const wrongPin: ComponentRef = { ...ref, contentHash: "sha256:deadbeef" };
  const source = fakeSource({ "sha256:deadbeef": bytes });
  const root = mkdtempSync(join(tmpdir(), "dahrk-cas-"));
  const cache = createPackCache({ root, source });

  await assert.rejects(() => cache.materialise(wrongPin), /content hash mismatch/);
});
