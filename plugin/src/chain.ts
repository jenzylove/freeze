// Arbitrum reads. One batched JSON-RPC request per tool call keeps hosted calls well inside 10 seconds.
import { wordAt } from "./core.js";

const RPC = process.env.ARBITRUM_RPC ?? "https://arb1.arbitrum.io/rpc";
const TIMEOUT_MS = 4000;

export type Call = { to: string; data: string };

export async function readMany(calls: Call[]): Promise<string[]> {
  const body = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`Arbitrum RPC returned HTTP ${r.status}`);
    const res = (await r.json()) as { id: number; result?: string; error?: { message: string } }[];
    if (!Array.isArray(res)) throw new Error("Arbitrum RPC did not return a batch result");
    const byId = new Map(res.map((x) => [x.id, x]));
    return calls.map((_, i) => {
      const x = byId.get(i);
      if (!x || x.error || typeof x.result !== "string") {
        throw new Error(`Arbitrum read failed: ${x?.error?.message ?? "no result"}`);
      }
      return x.result;
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("Arbitrum RPC timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const first = (hex: string) => wordAt(hex, 0);
