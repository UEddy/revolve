import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBuildEnv } from "./build-env.ts";

const ok = { VITE_ORDER_API: "https://api.revolve.example", VITE_RELAY_URL: "https://relay.revolve.example/" };

test("a production build with real https services passes", () => {
  assert.deepEqual(checkBuildEnv("production", ok), {
    orderOrigin: "https://api.revolve.example",
    relayOrigin: "https://relay.revolve.example",
    relayUrl: "https://relay.revolve.example",
  });
});

test("demo mode can never be built, in any mode", () => {
  for (const mode of ["production", "localtest"]) {
    assert.throws(() => checkBuildEnv(mode, { ...ok, VITE_ORDER_API: "mock" }), /demo mode/);
    assert.throws(() => checkBuildEnv(mode, { ...ok, VITE_ORDER_API: " mock " }), /demo mode/);
    assert.throws(() => checkBuildEnv(mode, { ...ok, VITE_RELAY_URL: "mock" }), /demo mode/);
  }
});

test("missing or insecure services fail the build", () => {
  assert.throws(() => checkBuildEnv("production", { VITE_RELAY_URL: ok.VITE_RELAY_URL }), /must be set/);
  assert.throws(() => checkBuildEnv("production", { ...ok, VITE_RELAY_URL: "" }), /must be set/);
  assert.throws(() => checkBuildEnv("production", { ...ok, VITE_ORDER_API: "http://api.revolve.example" }), /https/);
  assert.throws(() => checkBuildEnv("production", { ...ok, VITE_ORDER_API: "http://127.0.0.1:8787" }), /https/);
  assert.throws(() => checkBuildEnv("localtest", { ...ok, VITE_ORDER_API: "http://10.0.0.5:8787" }), /https/);
  assert.equal(checkBuildEnv("localtest", { ...ok, VITE_ORDER_API: "http://127.0.0.1:8787" }).orderOrigin, "http://127.0.0.1:8787");
});
