#!/usr/bin/env node
/**
 * Assert this node's Pi runtime is not older than the model catalogue the hub offers against.
 *
 * WHY. Two repos pin Pi independently: dahrk-harness pins `@earendil-works/pi-ai` (which GENERATES the
 * provider/model catalogue the portal offers) and this repo pins `@earendil-works/pi-coding-agent`
 * (which RESOLVES those ids at run time). Nothing compared them, and they drifted: the catalogue
 * reached 0.80.10 while this repo sat on 0.80.6, so the portal offered models this node could not
 * resolve. The old adapter swallowed that and ran Pi's default model instead, so the symptom was never
 * an error - it was a run that went green on the wrong model.
 *
 * THE INVARIANT, and why it is `>=` rather than `==`. A node BEHIND the catalogue is the bug: it is
 * offered ids it cannot resolve. A node AHEAD is harmless: it knows a superset, and every id the portal
 * offers still resolves. So this repo is free to ship ahead of a harness release; it is only ever
 * blocked from falling behind one.
 *
 * The catalogue version is read from the INSTALLED `@dahrk/contracts`, not from a copy here, so the
 * check tracks the package this node actually builds against. That also sequences the cross-repo bump
 * correctly: `@dahrk/contracts` is hand-published, so after a harness bump this stays green on the old
 * published contracts and only starts demanding the new Pi once the new contracts is on npm.
 *
 * Usage: node scripts/check-pi-pin.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const PIN_PATH = "packages/executor-worktree/package.json";
const require = createRequire(import.meta.url);

/** Compare dotted numeric versions. Returns <0, 0, >0. Prerelease tags are not expected on these pins. */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const pkg = JSON.parse(readFileSync(PIN_PATH, "utf8"));
const nodePin = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
if (!nodePin) {
  console.error(`FAIL - ${PIN_PATH} does not depend on @earendil-works/pi-coding-agent`);
  process.exit(1);
}
// The pin is deliberately exact (no ^ or ~): the adapter imports the SDK by bare specifier and the
// edge image installs the same concrete version, so a range would let the two disagree.
if (!/^\d+\.\d+\.\d+$/.test(nodePin)) {
  console.error(`FAIL - @earendil-works/pi-coding-agent must be pinned exactly, found "${nodePin}"`);
  process.exit(1);
}

let catalogVersion;
try {
  ({ PI_CATALOG_VERSION: catalogVersion } = await import("@dahrk/contracts"));
} catch {
  // Fall back to resolving from the workspace package that depends on it (pnpm does not hoist).
  const entry = require.resolve("@dahrk/contracts", { paths: ["./packages/executor-worktree"] });
  ({ PI_CATALOG_VERSION: catalogVersion } = await import(entry));
}

if (!catalogVersion) {
  console.error("FAIL - @dahrk/contracts does not export PI_CATALOG_VERSION; is it too old to check against?");
  process.exit(1);
}

if (compareVersions(nodePin, catalogVersion) < 0) {
  console.error(
    `FAIL - this node pins pi-coding-agent ${nodePin}, but @dahrk/contracts offers models from pi-ai ` +
      `${catalogVersion}. The portal would offer ids this node cannot resolve.\n` +
      `       Bump "@earendil-works/pi-coding-agent" in ${PIN_PATH} to >= ${catalogVersion}.`,
  );
  process.exit(1);
}

console.log(`ok - pi-coding-agent ${nodePin} is not behind the @dahrk/contracts catalogue (pi-ai ${catalogVersion})`);
