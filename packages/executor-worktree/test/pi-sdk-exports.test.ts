/**
 * DHK-926: assert that the installed `@earendil-works/pi-coding-agent` exports every symbol
 * `defaultCreatePiSession` destructures. This is the check that would have gone red on the
 * 0.80.6 → 0.82.1 bump (which dropped `AuthStorage`) before the node shipped that version.
 *
 * Unlike `pi-adapter.test.ts` (which injects a mock session factory and never touches the SDK),
 * this test resolves the REAL installed package so a bump that removes a required export is caught
 * here, by the test suite, rather than at runtime on the first managed stage.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("DHK-926 Pi SDK exports every symbol defaultCreatePiSession depends on", async () => {
  const spec = "@earendil-works/pi-coding-agent";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import(spec)) as Record<string, unknown>;

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
});
