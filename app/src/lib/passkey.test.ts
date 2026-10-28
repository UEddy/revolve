import { test } from "node:test";
import assert from "node:assert/strict";
import { PasskeyTimeout, withPasskeyTimeout } from "./passkey.ts";

test("a passkey call that never answers is called off with a retryable error", async () => {
  let seen: AbortSignal | null = null;
  await assert.rejects(
    withPasskeyTimeout((signal) => {
      seen = signal;
      return new Promise<never>(() => {});
    }, 20),
    PasskeyTimeout,
  );
  assert.equal(seen!.aborted, true, "the browser's pending request is aborted too");
});

test("a passkey call that answers in time returns its answer and is not aborted", async () => {
  let seen: AbortSignal | null = null;
  const got = await withPasskeyTimeout(async (signal) => {
    seen = signal;
    return "ok";
  }, 1_000);
  assert.equal(got, "ok");
  assert.equal(seen!.aborted, false);
});

test("a passkey call's own error (e.g. the prompt closed) passes through unchanged", async () => {
  const closed = new Error("closed");
  await assert.rejects(withPasskeyTimeout(() => Promise.reject(closed), 1_000), (e) => e === closed);
});
