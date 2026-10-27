// Prints the scene timeline and the narration placement (seconds), from the same code the video uses.
import { SCENES, TOTAL, FPS } from "../src/timeline.ts";
const t = (f) => (f / FPS).toFixed(2);
for (const s of SCENES) {
  const vo = s.vo ? `VO ${t(s.from + s.vo.at)}-${t(s.from + s.vo.at + s.vo.trimAfter - s.vo.trimBefore)} (file ${t(s.vo.trimBefore)}-${t(s.vo.trimAfter)})` : "no VO";
  console.log(`${s.id.padEnd(8)} ${t(s.from).padStart(6)}-${t(s.from + s.duration).padStart(6)}  ${t(s.duration).padStart(5)}s  ${vo}`);
}
console.log(`total ${t(TOTAL)}s (${TOTAL} frames)`);
