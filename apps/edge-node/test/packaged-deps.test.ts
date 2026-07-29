/**
 * Packaging guard: every bare specifier the published bundle can reach at run time must be
 * resolvable from `apps/edge-node`'s own `dependencies`.
 *
 * WHY. `tsup.config.ts` sets `noExternal: [/^@dahrk\/(edge|executor-worktree)$/]`, so those two
 * workspace packages' SOURCE is inlined into `dist/main.js` while their DEPENDENCIES stay external
 * and resolve from the published manifest. Nothing previously connected the two: a workspace package
 * could add an import, build and test green in the monorepo (where pnpm resolves it from that
 * package's own node_modules), and still throw `ERR_MODULE_NOT_FOUND` on a clean `npx dahrk-node`.
 * That is exactly how `@earendil-works/pi-coding-agent` and `@modelcontextprotocol/sdk` shipped
 * missing - and a lazy `await import()` on the Pi path means the failure surfaces only when a Pi
 * stage actually runs, long after install.
 *
 * The scan is deliberately textual rather than a real module graph: it needs no build, it sees
 * dynamic imports with literal specifiers (which a bundler's own analysis reports inconsistently),
 * and over-reporting is the safe direction for a guard whose failure mode is a broken release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const manifestPath = join(repoRoot, "apps/edge-node/package.json");

/** The source trees that end up inside the published bundle: this app plus the inlined workspaces. */
const BUNDLED_SOURCE_DIRS = [
  "apps/edge-node/src",
  "packages/edge/src",
  "packages/executor-worktree/src",
];

/** `import x from "y"`, `export … from "y"`, `import("y")` - literal specifiers only. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

/**
 * Drop comments before scanning. This file's own house style is heavily prose-commented, and English
 * says "different from `x`" often enough that comments otherwise register as imports.
 *
 * Block comments go first (that is where the JSDoc prose lives), then line comments, skipping a `//`
 * preceded by `:` so URLs survive. A `/*` inside a string literal would over-strip, which can only
 * hide an import - so keep literal specifiers out of strings that contain comment markers.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Reduce a specifier to the package name npm would install: `@scope/pkg/sub` -> `@scope/pkg`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("every bare import in the bundled sources is a declared dependency of the published package", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const builtins = new Set(builtinModules);

  // Where each undeclared specifier came from, so a failure names the file to fix rather than just
  // the package. Kept as a Map so one missing dep with twenty import sites reports once.
  const missing = new Map<string, Set<string>>();

  for (const dir of BUNDLED_SOURCE_DIRS) {
    for (const file of sourceFiles(join(repoRoot, dir))) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const [, specifier] of source.matchAll(SPECIFIER_RE)) {
        // Relative and absolute paths are inlined by the bundler, never resolved from node_modules.
        if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
        const name = packageName(specifier);
        if (name.startsWith("node:") || builtins.has(name)) continue;
        // The inlined workspace packages are compiled INTO the bundle, so they are correctly absent
        // from `dependencies` - they live in devDependencies and must stay there.
        if (name === "@dahrk/edge" || name === "@dahrk/executor-worktree") continue;
        if (declared.has(name)) continue;
        const sites = missing.get(name) ?? new Set<string>();
        sites.add(file.slice(repoRoot.length));
        missing.set(name, sites);
      }
    }
  }

  assert.deepEqual(
    [...missing].map(([name, sites]) => `${name} (imported by ${[...sites].sort().join(", ")})`),
    [],
    "these packages are imported by code that tsup inlines into dist/main.js, but are not in " +
      "apps/edge-node/package.json dependencies, so they will not install for a user: ",
  );
});
