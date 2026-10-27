// Guards for theme.css: WCAG AA contrast for every text/background pair the
// app uses, in light and dark, and no colour values anywhere else in src/.
// `THEME_REPORT=1 node --test src/theme.test.ts` prints the ratio table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}
const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
const light = tokens(css.slice(0, darkAt));
const dark = { ...light, ...tokens(css.slice(darkAt)) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// [foreground, background, minimum]. Text is 4.5:1 (AA body text); marks
// that are not text (meter bars, focus ring, warning dots) are 3:1.
const SURFACES = ["bg", "surface", "sunk", "accent-tint"];
const PAIRS: [string, string, number][] = [
  ...["ink", "muted", "faint", "link", "danger"].flatMap((fg) => SURFACES.map((bg): [string, string, number] => [fg, bg, 4.5])),
  ["caution", "sunk", 4.5], // .badge.caution
  ["on-accent", "accent", 4.5], // buttons, active tab, done steps
  ["on-accent", "accent-press", 4.5],
  ["on-danger", "danger-fill", 4.5],
  ["banner-ink", "banner-bg", 4.5],
  ...["bg", "surface", "sunk"].map((bg): [string, string, number] => ["accent-mark", bg, 3]),
  ["caution-mark", "sunk", 3], // warning dot
];

for (const [mode, t] of [["light", light], ["dark", dark]] as const) {
  test(`${mode}: every pair meets WCAG AA`, () => {
    const rows = PAIRS.map(([fg, bg, min]) => {
      assert.ok(t[fg] && t[bg], `missing token ${fg} or ${bg}`);
      return { pair: `${fg} on ${bg}`, ratio: contrast(t[fg]!, t[bg]!), min };
    });
    if (process.env.THEME_REPORT) console.log(`${mode}\n` + rows.map((r) => `  ${r.pair.padEnd(26)} ${r.ratio.toFixed(2).padStart(6)}:1  (min ${r.min})`).join("\n"));
    for (const r of rows) assert.ok(r.ratio >= r.min, `${mode} ${r.pair} is ${r.ratio.toFixed(2)}:1, needs ${r.min}:1`);
  });
}

test("navy is never a text colour on the dark background", () => {
  assert.ok(contrast(dark.accent!, dark.bg!) < 4.5, "sanity: navy on black is unreadable");
  for (const fg of ["ink", "muted", "faint", "link"]) assert.notEqual(dark[fg], dark.accent, `${fg} must not be navy in dark mode`);
});

test("no colour values outside theme.css", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(css|tsx?)$/.test(e.name) && e.name !== "theme.css" && !e.name.endsWith(".test.ts")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) offenders.push(`${p}: ${m[0]}`);
      }
    }
  };
  walk(new URL(".", import.meta.url).pathname);
  assert.deepEqual(offenders, []);
});
