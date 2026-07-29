/**
 * DHK-926 / DHK-925: assert that the installed `@earendil-works/pi-coding-agent` exports every symbol
 * `defaultCreatePiSession` destructures. This is the check that would have gone red on the
 * 0.80.6 → 0.82.1 bump (which dropped `AuthStorage`) before the node shipped that version.
 *
 * Unlike `pi-adapter.test.ts` (which injects a mock session factory and never touches the SDK),
 * this test resolves the REAL installed package so a bump that removes a required export is caught
 * here, by the test suite, rather than at runtime on the first managed stage.
 *
 * DHK-925 root cause anchor: 0.82.x folded auth + model-registry into the async `ModelRuntime` and
 * dropped the `AuthStorage` root export, so an untyped dynamic import silently resolved it to
 * `undefined` and `AuthStorage.create(...)` threw at every session construction. We also assert that
 * `AuthStorage` is gone, proving the migration to `ModelRuntime` is complete and the old crash path
 * is closed.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("Pi SDK exports every symbol defaultCreatePiSession depends on", async () => {
  const spec = "@earendil-works/pi-coding-agent";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import(spec)) as Record<string, unknown>;

  // DHK-925 root cause: AuthStorage was removed in 0.82.1. Confirming it is absent proves the
  // migration to ModelRuntime is complete and the old `AuthStorage.create(...)` crash path is gone.
  assert.equal(sdk.AuthStorage, undefined, "AuthStorage is not exported in 0.82.1 — the root cause of DHK-925");

  // Keep this list in sync with the destructure in defaultCreatePiSession (pi-adapter.ts).
  // If this test goes red after an SDK bump, update the adapter to match the new API.
  const required = [
    "VERSION",
    "ModelRuntime",
    "DefaultResourceLoader",
    "SessionManager",
    "SettingsManager",
    "createAgentSession",
    "defineTool",
    "getAgentDir",
    "resolveCliModel",
  ] as const;

  for (const sym of required) {
    assert.notEqual(
      sdk[sym],
      undefined,
      `@earendil-works/pi-coding-agent@${sdk["VERSION"] ?? "?"} does not export '${sym}' — update the adapter or pin a compatible SDK`,
    );
  }

  // ModelRuntime replaces the defunct AuthStorage + ModelRegistry pair (DHK-925): its async
  // `create` static and instance `setRuntimeApiKey` are the two members the adapter and pi-auth drive.
  const ModelRuntime = sdk.ModelRuntime as { create?: unknown; prototype?: { setRuntimeApiKey?: unknown } };
  assert.equal(typeof ModelRuntime.create, "function", "ModelRuntime.create static must be callable");
  assert.equal(
    typeof ModelRuntime.prototype?.setRuntimeApiKey,
    "function",
    "ModelRuntime#setRuntimeApiKey must exist (applyApiKeyAuth awaits it)",
  );

  // DHK-978: the durable session statics `selectPiSessionManager` drives, replacing `inMemory`. A bump
  // that drops or renames either must go red here (naming the version) rather than silently at the first
  // managed Pi stage, where a durable session would fail to construct.
  const SessionManager = sdk.SessionManager as { create?: unknown; open?: unknown };
  assert.equal(typeof SessionManager.create, "function", "SessionManager.create static must be callable (durable, run-scoped)");
  assert.equal(typeof SessionManager.open, "function", "SessionManager.open static must be callable (resume across a retry)");
});
