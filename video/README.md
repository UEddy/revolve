# Revolve demo video

The ZECATHON 2026 demo, in [Remotion](https://www.remotion.dev): 1920 × 1080, 30 fps, under two minutes, plus a 10-second 1080 × 1080 teaser.

Code only lives here. Media (the voiceover, screen recordings, screenshots, renders) lives in `~/revolve-media/` and never enters the repo. `public/media` is a gitignored symlink to it.

```bash
npm ci
ln -sfn ~/revolve-media public/media
npm run dev      # probe, then Remotion Studio
npm run render   # probe, then render both videos into ~/revolve-media
```

## What `npm run probe` does

`scripts/probe.mjs` runs before Studio and every render, and writes `src/generated/` (gitignored):

- **The voiceover.** It splits `voiceover.mp3` at its silences (an adaptive `silencedetect` threshold from `loudnorm`) and matches the pieces, in order, to the script's nine blocks in `src/script.ts`. Each block's speaking time should fit its text, and cuts prefer the longest gaps. Each block then plays after its scene's lead-in, exactly as recorded: never sped up or pitched.
- **The media slots.** It lists which files exist. Present clips and screenshots replace their fallbacks automatically:

  | File in `~/revolve-media` | Replaces |
  |---|---|
  | `clip-fund.mp4` | the recreated Add funds → QR → credits flow |
  | `clip-buy.mp4` | the recreated buy with credits → status → Portfolio |
  | `clip-cashout.mp4` | the recreated cash out flow |
  | `explorer-near.png` | the styled card of the NEAR Intents deshield |
  | `explorer-revolve.png` | the styled card of the Revolve deposit |
  | `solscan-*.png` (sorted: payout, then buy) | the payout and buy hashes |
  | `music.mp3` | the empty music slot (plays at 12% volume, looped) |

  A real clip plays inside the phone, with the status bar covered. It plays the first 6 seconds unless its plan in `src/components/ClipSlot.tsx` says otherwise; waits can be sped up 1.5x there.
- **A Discover snapshot.** Live data and icons, fetched through Revolve's own relay. Refresh it with `node scripts/probe.mjs --refresh`.
- **The app's CSS and the wordmark's letters**, for the phone screens and the logo.

## Phone screens

The phone screens render the app's own code from `../app/src`: the Discover carousel (`DiscoverSection`), the payment card with its QR (`PayCard`), `TopBar`, `TokenIcon`, `Meter` and the icons. They render inside an iframe with the app's real `theme.css` and `styles.css` in dark mode. The other screens use the app's own markup and CSS classes. `remotion.config.ts` makes the app's imports work in the video:

- React resolves to this project's copy.
- The engine is a mock that only serves prices from the snapshot.
- Icon URLs come from the snapshot instead of the relay.
- The quote countdown is frozen, so frames rendered in parallel agree.

Every recreated (non-recorded) screen is captioned "Recreation of the live app". The QR in the video encodes a placeholder address with an invalid checksum, so nobody can pay to it from the video.

`npm run lint` typechecks the video's own code; the app's files are checked by the app's own typecheck.
