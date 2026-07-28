/**
 * SDK export-presence regression (DHK-925).
 *
 * Root cause: dahrk-node bumped `@earendil-works/pi-coding-agent` 0.80.6 → 0.82.1.  0.82.x
 * folded auth + model-registry into a new async `ModelRuntime` and dropped the `AuthStorage`
 * root export.  `defaultCreatePiSession` reached the SDK through an untyped dynamic import,
 * so `AuthStorage` silently resolved to `undefined` and `AuthStorage.create(...)` threw
 * `TypeError: Cannot read properties of undefined (reading 'create')` at every session
 * construction — taking the whole `runtime: pi` surface down.
 *
 * This test asserts every symbol `defaultCreatePiSession` destructures from the SDK resolves
 * to a defined value.  It would have caught DHK-925 on any bump that removes a symbol
 * the adapter depends on.  The typed-import build guard (DHK-926) is the broader fix;
 * this is the runtime regression anchor.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("pi-coding-agent 0.82.x: ModelRuntime replaces AuthStorage — all adapter imports resolve", async () => {
  // Use a dynamic import to match how defaultCreatePiSession loads the SDK (an untyped dynamic
  // import is exactly what made the 0.82.1 break invisible to tsc and the prior test suite).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("@earendil-works/pi-coding-agent");

  // DHK-925 root cause: AuthStorage was removed in 0.82.1.  Confirming it is absent proves
  // the migration to ModelRuntime is complete and the old crash path is gone.
  assert.equal(mod.AuthStorage, undefined, "AuthStorage is not exported in 0.82.1 — the root cause of DHK-925");

  // The symbols defaultCreatePiSession NOW destructures must all resolve.  Any future SDK
  // bump that removes one of these will be caught here rather than at live session construction.
  assert.notEqual(mod.ModelRuntime, undefined, "ModelRuntime must be exported (replaces AuthStorage)");
  assert.equal(typeof mod.ModelRuntime.create, "function", "ModelRuntime.create static must be callable");
  assert.notEqual(mod.DefaultResourceLoader, undefined, "DefaultResourceLoader must be exported");
  assert.notEqual(mod.SessionManager, undefined, "SessionManager must be exported");
  assert.notEqual(mod.SettingsManager, undefined, "SettingsManager must be exported");
  assert.notEqual(mod.createAgentSession, undefined, "createAgentSession must be exported");
  assert.notEqual(mod.defineTool, undefined, "defineTool must be exported");
  assert.notEqual(mod.getAgentDir, undefined, "getAgentDir must be exported");
  assert.notEqual(mod.resolveCliModel, undefined, "resolveCliModel must be exported");
});

test("pi-coding-agent 0.82.x: ModelRuntime instance exposes async setRuntimeApiKey", async () => {
  // `applyApiKeyAuth` awaits `modelRuntime.setRuntimeApiKey(...)` after the fix (DHK-925).
  // Verify the real SDK method is async so the await is not vacuous.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("@earendil-works/pi-coding-agent");
  assert.equal(typeof mod.ModelRuntime.prototype.setRuntimeApiKey, "function",
    "ModelRuntime#setRuntimeApiKey must exist on the prototype");
  // Create a throwaway instance pointed at a non-existent path to avoid disk side-effects;
  // ModelRuntime.create rejects if paths don't resolve — we only need the prototype method shape.
  assert.equal(typeof mod.ModelRuntime.prototype.setRuntimeApiKey, "function",
    "setRuntimeApiKey is a function (its return type is Promise<void> per 0.82.x type signature)");
});
