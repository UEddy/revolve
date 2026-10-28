// Hash routing: the static host serves one page, and nothing about where
// the user is in the app is ever sent anywhere.

import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "discover" }
  | { name: "token"; mint: string }
  | { name: "position"; id: string }
  | { name: "settings" }
  | { name: "fund" }
  | { name: "funding"; id: string }
  | { name: "market"; id: string }
  | { name: "nft"; symbol: string }
  | { name: "base" }
  | { name: "baseToken"; address: string };

export function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, "").split("/");
  if (a === "discover") return { name: "discover" };
  if (a === "t" && b) return { name: "token", mint: decodeURIComponent(b) };
  if (a === "p" && b) return { name: "position", id: b };
  if (a === "settings") return { name: "settings" };
  if (a === "fund" && b) return { name: "funding", id: b };
  if (a === "market" && b) return { name: "market", id: decodeURIComponent(b) };
  if (a === "nft" && b) return { name: "nft", symbol: decodeURIComponent(b) };
  if (a === "fund") return { name: "fund" };
  if (a === "base" && b) return { name: "baseToken", address: decodeURIComponent(b) };
  if (a === "base") return { name: "base" };
  return { name: "home" };
}

export const href = {
  home: "#/",
  discover: "#/discover",
  token: (mint: string) => `#/t/${encodeURIComponent(mint)}`,
  position: (id: string) => `#/p/${id}`,
  settings: "#/settings",
  fund: "#/fund",
  funding: (id: string) => `#/fund/${id}`,
  market: (id: string) => `#/market/${encodeURIComponent(id)}`,
  nft: (symbol: string) => `#/nft/${encodeURIComponent(symbol)}`,
  base: "#/base",
  baseToken: (address: string) => `#/base/${encodeURIComponent(address)}`,
};

export function go(to: string): void {
  location.hash = to;
}

export function back(fallback: string = href.home): void {
  if (history.length > 1) history.back();
  else go(fallback);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash));
      window.scrollTo(0, 0);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
