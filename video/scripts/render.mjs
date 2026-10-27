// Renders the demo and the teaser straight into ~/revolve-media (never into
// the repo). Run through `npm run render`, which runs the probe first, so any
// clips or screenshots added since replace their fallbacks.
//
//   revolve-demo.mp4    1920 x 1080, 30 fps, H.264 CRF 18, AAC
//   revolve-teaser.mp4  1080 x 1080, 10 s, from the closing scene, for X

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const media = join(process.env.HOME, "revolve-media");
const remotion = join(process.cwd(), "node_modules", ".bin", "remotion");
const common = ["--codec=h264", "--crf=18", "--pixel-format=yuv420p", "--audio-codec=aac", "--audio-bitrate=192k", "--jpeg-quality=95", "--concurrency=6"];

for (const [id, file] of [
  ["RevolveDemo", "revolve-demo.mp4"],
  ["RevolveTeaser", "revolve-teaser.mp4"],
]) {
  console.log(`rendering ${id} -> ${join(media, file)}`);
  execFileSync(remotion, ["render", "src/index.ts", id, join(media, file), ...common], { stdio: "inherit" });
}
