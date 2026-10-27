// The narration, one block per scene, exactly as recorded in
// ~/revolve-media/voiceover.mp3. scripts/probe.mjs splits the recording at its
// silences and matches the pieces to these blocks, in order.

export const SCRIPT = [
  { id: "story", vo: "Every wallet tells a story. What you bought. When you bought it. Who you are." },
  { id: "problem", vo: "Zcash was built to keep that story private. But the moment you spend it anywhere else, the bridge gives you away. Every route out of Zcash today deshields. Your amount. Your timing. In public. Forever." },
  { id: "reveal", vo: "This is Revolve. Spend shielded ZEC on anything in crypto, without ever leaving the shielded pool." },
  { id: "fund", vo: "Fund it once from your Zcash wallet. Your deposit lands in the shielded pool, and comes back as private credits. They're blind signed, so even we can't link what you spend to what you paid." },
  { id: "buy", vo: "Find a token, a stock, anything. One tap, one fingerprint. Every purchase lands in its own fresh wallet, sealed on your phone. No accounts. No seed phrase. No chains to choose." },
  { id: "cashout", vo: "When you're done, cash out. Straight back into shielded ZEC." },
  { id: "proof", vo: "On the left, a normal bridge. Everything visible. On the right, a Revolve deposit. Nothing to see. Live on mainnet. With real funds." },
  { id: "range", vo: "Memecoins. Stocks. Prediction markets. Collectibles. Across Solana, Ethereum and Robinhood Chain." },
  { id: "close", vo: "Revolve. Buy anything. Leave no trail." },
] as const;

export type SceneId = (typeof SCRIPT)[number]["id"];
