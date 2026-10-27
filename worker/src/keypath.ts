import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** Code folders a secret must never sit under, whether in a checkout or a deployed copy of one. */
const CODE_DIRS = new Set(["worker", "relay", "app", "solver"]);

/**
 * Why `path` is no place for a secret key, or null when it is fine: refused
 * inside a git work tree (`git rev-parse`) or anywhere under a worker/, relay/,
 * app/ or solver/ directory. A deployed copy without .git (the droplet's
 * /opt/revolve) is fine outside those folders, e.g. /opt/revolve/secrets.
 * The file itself need not exist; symlinks in its existing ancestors are resolved.
 */
export function secretPathProblem(path: string): string | null {
  const target = realTarget(resolve(path));
  for (let d = dirname(target); d !== dirname(d); d = dirname(d)) {
    if (CODE_DIRS.has(basename(d))) return `${target} is under ${d}; keep keys outside worker/, relay/, app/ and solver/`;
  }
  const top = gitWorkTree(nearestExisting(dirname(target)));
  if (top !== null) return `${target} is inside the git work tree ${top}`;
  return null;
}

/** The path with its deepest existing ancestor's symlinks resolved. */
function realTarget(path: string): string {
  const base = nearestExisting(path);
  return base === path ? realpathSync(path) : resolve(realpathSync(base), path.slice(base.length + 1));
}

function nearestExisting(path: string): string {
  while (!existsSync(path)) path = dirname(path);
  return path;
}

/** The work tree's top directory when `dir` lies inside one, else null (also when git is not installed). */
function gitWorkTree(dir: string): string | null {
  // Strip GIT_* so an inherited GIT_DIR or GIT_WORK_TREE cannot answer for another repo,
  // and trust every owner so a checkout owned by another user still counts.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "safe.directory=*", "rev-parse", "--is-inside-work-tree", "--show-toplevel"], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const [inside, top] = r.stdout.trim().split("\n");
  return inside === "true" ? (top ?? dir) : null;
}
