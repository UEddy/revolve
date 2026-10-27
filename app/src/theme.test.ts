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
const SURFACES = ["bg", "surface", "sunk"];
const PAIRS: [string, string, number][] = [
  ...["ink", "muted", "faint", "link", "danger", "caution"].flatMap((fg) => SURFACES.map((bg): [string, string, number] => [fg, bg, 4.5])),
  ["on-accent", "accent", 4.5], // buttons, active tab, done steps
  ["on-accent", "accent-press", 4.5],
  ["on-danger", "danger-fill", 4.5],
  ["banner-ink", "banner-bg", 4.5],
  ...["bg", "surface", "sunk"].map((bg): [string, string, number] => ["accent-mark", bg, 3]),
  ...SURFACES.map((bg): [string, string, number] => ["caution-mark", bg, 3]), // warning dots
  ["qr-ink", "qr-paper", 15], // payment QR: scanners want the strongest contrast
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

const GOLD = "#f4b728";

test("#F4B728 is never used as text or marks on light backgrounds", () => {
  assert.ok(contrast(GOLD, light.bg!) < 3, "sanity: ZEC gold on white is too faint for text or thin marks");
  assert.equal(light.accent, GOLD, "the light accent fill is ZEC gold");
  for (const fg of ["ink", "muted", "faint", "link", "danger", "caution", "accent-mark", "caution-mark", "on-accent"]) {
    assert.notEqual(light[fg], GOLD, `${fg} must not be #F4B728 in light mode`);
  }
});

test("the accent fill is ZEC gold under black text in both modes", () => {
  for (const t of [light, dark]) {
    assert.equal(t.accent, GOLD);
    assert.equal(t["on-accent"], "#0a0a0a");
    assert.ok(luminance(t["accent-press"]!) < luminance(t.accent!), "pressed is darker");
  }
});

/** Hue in degrees, for telling warnings apart from the accent. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

test("warnings don't look like the accent: orange-red, clearly off gold, and not the danger red", () => {
  for (const [mode, t] of [["light", light], ["dark", dark]] as const) {
    for (const w of ["caution", "caution-mark", "banner-bg"]) {
      const h = hue(t[w]!);
      assert.ok(hue(GOLD) - h >= 15, `${mode} ${w} (${t[w]}, hue ${h.toFixed(0)}) is too close to gold (hue ${hue(GOLD).toFixed(0)})`);
      assert.ok(h >= 10 && h <= 30, `${mode} ${w} (${t[w]}, hue ${h.toFixed(0)}) is not orange-red`);
    }
    assert.notEqual(t.caution, t.danger, `${mode}: medium risk must not be the high-risk red`);
  }
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
