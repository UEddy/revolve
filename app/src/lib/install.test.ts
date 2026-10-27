import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerKind, isIos, isSnoozed, SNOOZE_MS } from "./install.ts";

const base = { standalone: false, installed: false, ios: false, canPrompt: false, snoozed: false };

test("install banner: Chrome's prompt when offered, Share instructions on iOS, nothing when installed or snoozed", () => {
  assert.equal(bannerKind({ ...base, canPrompt: true }), "prompt");
  assert.equal(bannerKind({ ...base, ios: true }), "ios");
  assert.equal(bannerKind(base), null); // e.g. Firefox: no event, not iOS
  assert.equal(bannerKind({ ...base, canPrompt: true, standalone: true }), null);
  assert.equal(bannerKind({ ...base, ios: true, standalone: true }), null);
  assert.equal(bannerKind({ ...base, canPrompt: true, installed: true }), null);
  assert.equal(bannerKind({ ...base, canPrompt: true, snoozed: true }), null);
});

test("iOS detection, including iPads that report a Mac", () => {
  assert.ok(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", 5));
  assert.ok(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5));
  assert.ok(!isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 0));
  assert.ok(!isIos("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36", 5));
});

test("Not now holds for 7 days; missing, garbled or far-future values don't hide the banner", () => {
  const now = 1_800_000_000_000;
  assert.equal(isSnoozed(String(now + SNOOZE_MS), now), true);
  assert.equal(isSnoozed(String(now + 1), now), true);
  assert.equal(isSnoozed(String(now), now), false);
  assert.equal(isSnoozed(null, now), false);
  assert.equal(isSnoozed("soon", now), false);
  assert.equal(isSnoozed(String(now + 365 * 24 * 3600_000), now), false);
});
