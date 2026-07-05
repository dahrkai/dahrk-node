import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// Read our own version so it can be compiled into the bundle. `npm_package_version` is only set by
// package-manager scripts, not when an installed binary is invoked directly, so `dahrk --version`
// would otherwise report 0.0.0. We replace the env lookup with the literal at build time (see `define`).
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // A CLI, not a library: no type declarations, and a shebang so the installed `dahrk-node` bin runs.
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  // Inline only our two private workspace packages (unpublished); everything else - the published
  // @dahrk/contracts, the runner SDKs, ws, zod - stays external and is resolved from `dependencies`.
  noExternal: [/^@dahrk\/(edge|executor-worktree)$/],
  define: {
    "process.env.npm_package_version": JSON.stringify(pkg.version),
  },
});
