// Buying on Base: a short list of well-known tokens, or any token by its
// contract address, each paid in shielded ZEC like on Solana and landing in a
// fresh Base wallet of its own (API_CONTRACT.md v1.4).

import { useEffect, useState } from "react";
import { BASE_TOKENS, baseToken } from "../lib/basetokens.ts";
import { baseUsdPrice } from "../lib/baseswap.ts";
import { BASE_RESERVE_WEI, NATIVE_ETH, checksummed, isEvmAddress, tokenMeta } from "../lib/evm.ts";
import { kyberRoute } from "../lib/kyber.ts";
import { afterSpread, zecToUsd, type Limits } from "../lib/amount.ts";
import { usdPrice } from "../lib/jupiter.ts";
import { BASE_BUYING, ETH_MINT } from "../lib/config.ts";
import { price, units } from "../lib/format.ts";
import type { TokenRef } from "../lib/model.ts";
import { go, href } from "../router.ts";
import { TokenIcon, TopBar } from "../components/bits.tsx";
import { BuySheet } from "./Token.tsx";

/** Tokens met by address this session, so a link back finds them without another lookup. */
const looked = new Map<string, TokenRef>();

function useBaseToken(address: string) {
  const known = baseToken(address) ?? looked.get(address) ?? null;
  const [t, setT] = useState<TokenRef | null>(known);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (known) return;
    if (!isEvmAddress(address)) return setError("That is not a Base token address.");
    let live = true;
    tokenMeta(address).then(
      (m) => {
        // Unlisted: the name comes from the contract itself, so the coach treats it as unverified.
        const ref: TokenRef = { mint: checksummed(address), symbol: m.symbol, name: m.name, decimals: m.decimals, isStock: false, verified: false };
        looked.set(address, ref);
        if (live) setT(ref);
      },
      () => live && setError("No token found at that address on Base."),
    );
    return () => {
      live = false;
    };
  }, [address]);
  return { t, error };
}

export function BaseScreen() {
  return (
    <div className="screen">
      <TopBar title="Buy on Base" />
      <BaseList />
    </div>
  );
}

/** The Base tokens and a field for any token's address: the Base screen and Discover's Base chip. */
export function BaseList() {
  const [text, setText] = useState("");
  const pasted = text.trim();
  const valid = isEvmAddress(pasted);
  return (
    <>
      <p className="muted small" style={{ margin: "0 2px 12px" }}>
        {BASE_BUYING
          ? "Paid in shielded ZEC like everything else. Each buy lands in a fresh Base wallet of its own, holding that one token and a little ETH for gas."
          : "Browse only for now: buying on Base is coming soon, paid in shielded ZEC like everything else, each buy in a fresh Base wallet of its own."}
      </p>
      <div className="list">
        {BASE_TOKENS.map((t) => (
          <a key={t.mint} className="trow" href={href.baseToken(t.mint)}>
            <TokenIcon symbol={t.symbol} />
            <div className="grow">
              <div className="name">{t.symbol} <span className="badge ok">✓</span></div>
              <div className="sub">{t.name}</div>
            </div>
          </a>
        ))}
      </div>
      <h2>Any token on Base</h2>
      <input
        className="input"
        placeholder="Paste a token contract address (0x…)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {pasted && !valid && <p className="err">That is not a valid address.</p>}
      <div style={{ height: 10 }} />
      <button className="btn ghost" disabled={!valid} onClick={() => go(href.baseToken(checksummed(pasted)))}>
        Look it up
      </button>
    </>
  );
}

/** A rough "you get": the amount's value in ETH after the spread, less the gas reserve, quoted on KyberSwap. */
function baseEstimate(t: TokenRef) {
  return async (zats: bigint, limits: Limits): Promise<number | null> => {
    const eth = await usdPrice(ETH_MINT);
    if (!eth) return null;
    const wei = BigInt(Math.floor((afterSpread(zecToUsd(zats, limits), limits) / eth) * 1e9)) * 1_000_000_000n - BASE_RESERVE_WEI;
    if (wei <= 0n) return 0;
    return units((await kyberRoute(NATIVE_ETH, t.mint, wei)).amountOut, t.decimals);
  };
}

export function BaseTokenScreen({ address }: { address: string }) {
  const { t, error } = useBaseToken(address);
  const [usd, setUsd] = useState<number | null>(null);
  const [buying, setBuying] = useState(false);
  useEffect(() => {
    if (t) baseUsdPrice(t).then(setUsd, () => {});
  }, [t?.mint]);
  if (!t) return <div className="screen"><TopBar title="" />{error ? <p className="empty">{error}</p> : <div className="skeleton" style={{ borderRadius: 22 }} />}</div>;
  return (
    <div className="screen">
      <TopBar title="" />
      <div className="row">
        <TokenIcon symbol={t.symbol} large />
        <div className="grow">
          <div className="eyebrow">Token on Base</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 26 }}>{t.name}</h1>
          <div className="muted">
            {t.symbol} {t.verified ? <span className="badge ok">✓ Listed</span> : <span className="badge caution">Unlisted</span>}
          </div>
        </div>
      </div>
      <div className="hero" style={{ textAlign: "left", padding: "18px 0 6px" }}>
        <div className="total num">{usd === null ? "–" : price(usd)}</div>
        <div className="faint small mono" style={{ wordBreak: "break-all" }}>{t.mint}</div>
      </div>
      {!t.verified && (
        <p className="faint">Not on Revolve's list: check this is the contract you meant. Anyone can deploy a token with any name.</p>
      )}
      <div className="dock">
        {BASE_BUYING ? (
          <button className="btn" onClick={() => setBuying(true)}>Buy {t.symbol}</button>
        ) : (
          <button className="btn" disabled>Buying on Base: coming soon</button>
        )}
      </div>
      <BuySheet open={buying} onClose={() => setBuying(false)} token={t} chain="base" estimate={baseEstimate(t)} />
    </div>
  );
}
