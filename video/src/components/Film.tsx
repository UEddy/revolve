// Subtle film grain and a soft vignette over every frame. The grain is one
// seeded noise tile, shifted to a new random offset each frame.

import { useMemo } from "react";
import { AbsoluteFill, random, useCurrentFrame } from "remotion";

function noiseTile(size = 256): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.floor(random(`grain-${i}`) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

export function Film() {
  const frame = useCurrentFrame();
  const tile = useMemo(() => noiseTile(), []);
  const x = Math.floor(random(`gx-${frame}`) * 256);
  const y = Math.floor(random(`gy-${frame}`) * 256);
  return (
    <>
      <AbsoluteFill
        style={{ backgroundImage: `url(${tile})`, backgroundPosition: `${x}px ${y}px`, opacity: 0.055, mixBlendMode: "overlay", pointerEvents: "none" }}
      />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 62%, rgba(0,0,0,0.38) 100%)", pointerEvents: "none" }} />
    </>
  );
}
