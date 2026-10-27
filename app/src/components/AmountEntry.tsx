// The amount field shared by the buy sheet and Fund Revolve: a number in
// USD or ZEC, converted with the indicative rate from GET /limits, on the
// 0.001 ZEC grid, with one message line saying what is wrong or what the
// amount will be.

import { useEffect, useState } from "react";
import { checkAmount, formatZec, zecToUsd, type AmountCheck, type Limits, type Unit } from "../lib/amount.ts";
import { getLimits } from "../lib/orders.ts";
import { usd } from "../lib/format.ts";
import { Spinner } from "./bits.tsx";

const LOADING_RETRY_MS: [number, number] = [3_000, 5_000];
const ERROR_RETRY_MS: [number, number] = [8_000, 12_000];
const REFRESH_MS: [number, number] = [45_000, 75_000];
const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);

/**
 * Amount limits while `open` (GET /limits). "loading" until the worker has a
 * price and balance (503; ask again every 3 to 5 seconds), then refreshed
 * about once a minute since the max follows inventory. "error" if the worker
 * can't be reached; it keeps retrying.
 */
export type LimitsPhase = { phase: "loading" } | { phase: "ready"; limits: Limits } | { phase: "error" };

export function useLimits(open: boolean): [LimitsPhase, () => void] {
  const [state, setState] = useState<LimitsPhase>({ phase: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      getLimits().then(
        (r) => {
          if (!live) return;
          if (r.loading) {
            setState({ phase: "loading" });
            timer = setTimeout(ask, between(LOADING_RETRY_MS));
          } else {
            setState({ phase: "ready", limits: r.limits });
            timer = setTimeout(ask, between(REFRESH_MS));
          }
        },
        () => {
          if (!live) return;
          setState((s) => (s.phase === "ready" ? s : { phase: "error" }));
          timer = setTimeout(ask, between(ERROR_RETRY_MS));
        },
      );
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, nonce]);
  useEffect(() => {
    if (!open) setState({ phase: "loading" });
  }, [open]);
  return [state, () => setNonce((n) => n + 1)];
}

export const zecLabel = (zats: bigint) => `${formatZec(zats)} ZEC`;
export const usdLabel = (zats: bigint, limits: Limits) => usd(zecToUsd(zats, limits));

/** What the amount is for: it changes the wording of the max and "unavailable" messages. */
export type AmountPurpose = "buy" | "fund";

/** The one line under the amount: what is wrong, or what the amount will be. */
export function amountMessage(check: AmountCheck, unit: Unit, limits: Limits, purpose: AmountPurpose = "buy"): { text: string; error: boolean } {
  switch (check.kind) {
    case "unavailable":
      return { text: `${purpose === "buy" ? "Buying" : "Adding funds"} is temporarily unavailable. Try again soon.`, error: true };
    case "empty":
      return { text: `Between ${zecLabel(limits.min)} and ${zecLabel(limits.max)} (about ${usdLabel(limits.min, limits)} to ${usdLabel(limits.max, limits)}).`, error: false };
    case "invalid":
      return { text: unit === "USD" ? "Enter a dollar amount, like 5 or 5.50." : "Enter a ZEC amount, like 0.004.", error: true };
    case "below_min":
      return { text: `The minimum is ${zecLabel(limits.min)} (about ${usdLabel(limits.min, limits)}).`, error: true };
    case "above_max":
      return {
        text:
          purpose === "buy"
            ? `The most you can buy right now is ${zecLabel(limits.max)} (about ${usdLabel(limits.max, limits)}).`
            : `The most you can add at once is ${zecLabel(limits.max)} (about ${usdLabel(limits.max, limits)}).`,
        error: true,
      };
    case "ok":
      return unit === "USD"
        ? { text: `= ${zecLabel(check.zats)}${check.rounded ? ", rounded to the nearest 0.001 ZEC" : ""}`, error: false }
        : { text: `About ${usdLabel(check.zats, limits)}${check.rounded ? ". Rounded to the nearest 0.001 ZEC" : ""}`, error: false };
  }
}

export type AmountState = {
  unit: Unit;
  text: string;
  setText: (t: string) => void;
  switchUnit: (u: Unit) => void;
  check: AmountCheck | null;
  /** The final grid amount, when the input is valid. */
  zats: bigint | null;
};

export function useAmount(limits: Limits | null): AmountState {
  const [unit, setUnit] = useState<Unit>("USD");
  const [text, setText] = useState("");
  const check = limits ? checkAmount(text, unit, limits) : null;
  // Switching units keeps the amount: the ZEC side always shows the grid amount.
  const switchUnit = (next: Unit) => {
    if (next === unit) return;
    if (limits && check && "zats" in check && check.zats > 0n) setText(next === "ZEC" ? formatZec(check.zats) : zecToUsd(check.zats, limits).toFixed(2));
    setUnit(next);
  };
  return { unit, text, setText, switchUnit, check, zats: check?.kind === "ok" ? check.zats : null };
}

export function AmountEntry({ a, state, limits, purpose = "buy" }: { a: AmountState; state: LimitsPhase; limits: Limits | null; purpose?: AmountPurpose }) {
  const message = a.check && limits ? amountMessage(a.check, a.unit, limits, purpose) : null;
  return (
    <>
      <div className={`amount${message?.error ? " invalid" : ""}`}>
        <div className="row">
          {a.unit === "USD" && <span className="amount-unit">$</span>}
          <input
            className="amount-input num"
            inputMode="decimal"
            autoComplete="off"
            placeholder={a.unit === "USD" ? "0.00" : "0.000"}
            aria-label={`Amount in ${a.unit}`}
            aria-describedby="amount-msg"
            value={a.text}
            disabled={a.check?.kind === "unavailable"}
            onChange={(e) => a.setText(e.target.value)}
          />
          {a.unit === "ZEC" && <span className="amount-unit">ZEC</span>}
        </div>
        <div className="seg unit" role="group" aria-label="Currency">
          {(["USD", "ZEC"] as const).map((u) => (
            <button key={u} aria-pressed={a.unit === u} onClick={() => a.switchUnit(u)}>
              {u}
            </button>
          ))}
        </div>
      </div>
      <p id="amount-msg" className={message?.error ? "err amount-msg" : "faint amount-msg"} aria-live="polite">
        {state.phase === "loading" ? (
          <span className="row" style={{ gap: 10 }}>
            <Spinner /> Getting the latest rates…
          </span>
        ) : state.phase === "error" ? (
          "Can't reach Revolve right now. Retrying…"
        ) : (
          message?.text
        )}
      </p>
    </>
  );
}
