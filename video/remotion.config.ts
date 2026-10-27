// Remotion settings for the Revolve demo. Rendering options live in
// scripts/render.mjs; this file only shapes the bundle.

import { Config } from "@remotion/cli/config";
import { rspack } from "@rspack/core";
import path from "node:path";

const here = process.cwd();
const own = (m: string) => path.join(here, "node_modules", m);

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);

Config.overrideRspackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    // The phone screens render the app's own components from ../app/src. They
    // import React from the app's node_modules; two copies of React break
    // hooks, so every import of React resolves to this project's copy.
    alias: {
      ...(config.resolve?.alias ?? {}),
      react: own("react"),
      "react-dom": own("react-dom"),
    },
  },
  plugins: [
    ...(config.plugins ?? []),
    // The app's engine needs a vault, a relay and money; the carousel only
    // reads prices from it. Its icon URLs go through the live relay; the
    // video uses the icons inlined by scripts/probe.mjs instead.
    new rspack.NormalModuleReplacementPlugin(/^\.\.\/state\/engine\.tsx$/, path.join(here, "src/app-mocks/engine.tsx")),
    new rspack.NormalModuleReplacementPlugin(/^\.\.\/lib\/jupiter\.ts$/, path.join(here, "src/app-mocks/jupiter.ts")),
    // The payment card's quote timer runs on wall-clock time; frames render in
    // parallel, so it is frozen in the video.
    new rspack.NormalModuleReplacementPlugin(/^\.\.\/lib\/format\.ts$/, path.join(here, "src/app-mocks/format.ts")),
  ],
}));
