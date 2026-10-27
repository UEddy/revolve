// The payment QR: a ZIP-321 URI as a QR code. Zodl doesn't open zcash: links
// from other apps, but its scanner imports a QR image from the gallery, so the
// app shows the code and can save it as a PNG.

import { encode } from "uqr";

export type Qr = { size: number; dark: boolean[][] };

/** Error correction M (15%) and the standard 4-module quiet zone, which phone scanners need. */
export function paymentQr(uri: string): Qr {
  const r = encode(uri, { ecc: "M", border: 4 });
  return { size: r.size, dark: r.data };
}

/** One SVG path drawing every dark module as a unit square, for a crisp code at any size. */
export function qrPath(qr: Qr): string {
  let d = "";
  qr.dark.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
  return d;
}

/** RGBA pixels, `scale` pixels per module: black on white, whatever the theme (scanners need the contrast). */
export function qrPixels(qr: Qr, scale: number): { width: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const width = qr.size * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) {
    const row = qr.dark[Math.floor(y / scale)]!;
    for (let x = 0; x < width; x++) {
      if (!row[Math.floor(x / scale)]) continue;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { width, data };
}

/** The code as a PNG of about 1000 px, large enough for any gallery import. */
export async function qrPng(qr: Qr): Promise<Blob> {
  const { width, data } = qrPixels(qr, Math.max(4, Math.ceil(1000 / qr.size)));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = width;
  canvas.getContext("2d")!.putImageData(new ImageData(data, width, width), 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not draw the QR code"))), "image/png"));
}

/**
 * Hands the PNG to the share sheet ("Save Image" on iPhone, Photos or Files on
 * Android), or downloads it where files can't be shared. The name carries no
 * order id. Returns false when the person closed the share sheet.
 */
export async function saveQr(png: Blob): Promise<boolean> {
  const file = new File([png], "revolve-payment-qr.png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return false;
      throw e;
    }
  }
  const url = URL.createObjectURL(png);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
