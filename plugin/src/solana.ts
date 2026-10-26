// Solana reads before proposing a payment from the user's Solana wallet, so a missing SOL fee or
// too little USDC comes back as a plain sentence instead of a failed PayBox simulation.
// Every check is best effort: if the public RPCs are busy, the proposal goes ahead and PayBox simulates it.

const RPCS = (process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com").split(",");
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TIMEOUT_MS = 2500;

// A deposit costs 5,000 lamports; ask for a little headroom so a priority fee still fits.
export const MIN_LAMPORTS = 20_000;

async function rpc<T>(method: string, params: unknown[], only?: number): Promise<T | undefined> {
  for (const url of only === undefined ? RPCS : [RPCS[only]!]) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctl.signal,
      });
      const j = (await r.json()) as { result?: T };
      if (j.result !== undefined) return j.result;
    } catch {
      // try the next RPC
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

/** SOL balance in lamports, or undefined if no RPC answered. */
export async function lamports(owner: string): Promise<number | undefined> {
  const r = await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
  return r?.value;
}

/** USDC held by `owner` in micro USDC, or undefined if no RPC answered. Only the first RPC serves this index. */
export async function usdc(owner: string): Promise<bigint | undefined> {
  const r = await rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
    "getTokenAccountsByOwner",
    [owner, { mint: USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }],
    0,
  );
  if (!r) return undefined;
  return r.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

/** Simulate an unsigned transaction. Returns an error summary, null if it would succeed, undefined if unknown. */
export async function simulate(txBase64: string): Promise<string | null | undefined> {
  const r = await rpc<{ value: { err: unknown; logs?: string[] } }>("simulateTransaction", [
    txBase64,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  if (!r) return undefined;
  if (r.value.err === null) return null;
  const log = (r.value.logs ?? []).filter((l) => /error|insufficient|failed/i.test(l)).slice(-2).join(" ");
  return `${JSON.stringify(r.value.err)}${log ? ` (${log})` : ""}`;
}
