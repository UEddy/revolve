// Runs before Studio and every render (npm run probe). Writes src/generated/:
//   manifest.json  which media files exist in ~/revolve-media (clips replace
//                  their fallbacks automatically), clip durations, and the
//                  voiceover split at its silences and matched to the script
//   discover.json  a snapshot of the live Discover data, through Revolve's own
//                  relay, with icons inlined (refreshed with --refresh)
//   app-css.json   the app's theme.css and styles.css, for the phone frames
// Nothing here is committed: src/generated/ is gitignored.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT } from "../src/script.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const media = join(process.env.HOME, "revolve-media");
const out = join(root, "src", "generated");
const remotion = join(root, "node_modules", ".bin", "remotion");
const RELAY = "https://revolveapp.duckdns.org/relay";
mkdirSync(out, { recursive: true });

// ffmpeg writes filter output to stderr even on success.
const ffStderr = (args) => {
  const r = execFileSync("sh", ["-c", `"${remotion}" ffmpeg -hide_banner ${args.map((a) => `'${a}'`).join(" ")} 2>&1`], { encoding: "utf8" });
  return r;
};
const probe = (file) => {
  const j = JSON.parse(execFileSync(remotion, ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8" }));
  const v = j.streams.find((s) => s.codec_type === "video");
  return { duration: Number(j.format.duration), width: v?.width ?? null, height: v?.height ?? null };
};

// ---------- media inventory ----------
const has = (name) => existsSync(join(media, name));
const clip = (name) => (has(name) ? { file: `media/${name}`, ...probe(join(media, name)) } : null);
const files = existsSync(media) ? readdirSync(media) : [];
const manifest = {
  clips: { fund: clip("clip-fund.mp4"), buy: clip("clip-buy.mp4"), cashout: clip("clip-cashout.mp4") },
  images: {
    explorerNear: has("explorer-near.png") ? "media/explorer-near.png" : null,
    explorerRevolve: has("explorer-revolve.png") ? "media/explorer-revolve.png" : null,
    solscan: files.filter((f) => /^solscan-.*\.png$/.test(f)).sort().map((f) => `media/${f}`),
  },
  music: has("music.mp3") ? "media/music.mp3" : null,
  voiceover: null,
};

// ---------- voiceover: speech segments, matched to the script's blocks ----------
if (has("voiceover.mp3")) {
  const vo = join(media, "voiceover.mp3");
  const { duration } = probe(vo);
  const loud = ffStderr(["-i", vo, "-af", "loudnorm=print_format=json", "-f", "null", "/dev/null"]);
  const thresh = Number(/"input_thresh"\s*:\s*"(-?[\d.]+)"/.exec(loud)?.[1] ?? "-40");
  const sd = ffStderr(["-i", vo, "-af", `silencedetect=noise=${thresh}dB:d=0.25`, "-f", "null", "/dev/null"]);
  const silences = [];
  const re = /silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g;
  for (let m; (m = re.exec(sd)); ) silences.push({ start: Number(m[1]), end: Number(m[2]) });
  // Speech = everything between silences.
  const segs = [];
  let at = 0;
  for (const s of silences) {
    if (s.start - at > 0.05) segs.push({ start: at, end: s.start });
    at = s.end;
  }
  if (duration - at > 0.05) segs.push({ start: at, end: duration });

  // Group consecutive segments into the script's blocks: each block's speaking
  // time should match its share of the text, and cuts prefer the longest gaps.
  const blocks = SCRIPT.map((b) => b.vo);
  const chars = blocks.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "").length);
  const speech = segs.reduce((s, x) => s + (x.end - x.start), 0);
  const rate = speech / chars.reduce((a, b) => a + b, 0);
  const n = segs.length, k = blocks.length;
  const gapAfter = (i) => (i + 1 < n ? segs[i + 1].start - segs[i].end : 1);
  const cost = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
  const from = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(-1));
  cost[0][0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n; i++) {
      for (let p = j - 1; p < i; p++) {
        if (cost[j - 1][p] === Infinity) continue;
        let dur = 0;
        for (let q = p; q < i; q++) dur += segs[q].end - segs[q].start;
        const want = chars[j - 1] * rate;
        const c = cost[j - 1][p] + ((dur - want) / want) ** 2 - 0.6 * gapAfter(i - 1);
        if (c < cost[j][i]) {
          cost[j][i] = c;
          from[j][i] = p;
        }
      }
    }
  }
  const cuts = [];
  for (let j = k, i = n; j > 0; j--) {
    const p = from[j][i];
    cuts.unshift([p, i]);
    i = p;
  }
  manifest.voiceover = {
    file: "media/voiceover.mp3",
    duration,
    threshold: thresh,
    blocks: cuts.map(([a, b], j) => ({
      id: SCRIPT[j].id,
      start: segs[a].start,
      end: segs[b - 1].end,
      segments: segs.slice(a, b),
    })),
  };
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---------- the app's CSS, for the phone frames ----------
const app = resolve(root, "..", "app", "src");
writeFileSync(
  join(out, "app-css.json"),
  JSON.stringify({ theme: readFileSync(join(app, "theme.css"), "utf8"), styles: readFileSync(join(app, "styles.css"), "utf8") }),
);

// ---------- brand: the dark wordmark's letters (the mark is drawn live on top) ----------
const wordmark = readFileSync(join(app, "assets", "brand", "revolve-wordmark-dark.svg"), "utf8");
writeFileSync(
  join(out, "brand.json"),
  JSON.stringify({
    wordmarkLetters: wordmark.replace(/<path[^>]*\sstroke="[^"]*"[^>]*\/>/g, "").replace(/<circle[^>]*\/>/g, ""),
    viewBox: /viewBox="([^"]+)"/.exec(wordmark)[1],
  }),
);

// ---------- Discover snapshot (live data through the relay; icons inlined) ----------
const snapPath = join(out, "discover.json");
if (!existsSync(snapPath) || process.argv.includes("--refresh")) {
  const get = async (path) => {
    const r = await fetch(`${RELAY}${path}`, { headers: { origin: "https://revolveapp-phi.vercel.app" } });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  };
  const jup = (path, q) => get(`/jup?${new URLSearchParams({ path, ...q })}`);
  const [trending, fresh, stocks, markets, solNfts, ethNfts, rhNfts, prices] = await Promise.all([
    jup("tokens/v2/toptrending/1h", { limit: "40" }),
    jup("tokens/v2/recent", { limit: "40" }),
    jup("tokens/v2/search", { query: "xStock" }),
    get("/feeds/markets"),
    get("/feeds/nfts"),
    get("/feeds/nfts/ethereum"),
    get("/feeds/nfts/robinhood"),
    jup("price/v3", { ids: "So11111111111111111111111111111111111111112,7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" }),
  ]);
  const icons = {};
  const inline = async (url) => {
    if (!url || !url.startsWith("https://") || url in icons) return;
    try {
      const r = await fetch(`${RELAY}/img?u=${encodeURIComponent(url)}`, { headers: { origin: "https://revolveapp-phi.vercel.app" } });
      if (!r.ok) return;
      const type = r.headers.get("content-type") ?? "image/png";
      icons[url] = `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
    } catch {}
  };
  const lists = [trending, fresh, stocks].map((l) => l.slice(0, 24));
  const nftItems = [solNfts, ethNfts, rhNfts].flatMap((f) => f.items);
  for (const t of lists.flat()) await inline(t.icon);
  for (const m of markets.items.slice(0, 12)) await inline(m.image);
  for (const c of nftItems) await inline(c.image);
  writeFileSync(
    snapPath,
    JSON.stringify({
      at: new Date().toISOString(),
      trending: lists[0], fresh: lists[1], stocks: lists[2],
      markets: markets.items, nfts: { solana: solNfts.items, ethereum: ethNfts.items, robinhood: rhNfts.items },
      prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v.usdPrice])),
      icons,
    }),
  );
}

const vo = manifest.voiceover;
console.log(`media: ${files.length} files in ${media}`);
for (const [k, v] of Object.entries(manifest.clips)) console.log(`  clip ${k}: ${v ? `${v.file} ${v.duration.toFixed(1)}s ${v.width}x${v.height}` : "missing (fallback)"}`);
console.log(`  explorer-near: ${manifest.images.explorerNear ?? "missing (fallback)"}; explorer-revolve: ${manifest.images.explorerRevolve ?? "missing (fallback)"}; solscan: ${manifest.images.solscan.length || "missing (fallback)"}`);
console.log(`  music: ${manifest.music ?? "none (empty slot)"}`);
if (vo) {
  console.log(`voiceover ${vo.duration.toFixed(2)}s, threshold ${vo.threshold} dB, ${vo.blocks.reduce((s, b) => s + b.segments.length, 0)} segments`);
  for (const b of vo.blocks) console.log(`  ${b.id.padEnd(9)} ${b.start.toFixed(2)}-${b.end.toFixed(2)} (${(b.end - b.start).toFixed(2)}s, ${b.segments.length} segments)`);
}
