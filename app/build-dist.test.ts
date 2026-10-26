import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripDotfiles } from "./build-dist.ts";

test("dotfiles and dot-directories are stripped at any depth; .well-known and normal files stay", () => {
  const root = mkdtempSync(join(tmpdir(), "rv-dist-"));
  try {
    const put = (p: string) => {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), "x");
    };
    for (const p of [".vercel/project.json", ".gitignore", "assets/.DS_Store", "icons/.hidden/a.png", ".well-known/assetlinks.json", "index.html", "assets/app.js"]) put(p);
    assert.deepEqual(stripDotfiles(root).sort(), [".gitignore", ".vercel", "assets/.DS_Store", "icons/.hidden"]);
    for (const p of [".well-known/assetlinks.json", "index.html", "assets/app.js"]) assert.ok(existsSync(join(root, p)), p);
    for (const p of [".vercel", ".gitignore", "assets/.DS_Store", "icons/.hidden"]) assert.ok(!existsSync(join(root, p)), p);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
