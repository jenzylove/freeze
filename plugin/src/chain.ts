// Arbitrum reads. One batched JSON-RPC request per tool call keeps hosted calls well inside 10 seconds.
// The public Arbitrum RPC rate limits bursts, so reads fall back to a second public RPC.
import { wordAt } from "./core.js";

const RPC = process.env.ARBITRUM_RPC ?? "https://arb1.arbitrum.io/rpc";
// Fallback for eth_call and balances. Its free plan can't search long log ranges, so logs stay on RPC.
const FALLBACK = process.env.ARBITRUM_RPC_FALLBACK ?? (process.env.ARBITRUM_RPC ? RPC : "https://arbitrum.drpc.org");
const TIMEOUT_MS = 3500;

export type Call = { to: string; data: string };

async function post(url: string, body: unknown): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`Arbitrum RPC returned HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("Arbitrum RPC timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Try the main RPC, then the fallback, accepting the first answer that passes `ok`. */
async function withFallback<T>(urls: string[], body: unknown, parse: (res: unknown) => T): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      return parse(await post(url, body));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export async function readMany(calls: Call[]): Promise<string[]> {
  const body = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  return withFallback([RPC, FALLBACK], body, (raw) => {
    const res = raw as { id: number; result?: string; error?: { message: string } }[];
    if (!Array.isArray(res)) throw new Error("Arbitrum RPC did not return a batch result");
    const byId = new Map(res.map((x) => [x.id, x]));
    return calls.map((_, i) => {
      const x = byId.get(i);
      if (!x || x.error || typeof x.result !== "string") {
        throw new Error(`Arbitrum read failed: ${x?.error?.message ?? "no result"}`);
      }
      return x.result;
    });
  });
}

export const first = (hex: string) => wordAt(hex, 0);

/** Token ids transferred to `to` on an ERC-721 since `fromBlock` (Transfer topic, indexed to + tokenId). */
export async function cardIdsSentTo(contract: string, to: string, fromBlock: number): Promise<bigint[]> {
  const topic0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const toTopic = "0x" + to.slice(2).toLowerCase().padStart(64, "0");
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getLogs",
    params: [{ address: contract, fromBlock: "0x" + fromBlock.toString(16), toBlock: "latest", topics: [topic0, null, toTopic] }],
  };
  // Same RPC twice: a rate limited burst usually clears on the retry.
  return withFallback([RPC, RPC], body, (raw) => {
    const res = raw as { result?: { topics: string[] }[]; error?: { message: string } };
    if (!res.result) throw new Error(`Arbitrum log read failed: ${res.error?.message ?? "no result"}`);
    return [...new Set(res.result.map((l) => BigInt(l.topics[3] ?? "0x0")))];
  });
}

/** Native ETH balance in wei. */
export async function ethBalance(who: string): Promise<bigint> {
  const body = { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [who, "latest"] };
  return withFallback([RPC, FALLBACK], body, (raw) => {
    const res = raw as { result?: string; error?: { message: string } };
    if (!res.result) throw new Error(`Arbitrum balance read failed: ${res.error?.message ?? "no result"}`);
    return BigInt(res.result);
  });
}

const BASE_RPCS = (process.env.BASE_RPC ?? "https://mainnet.base.org,https://base-rpc.publicnode.com").split(",");

/** Native ETH on Base in wei, or undefined if no Base RPC answered (best effort). */
export async function baseEthBalance(who: string): Promise<bigint | undefined> {
  const body = { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [who, "latest"] };
  try {
    return await withFallback(BASE_RPCS, body, (raw) => {
      const res = raw as { result?: string };
      if (!res.result) throw new Error("no result");
      return BigInt(res.result);
    });
  } catch {
    return undefined;
  }
}

/** USDC on Base in micro USDC, or undefined if no Base RPC answered (best effort). */
export async function baseUsdcBalance(who: string): Promise<bigint | undefined> {
  const data = "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0");
  const body = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data }, "latest"] };
  try {
    return await withFallback(BASE_RPCS, body, (raw) => {
      const res = raw as { result?: string };
      if (!res.result) throw new Error("no result");
      return BigInt(res.result);
    });
  } catch {
    return undefined;
  }
}
