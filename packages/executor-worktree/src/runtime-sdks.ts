/**
 * Which vendor SDK each runtime executes through, and whether it can be loaded from here.
 *
 * This lives in `executor-worktree` rather than next to the detection logic in `edge` on purpose:
 * these are the exact specifiers `claude-adapter.ts` and `pi-adapter.ts` import, and module resolution
 * is relative to the importing package. Asking the question from `edge` - which does not depend on
 * either SDK - answers "not installed" for a runtime the adapters would load perfectly well. In the
 * published bundle every module collapses into one file and the distinction disappears, so getting it
 * wrong here fails only in a source checkout: green in CI, green on npm, broken for whoever is
 * actually developing the node.
 */
import type { Runtime } from "@dahrk/contracts";

/** The npm package each runtime's adapter loads. Keep in step with the adapters' import specifiers. */
export const RUNTIME_SDK: Partial<Record<Runtime, string>> = {
  "claude-code": "@anthropic-ai/claude-agent-sdk",
  pi: "@earendil-works/pi-coding-agent",
};

/**
 * Can this process load `specifier`? Uses `import.meta.resolve`, which answers from the real
 * resolution algorithm without executing the module - so probing costs nothing and cannot be fooled by
 * a package that throws on import.
 *
 * Deliberately NOT extended to the Claude SDK's per-platform binary package (e.g.
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64`). Those packages expose no importable entry point, so
 * confirming one means guessing at a node_modules layout that differs between npm and pnpm and is the
 * SDK's private business - a check that would break silently on the next bump. A missing platform
 * binary is reported clearly by the SDK itself at stage time.
 */
export function canResolveSdk(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
