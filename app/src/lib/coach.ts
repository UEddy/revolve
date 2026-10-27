// Privacy coach. Each position gets a linkability score with the reasons
// behind it, and risky moments (buying, sending, revealing a key) get a
// warning before they happen. Heuristics, stated plainly: the coach warns,
// it cannot prevent.

import type { Limits } from "./amount.ts";
import type { Credits, Position, TokenRef } from "./model.ts";

export type Level = "low" | "medium" | "high";
export type Reason = { points: number; text: string };
export type Risk = { score: number; level: Level; reasons: Reason[] };
export type Warning = { level: Level; title: string; body: string };

const MIN = 60_000;

export function levelOf(score: number): Level {
  return score >= 60 ? "high" : score >= 30 ? "medium" : "low";
}

function launchAge(token: TokenRef, at: number): number | null {
  if (!token.launchedAt) return null;
  const t = Date.parse(token.launchedAt);
  return Number.isFinite(t) ? at - t : null;
}

/** Addresses that more than one of the user's positions has sent to. */
function sharedDestinations(all: Position[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const p of all) for (const s of p.sends) seen.set(s.to, (seen.get(s.to) ?? new Set()).add(p.id));
  return new Set([...seen].filter(([, ids]) => ids.size > 1).map(([to]) => to));
}

export function positionRisk(p: Position, all: Position[]): Risk {
  const reasons: Reason[] = [
    { points: 10, text: "Funded by the shared payout wallet: on chain this looks like any Revolve user, not you." },
  ];
  const age = launchAge(p.token, p.createdAt);
  if (age !== null && age < 10 * MIN) reasons.push({ points: 30, text: "Bought within 10 minutes of launch, when the crowd of buyers is tiny." });
  else if (age !== null && age < 60 * MIN) reasons.push({ points: 15, text: "Bought within the first hour after launch." });
  const holders = p.token.holderCount;
  if (holders !== undefined && holders < 200) reasons.push({ points: 25, text: `Only ${holders} holders: a small crowd to hide in.` });
  else if (holders !== undefined && holders < 2_000) reasons.push({ points: 10, text: `${holders.toLocaleString("en")} holders: a modest crowd.` });
  const twin = all.find((o) => o.id !== p.id && o.token.mint === p.token.mint && Math.abs(o.createdAt - p.createdAt) < 60 * MIN);
  if (twin) reasons.push({ points: 15, text: "Another of your wallets bought the same asset within the hour." });
  const shared = sharedDestinations(all);
  for (const s of p.sends) {
    if (s.cashout && !shared.has(s.to)) reasons.push({ points: 10, text: "Cashed out to Zcash through Zodl's swap: the deposit, its amount and time are public on the swap's chain; the ZEC itself lands shielded." });
    else if (shared.has(s.to)) reasons.push({ points: 40, text: `Sent to ${short(s.to)}, which another of your wallets also sent to. Anyone can join them.` });
    else reasons.push({ points: 15, text: `Sent to ${short(s.to)}: that address is now tied to this purchase.` });
  }
  if (p.keyRevealed) reasons.push({ points: 15, text: "Its key was shown for export. Importing it next to your other wallets links them." });
  const score = Math.min(100, reasons.reduce((s, r) => s + r.points, 0));
  return { score, level: levelOf(score), reasons };
}

const OPEN_STAGES = new Set(["awaiting_payment", "settling", "funded", "swapping"]);

export function buyWarnings(token: TokenRef, positions: Position[], now: number): Warning[] {
  const w: Warning[] = [];
  const age = launchAge(token, now);
  if (age !== null && age < 10 * MIN) {
    const m = Math.max(1, Math.round(age / MIN));
    w.push({ level: "high", title: `Launched ${m} minute${m === 1 ? "" : "s"} ago`, body: "Early buyers are a small, closely watched crowd. A wallet buying now stands out, even a fresh one." });
  }
  if (token.holderCount !== undefined && token.holderCount < 200) {
    w.push({ level: "medium", title: `${token.holderCount} holders`, body: "Few holders means few wallets to blend in with." });
  }
  if (!token.verified) {
    w.push({ level: "medium", title: "Unverified token", body: "Not verified by Jupiter. Check it is the token you mean; copies with the same name are common." });
  }
  const sameMint = positions.filter((p) => p.token.mint === token.mint && p.stage !== "expired" && p.stage !== "closed");
  if (sameMint.length && (token.holderCount ?? 0) < 5_000) {
    w.push({ level: "medium", title: "You already hold this", body: "Repeat buys of a small token from several wallets form a pattern. Consider waiting." });
  }
  if (positions.some((p) => OPEN_STAGES.has(p.stage))) {
    w.push({ level: "low", title: "Another order is in flight", body: "Paying two orders at the same moment lets someone pair them by timing. Spacing them out helps." });
  }
  return w;
}

/**
 * A gentle note when the amount is close to the most Revolve can pay out
 * right now. Payouts are public, and the largest ones are the rarest, so
 * they have the fewest lookalikes. Only when the max leaves real room
 * (5x the minimum); otherwise every amount would look "large".
 */
export function amountNote(zats: bigint, limits: Limits): Warning | null {
  if (limits.max < limits.min * 5n || zats * 10n < limits.max * 7n) return null;
  return {
    level: "low",
    title: "A larger amount than most",
    body: "Bigger payouts are rarer, so fewer look like yours. A smaller amount, or a few buys spread over time, blends in better.",
  };
}

const SPEND_SOON_MS = 60 * MIN;

/**
 * Before a credits spend. The mint can't link tokens to a funding, but
 * timing and amounts still can: a spend right after a funding, or one that
 * empties the balance (above all when it equals the funded amount), pairs
 * the two for anyone watching both sides.
 */
export function creditWarnings(spendCredits: number, credits: Credits | undefined, now: number): Warning[] {
  const w: Warning[] = [];
  const balance = credits?.tokens.length ?? 0;
  const minted = credits?.fundings.filter((f) => f.mintedAt).sort((a, b) => b.mintedAt! - a.mintedAt!)[0];
  if (minted?.mintedAt && now - minted.mintedAt < SPEND_SOON_MS) {
    const m = Math.max(1, Math.round((now - minted.mintedAt) / MIN));
    w.push({
      level: "medium",
      title: `You added funds ${m} minute${m === 1 ? "" : "s"} ago`,
      body: "A buy right after funding can be paired with it by timing. Waiting a while before spending breaks that link.",
    });
  }
  if (spendCredits > 0 && spendCredits === balance) {
    const same = minted && minted.credits === spendCredits;
    w.push({
      level: "medium",
      title: "This uses your whole balance",
      body: same
        ? "It's also exactly the amount you added, so the funding and this buy can be matched by amount. Spending part of it, or buying in a few smaller steps, blends in better."
        : "Emptying the balance in one buy makes the amount easier to match to your funding. Spending part of it blends in better.",
    });
  }
  return w;
}

export function sendWarnings(from: Position, to: string, all: Position[]): Warning[] {
  const w: Warning[] = [];
  const own = all.find((p) => p.burner.pub === to);
  if (own) {
    w.push({ level: "high", title: "That is another of your wallets", body: "Moving funds between your wallets joins them for good. Anyone watching one now sees both." });
  }
  const prior = all.filter((p) => p.id !== from.id && p.sends.some((s) => s.to === to));
  if (prior.length) {
    w.push({ level: "high", title: "You sent to this address before", body: `Another of your wallets already sent here. Sending again links ${prior.length + 1} of your positions together.` });
  }
  w.push({ level: "medium", title: "This address becomes tied to the purchase", body: "Never send to an exchange account or a wallet people know is yours. That would undo the privacy of this position." });
  return w;
}

const CASHOUT_SOON_MS = 60 * MIN;
/** A cash-out this big, all at once, is rare enough on the swap's public records to stand out. */
const LARGE_USD = 250;
const LARGE_LAMPORTS_NO_PRICE = 2_000_000_000n;

/**
 * Before "Cash out to Zcash". Zodl's swap provider publishes each swap on its
 * own chain: the deposit from this wallet, the amount, and the time. The ZEC
 * lands shielded, but timing and amount can still pair the two ends: a
 * cash-out right after the buy, or one that moves a whole large position at
 * once, is easy to match.
 */
export function cashOutWarnings(p: Position, to: string, amountLamports: bigint, maxLamports: bigint, all: Position[], now: number, solUsd?: number): Warning[] {
  const w: Warning[] = [];
  if (all.some((o) => o.burner.pub === to)) {
    w.push({ level: "high", title: "That is another of your wallets", body: "Cash out goes to the deposit address Zodl shows, never to one of your own wallets." });
  }
  if (all.some((o) => o.sends.some((s) => s.to === to))) {
    w.push({ level: "high", title: "You sent to this address before", body: "Zodl shows a new deposit address for every swap. Reusing an old one links your positions, and the swap may not arrive. Start a new swap in Zodl." });
  }
  const bought = p.swap?.at ?? p.createdAt;
  if (now - bought < CASHOUT_SOON_MS) {
    const m = Math.max(1, Math.round((now - bought) / MIN));
    w.push({
      level: "medium",
      title: `You bought this ${m} minute${m === 1 ? "" : "s"} ago`,
      body: "The swap is public on its own chain, with its time. Cashing out right after buying lets the two be paired by timing. Waiting a while helps.",
    });
  }
  const whole = maxLamports > 0n && amountLamports * 10n >= maxLamports * 9n;
  const usd = solUsd === undefined ? null : (Number(amountLamports) / 1e9) * solUsd;
  const large = usd === null ? amountLamports >= LARGE_LAMPORTS_NO_PRICE : usd >= LARGE_USD;
  if (whole && large) {
    w.push({
      level: "medium",
      title: "This cashes out the whole position at once",
      body: "A large amount moved in one go is easy to match to the ZEC that arrives in your wallet. A few smaller cash-outs, spread over time, blend in better.",
    });
  }
  return w;
}

export function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}
