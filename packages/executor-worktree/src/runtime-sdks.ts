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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Can a Pi stage authenticate from this host's environment alone, with nothing brokered?
 *
 * Asked of Pi rather than answered from a hardcoded list of provider env vars, because Pi supports
 * thirty-odd providers and any list we kept here would silently under-advertise the moment Pi added
 * one. `ModelRuntime.getAvailable()` is Pi's own answer to "which models can this actually use", and
 * it accounts for provider keys picked up from the process environment.
 *
 * The `ModelRuntime` is built on a THROWAWAY config dir, mirroring exactly what a real stage gets from
 * `defaultCreatePiSession`: a stage never inherits the machine-global `~/.pi`, so neither may this
 * probe - otherwise a node would advertise Pi on the strength of an OAuth login its stages cannot see.
 * What does carry through is the environment, which is the whole point of the question.
 *
 * Fails closed. If the SDK is absent or its API has moved, this returns false and the node advertises
 * one runtime fewer - visible and safe, where the alternative is accepting Jobs it cannot run.
 */
export async function piAmbientCredentialAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let dir: string | undefined;
  const savedEnv = process.env;
  try {
    const mod = (await import(RUNTIME_SDK.pi!)) as {
      ModelRuntime: { create(o: { authPath: string; modelsPath: string }): Promise<{ getAvailable(): unknown }> };
    };
    dir = await mkdtemp(join(tmpdir(), "dahrk-pi-probe-"));
    // Pi reads provider keys off `process.env` directly, so the caller's env has to be the live one for
    // the length of the probe. Restored in `finally`, including if the import or create throws.
    process.env = env;
    const runtime = await mod.ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
    });
    const available = await runtime.getAvailable();
    return Array.isArray(available) && available.length > 0;
  } catch {
    return false;
  } finally {
    process.env = savedEnv;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
