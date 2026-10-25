// Paying from another chain. Relay (api.relay.link) quotes a cross-chain deposit that lands
// USDC.e (and, when needed, a little ETH for network fees) in the user's Arbitrum wallet.
// The deposit runs from the user's own PayBox wallet on Solana or Base after one approval.

const RELAY = process.env.RELAY_API ?? "https://api.relay.link";
const TIMEOUT_MS = 6000;

export const CHAIN_ID = { solana: 792703809, base: 8453, arbitrum: 42161 } as const;
export const USDC = {
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;
const USDCE = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
const ETH = "0x0000000000000000000000000000000000000000";

export type From = keyof typeof USDC;

type EvmData = { to: string; data: string; value: string; chainId: number };
type SolanaIx = { programId: string; data: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
type Step = { id: string; items: { status: string; data: EvmData | { instructions: SolanaIx[] } }[] };

export type RelayQuote = {
  steps: Step[];
  payIn: string; // human amount of USDC the user pays
  usdceOut: bigint; // 6 decimals
  gasTopupUsd?: string;
  seconds?: number;
};

/**
 * Quote a deposit from `from` that delivers `usdce6` of USDC.e to `recipient` on Arbitrum.
 * With `gasUsd6`, Relay also delivers that many dollars of ETH for network fees. If `usdce6` is 0,
 * only ETH is delivered.
 */
export async function quote(opts: { from: From; user: string; recipient: string; usdce6: bigint; gasUsd6?: bigint; ethWei?: bigint }): Promise<RelayQuote> {
  const onlyGas = opts.usdce6 === 0n;
  const body: Record<string, unknown> = {
    user: opts.user,
    originChainId: CHAIN_ID[opts.from],
    destinationChainId: CHAIN_ID.arbitrum,
    originCurrency: USDC[opts.from],
    destinationCurrency: onlyGas ? ETH : USDCE,
    recipient: opts.recipient,
    amount: (onlyGas ? opts.ethWei ?? 0n : opts.usdce6).toString(),
    tradeType: "EXACT_OUTPUT",
  };
  if (!onlyGas && opts.gasUsd6 && opts.gasUsd6 > 0n) {
    body.topupGas = true;
    body.topupGasAmount = opts.gasUsd6.toString();
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${RELAY}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const j = (await r.json()) as {
      message?: string;
      steps?: Step[];
      details?: { currencyIn?: { amountFormatted?: string }; currencyOut?: { amount?: string }; currencyGasTopup?: { amountUsd?: string }; timeEstimate?: number };
    };
    if (!r.ok || !j.steps?.length) throw new Error(`Relay could not quote this transfer: ${j.message ?? `HTTP ${r.status}`}`);
    return {
      steps: j.steps,
      payIn: j.details?.currencyIn?.amountFormatted ?? "?",
      usdceOut: onlyGas ? 0n : BigInt(j.details?.currencyOut?.amount ?? "0"),
      gasTopupUsd: j.details?.currencyGasTopup?.amountUsd,
      seconds: j.details?.timeEstimate,
    };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("Relay timed out. Try again in a moment.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The first EVM step still to do (approve, then deposit), with how many are left. */
export function nextEvmStep(q: RelayQuote): { id: string; tx: EvmData; left: number } {
  const open = q.steps.filter((s) => s.items.some((i) => i.status === "incomplete"));
  const step = open[0];
  const item = step?.items.find((i) => i.status === "incomplete");
  if (!step || !item || !("to" in item.data)) throw new Error("Relay returned no EVM step to sign.");
  return { id: step.id, tx: item.data, left: open.length };
}

/** The Solana deposit instructions Relay returned. */
export function solanaInstructions(q: RelayQuote): SolanaIx[] {
  const item = q.steps.flatMap((s) => s.items).find((i) => i.status === "incomplete");
  if (!item || !("instructions" in item.data)) throw new Error("Relay returned no Solana instructions.");
  return item.data.instructions;
}

// ---------- Unsigned legacy Solana transaction ----------
// PayBox replaces the blockhash before simulation, so a zero placeholder is used and no
// Solana RPC is needed. One signer (the user), who is also the fee payer.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error(`Not base58: ${s}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const hexBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

export function buildSolanaTx(feePayer: string, ixs: SolanaIx[]): string {
  type Meta = { signer: boolean; writable: boolean };
  const metas = new Map<string, Meta>();
  const touch = (k: string, signer: boolean, writable: boolean) => {
    const m = metas.get(k) ?? { signer: false, writable: false };
    metas.set(k, { signer: m.signer || signer, writable: m.writable || writable });
  };
  touch(feePayer, true, true);
  for (const ix of ixs) {
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable);
    touch(ix.programId, false, false);
  }
  for (const [k, m] of metas) if (m.signer && k !== feePayer) throw new Error("This transfer needs a second signer, which PayBox does not allow.");

  const rest = [...metas.entries()].filter(([k]) => k !== feePayer);
  const rank = ([, m]: [string, Meta]) => (m.signer ? (m.writable ? 0 : 1) : m.writable ? 2 : 3);
  rest.sort((a, b) => rank(a) - rank(b));
  const keys = [feePayer, ...rest.map(([k]) => k)];
  const index = new Map(keys.map((k, i) => [k, i]));
  const readonlyUnsigned = rest.filter(([, m]) => !m.signer && !m.writable).length;

  const msg: number[] = [1, 0, readonlyUnsigned];
  msg.push(...compactU16(keys.length));
  for (const k of keys) {
    const b = b58decode(k);
    if (b.length !== 32) throw new Error(`Bad Solana address: ${k}`);
    msg.push(...b);
  }
  msg.push(...new Array(32).fill(0)); // blockhash placeholder, replaced by PayBox
  msg.push(...compactU16(ixs.length));
  for (const ix of ixs) {
    msg.push(index.get(ix.programId)!);
    msg.push(...compactU16(ix.keys.length));
    for (const k of ix.keys) msg.push(index.get(k.pubkey)!);
    const data = hexBytes(ix.data);
    msg.push(...compactU16(data.length));
    msg.push(...data);
  }
  const tx = Uint8Array.from([...compactU16(1), ...new Array(64).fill(0), ...msg]);
  if (tx.length > 1232) throw new Error("The Solana transfer is too large for one transaction.");
  return Buffer.from(tx).toString("base64");
}
