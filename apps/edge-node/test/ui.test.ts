/**
 * `isInteractive` and `confirm`: the two things that decide whether the CLI may stop and ask a human.
 *
 * A prompt is only ever safe when somebody is there to answer it. Getting that judgement wrong does not
 * degrade the node, it stops it dead: a blocked `readline` question keeps the process alive, healthy and
 * completely inert, which is the hardest failure to spot because nothing crashes and nothing logs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { confirm, isInteractive } from "../src/ui.js";

/** Run `fn` with `process.stdin`/`process.stdout` reporting the given TTY-ness, and PID as given. */
async function withStdio(
  opts: { stdinTTY: boolean; stdoutTTY: boolean; pid?: number },
  fn: () => Promise<void> | void,
): Promise<void> {
  const inDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const pidDesc = Object.getOwnPropertyDescriptor(process, "pid");
  Object.defineProperty(process.stdin, "isTTY", { value: opts.stdinTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: opts.stdoutTTY, configurable: true });
  if (opts.pid !== undefined) Object.defineProperty(process, "pid", { value: opts.pid, configurable: true });
  try {
    await fn();
  } finally {
    if (inDesc) Object.defineProperty(process.stdin, "isTTY", inDesc);
    if (outDesc) Object.defineProperty(process.stdout, "isTTY", outDesc);
    if (pidDesc) Object.defineProperty(process, "pid", pidDesc);
  }
}

test("isInteractive: a TTY on both ends with a normal pid is an operator session", async () => {
  await withStdio({ stdinTTY: true, stdoutTTY: true, pid: 4242 }, () => {
    assert.equal(isInteractive(), true);
  });
});

test("isInteractive: a pipe on either end is not", async () => {
  await withStdio({ stdinTTY: false, stdoutTTY: true, pid: 4242 }, () => assert.equal(isInteractive(), false));
  await withStdio({ stdinTTY: true, stdoutTTY: false, pid: 4242 }, () => assert.equal(isInteractive(), false));
});

test("isInteractive: PID 1 is never interactive, however TTY-ish its stdio looks", async () => {
  // The case that wedged the managed guests. A node booted as a microVM's init runs as PID 1 with
  // `console=ttyS0`, so BOTH ends are a real TTY and every isTTY test says "a human is watching". Nobody
  // is: there is no keyboard on a serial console in a datacentre. The node printed `Update now? [Y/n]`
  // and waited for an answer that could never arrive - alive, enrolled, serving nothing, for hours.
  //
  // PID 1 is the honest signal. An init process is a machine's first process, never an operator's shell.
  await withStdio({ stdinTTY: true, stdoutTTY: true, pid: 1 }, () => {
    assert.equal(isInteractive(), false, "an init process has no operator to ask");
  });
});

test("confirm: returns false rather than blocking when nobody answers", async () => {
  // Defence in depth for every prompt, not just the update one. `isInteractive` is a heuristic and will
  // be wrong again somewhere; a prompt that can block for ever turns any such mistake into a dead node.
  // Bounded, it degrades to "no" - the safe answer for anything worth confirming.
  await withStdio({ stdinTTY: true, stdoutTTY: true, pid: 4242 }, async () => {
    const started = Date.now();
    const answered = await confirm("Update now?", { timeoutMs: 50 });
    assert.equal(answered, false, "no answer means no");
    assert.ok(Date.now() - started < 2_000, "and it gives up promptly rather than hanging");
  });
});
