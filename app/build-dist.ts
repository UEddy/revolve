// Cleans the build output after Vite copies public/ into it: tool metadata
// such as a stray `.vercel` project link or a `.gitignore` must never be
// served. `.well-known` stays (WebAuthn related origins, Android asset links).

import { readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const KEEP = new Set([".well-known"]);

/** Removes dotfiles and dot-directories anywhere under `root`. Returns what it removed, relative to `root`. */
export function stripDotfiles(root: string, dir: string = root): string[] {
  const removed: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.name.startsWith(".") && !KEEP.has(entry.name)) {
      rmSync(path, { recursive: true, force: true });
      removed.push(relative(root, path));
    } else if (entry.isDirectory()) {
      removed.push(...stripDotfiles(root, path));
    }
  }
  return removed;
}
