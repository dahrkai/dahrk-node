/**
 * The edge content-addressed cache for centrally-provisioned components.
 *
 * A component is pinned by `contentHash` (`sha256:<hex>` over its file set). The cache fetches each
 * pinned component once through an injected {@link PackSource}, verifies every byte against the
 * declared digests, writes it atomically under a CAS path keyed by the hash, and on any later request
 * for the same hash returns the cached directory without touching the source. Pure node fs/crypto:
 * no network, no SDK, so the prod source (a hub URL) and tests (an in-memory fixture) share one seam.
 *
 * Integrity is part of replay faithfulness: a tampered byte (sha256 mismatch) or a manifest hash that
 * does not match the combined digest is rejected, never written. The run pins exact bytes, never
 * "latest".
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { ComponentRef } from "@dahrk/contracts";

/** A single file of a component: its worktree-relative path (under `.claude/`) and verified bytes. */
export interface ComponentFile {
  path: string;
  bytes: Uint8Array;
  /** The producer's sha256 over `bytes` (hex). Verified by the cache before anything is written. */
  sha256: string;
}

/** The materialisable bytes of a component, as returned by a {@link PackSource}. */
export interface ComponentBytes {
  files: ComponentFile[];
}

/**
 * Where a {@link PackCache} fetches a pinned component from. Injected so production (a hub catalogue
 * URL) and tests (an in-memory fixture) implement the same interface; the deferred hub source plugs
 * in here without touching the cache. Called at most once per `contentHash` (cache misses only).
 */
export interface PackSource {
  fetch(ref: ComponentRef): Promise<ComponentBytes>;
}

export interface MaterialiseResult {
  /** The CAS directory holding the component's files (`<root>/sha256/<hex>`). */
  dir: string;
  /** True when the component was already cached and the source was not called. */
  hit: boolean;
}

export interface PackCache {
  /** Ensure the pinned component is present in the CAS, fetching+verifying once on a miss. */
  materialise(ref: ComponentRef): Promise<MaterialiseResult>;
  /** The CAS directory a `contentHash` maps to (whether or not it is present yet). */
  pathFor(contentHash: string): string;
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * List every file under a materialised CAS directory as a worktree-relative path (the same path the
 * manifest declared, e.g. `.claude/skills/review/SKILL.md`), so the overlay knows what to copy. Paths
 * use forward slashes regardless of platform, since they index into the worktree consistently.
 */
export function readManifestFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(relative(dir, abs).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The combined digest over a component's files: a sha256 over each file's `path` and content digest
 * in path order, so the same file set always yields the same hash regardless of fetch order. This is
 * what a pinned `contentHash` (`sha256:<hex>`) must equal for the component to be accepted.
 */
function combinedDigest(files: readonly ComponentFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path);
    h.update("\0");
    h.update(f.sha256);
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

export interface PackCacheOptions {
  /** Filesystem root the CAS lives under. */
  root: string;
  /** Where misses are fetched from. */
  source: PackSource;
}

export function createPackCache(opts: PackCacheOptions): PackCache {
  const { root, source } = opts;
  const pathFor = (contentHash: string): string => join(root, contentHash.replace(":", "/"));

  return {
    pathFor,
    async materialise(ref) {
      const dir = pathFor(ref.contentHash);
      // Fetch-once guarantee: a present CAS entry is reused without calling the source.
      if (existsSync(dir)) return { dir, hit: true };

      const bytes = await source.fetch(ref);

      // Verify each file's bytes against its declared sha256 before trusting any of them.
      for (const file of bytes.files) {
        const actual = sha256Hex(file.bytes);
        if (actual !== file.sha256) {
          throw new Error(
            `pack-cache: file "${file.path}" of ${ref.kind} ${ref.name}@${ref.version} failed integrity check (declared ${file.sha256}, got ${actual})`,
          );
        }
      }
      // Verify the manifest's pinned contentHash equals the combined digest of the file set.
      const combined = combinedDigest(bytes.files);
      if (combined !== ref.contentHash) {
        throw new Error(
          `pack-cache: ${ref.kind} ${ref.name}@${ref.version} content hash mismatch (pinned ${ref.contentHash}, computed ${combined})`,
        );
      }

      // Atomic install: write into a sibling temp dir, then rename into place. A concurrent
      // materialise of the same hash that wins the rename race leaves a valid entry either way.
      mkdirSync(root, { recursive: true });
      const tmp = mkdtempSync(join(root, ".tmp-"));
      try {
        for (const file of bytes.files) {
          const dest = join(tmp, file.path);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, file.bytes);
        }
        mkdirSync(dirname(dir), { recursive: true });
        try {
          // cpSync(recursive) then drop the temp: a plain rename can fail across the existing
          // parent or if another writer already landed the entry; treat an existing entry as a hit.
          if (existsSync(dir)) return { dir, hit: true };
          cpSync(tmp, dir, { recursive: true });
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
      return { dir, hit: false };
    },
  };
}
