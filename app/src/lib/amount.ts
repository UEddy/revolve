// Free order amounts (API_CONTRACT.md v1.2): what the user types, in ZEC or
// USD, turned into an exact ZEC amount on the server's grid. All maths is in
// integer zatoshis so nothing drifts; the USD rate is for display only.

export const ZAT_PER_ZEC = 100_000_000n;

export type Unit = "ZEC" | "USD";

export type Limits = {
  min: bigint; // zatoshis
  max: bigint; // below `min` means no orders can be placed right now
  step: bigint;
  usdPerZec: bigint; // indicative, in USD x 1e8 per ZEC
};

/** A decimal string with up to `places` fraction digits, scaled to an integer. Accepts "," as the decimal mark. */
export function parseScaled(text: string, places: number): bigint | null {
  const s = text.trim().replace(",", ".");
  const m = new RegExp(`^(\\d*)(?:\\.(\\d{0,${places}}))?$`).exec(s);
  if (!m || (m[1] === "" && !m[2])) return null;
  return BigInt(m[1] || "0") * 10n ** BigInt(places) + BigInt((m[2] ?? "").padEnd(places, "0") || "0");
}

export function parseZec(text: string): bigint | null {
  return parseScaled(text, 8);
}

/** "0.004", "1.25", "2": the canonical form for the API and the payment link. */
export function formatZec(zats: bigint): string {
  const whole = zats / ZAT_PER_ZEC;
  const frac = (zats % ZAT_PER_ZEC).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Nearest multiple of `step`, halves rounded up. */
export function roundToStep(zats: bigint, step: bigint): bigint {
  return ((zats + step / 2n) / step) * step;
}

export function zecToUsd(zats: bigint, limits: Limits): number {
  return Number((zats * limits.usdPerZec) / ZAT_PER_ZEC) / 1e8;
}

export function usdToZats(usdText: string, limits: Limits): bigint | null {
  const usd = parseScaled(usdText, 2);
  if (usd === null || limits.usdPerZec <= 0n) return null;
  // usd is cents; the rate is USD x 1e8 per ZEC.
  return (usd * 1_000_000n * ZAT_PER_ZEC) / limits.usdPerZec;
}

export type AmountCheck =
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "below_min"; zats: bigint }
  | { kind: "above_max"; zats: bigint }
  | { kind: "ok"; zats: bigint; rounded: boolean };

/** What the typed amount means against the current limits. The result's `zats` is always on the grid. */
export function checkAmount(text: string, unit: Unit, limits: Limits): AmountCheck {
  if (limits.max < limits.min) return { kind: "unavailable" };
  if (!text.trim()) return { kind: "empty" };
  const raw = unit === "ZEC" ? parseZec(text) : usdToZats(text, limits);
  if (raw === null) return { kind: "invalid" };
  const zats = roundToStep(raw, limits.step);
  if (zats < limits.min) return { kind: "below_min", zats };
  if (zats > limits.max) return { kind: "above_max", zats };
  return { kind: "ok", zats, rounded: zats !== raw };
}

/** Parses GET /limits. Throws on anything that is not a sane decimal string. */
export function parseLimits(body: { min_zec?: unknown; max_zec?: unknown; step_zec?: unknown; indicative_usd_per_zec?: unknown }): Limits {
  const dec = (v: unknown, name: string) => {
    const n = typeof v === "string" ? parseZec(v) : null;
    if (n === null) throw new Error(`limits: bad ${name}`);
    return n;
  };
  const limits = {
    min: dec(body.min_zec, "min_zec"),
    max: dec(body.max_zec, "max_zec"),
    step: dec(body.step_zec, "step_zec"),
    usdPerZec: dec(body.indicative_usd_per_zec, "indicative_usd_per_zec"),
  };
  if (limits.step <= 0n || limits.min <= 0n) throw new Error("limits: step and min must be positive");
  return limits;
}
