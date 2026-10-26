// Number and time formatting for the screens.

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (n !== 0 && Math.abs(n) < 0.01) return `$${sig(n, 3)}`;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(n) >= 1_000 ? 0 : 2 });
}

/** Prices can be tiny: keep three significant digits below a cent. */
export function price(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "–";
  if (n >= 1) return usd(n);
  return `$${sig(n, 3)}`;
}

function sig(n: number, digits: number): string {
  if (n === 0) return "0";
  const s = n.toPrecision(digits);
  return s.includes("e") ? Number(s).toFixed(Math.min(20, Math.ceil(-Math.log10(Math.abs(n))) + digits - 1)) : s;
}

export function compact(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

export function pct(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  return `${n > 0 ? "+" : ""}${n.toFixed(Math.abs(n) >= 10 ? 0 : 1)}%`;
}

export function units(raw: string | bigint | undefined, decimals: number): number {
  if (raw === undefined) return 0;
  return Number(BigInt(raw)) / 10 ** decimals;
}

export function amount(n: number): string {
  if (n === 0) return "0";
  if (n >= 1_000_000) return compact(n);
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return sig(n, 4);
}

export function ago(iso: string | number | undefined, now = Date.now()): string {
  if (iso === undefined) return "–";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "–";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  if (s < 86_400 * 60) return `${Math.round(s / 86_400)}d`;
  return `${Math.round(s / (86_400 * 30))}mo`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
