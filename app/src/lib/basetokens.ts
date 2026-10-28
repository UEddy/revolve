// Tokens offered on Base. A short, hand-checked list (every address passes its
// EIP-55 checksum, see core.test.ts), plus any token pasted by its contract
// address, whose name and decimals are read from the contract itself.

import type { TokenRef } from "./model.ts";

const t = (mint: string, symbol: string, name: string, decimals: number): TokenRef => ({ mint, symbol, name, decimals, isStock: false, verified: true });

export const BASE_TOKENS: TokenRef[] = [
  t("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", "USD Coin", 6),
  t("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "cbBTC", "Coinbase Wrapped BTC", 8),
  t("0x940181a94A35A4569E4529A3CDfB74e38FD98631", "AERO", "Aerodrome", 18),
  t("0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", "VIRTUAL", "Virtuals Protocol", 18),
  t("0x532f27101965dd16442E59d40670FaF5eBB142E4", "BRETT", "Brett", 18),
  t("0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", "DEGEN", "Degen", 18),
  t("0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", "TOSHI", "Toshi", 18),
];

export const baseToken = (address: string) => BASE_TOKENS.find((x) => x.mint === address);
