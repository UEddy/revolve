// Typechecks the video's own code. The phone screens import the app's real
// components from ../app/src; those files are checked by the app's own
// typecheck (a different TypeScript and DOM lib), so their errors are left out here.
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], { encoding: "utf8" });
const own = (r.stdout + r.stderr).split("\n").filter((l) => /^\S+\.(ts|tsx)\(/.test(l) && !l.startsWith("../app/"));
for (const l of own) console.log(l);
console.log(own.length ? `${own.length} error(s) in video/` : "video/: no type errors");
process.exit(own.length ? 1 : 0);
