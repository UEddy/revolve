import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, pageAt } from "./discover.ts";
import { shortPrice } from "./format.ts";

test("card prices stay short: zeros after the point become a subscript count below $0.001", () => {
  assert.equal(shortPrice(0.000625), "$0.0₃625");
  assert.equal(shortPrice(0.0000034), "$0.0₅34");
  assert.equal(shortPrice(0.00000000123), "$0.0₈123");
  assert.equal(shortPrice(0.00000000000005), "$0.0₁₃5");
  assert.equal(shortPrice(0.0009996), "$0.00100"); // rounds up out of the tiny range: normal format
  assert.equal(shortPrice(0.0123), "$0.0123");
  assert.equal(shortPrice(147.6), "$147.60");
  assert.equal(shortPrice(undefined), "–");
});

test("categories are the five asked for, in order", () => {
  assert.deepEqual(CATEGORIES.map((c) => c.label), ["Trending memes", "New", "Stocks", "Prediction markets", "Popular collections"]);
});

test("page dots follow the scroll position, three cards per page, last page pinned to the end", () => {
  const step = 110; // card width + gap
  const count = 10; // 4 pages: 0-2, 3-5, 6-8, 9
  const max = 700;
  assert.equal(pageAt(0, max, step, count), 0);
  assert.equal(pageAt(step * 2, max, step, count), 0);
  assert.equal(pageAt(step * 3, max, step, count), 1);
  assert.equal(pageAt(step * 3 - 20, max, step, count), 1); // snapping in progress rounds to the nearest card
  assert.equal(pageAt(step * 6, max, step, count), 2);
  assert.equal(pageAt(max, max, step, count), 3); // fully scrolled: last page even if it is short
  assert.equal(pageAt(0, 0, step, 2), 0); // fewer cards than a page: a single page
  assert.equal(pageAt(99_999, max, step, count), 3);
});
