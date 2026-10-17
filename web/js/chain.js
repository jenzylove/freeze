// Live reads from Arbitrum. Math copied from plugin/src/core.ts.
export const RPC = "https://arb1.arbitrum.io/rpc";
export const HEGIC = {
  treasury: "0xec096ea6eB9aa5ea689b0CF00882366E92377371",
  cards: "0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5",
};
export const ASSETS = {
  BTC: { strategy: "0x527d1086C3DD22FcdB338F69D47A1e4bFE11E539", feed: "0x6ce185860a4963106506C203335A2910413708e9", decimals: 8, minDays: 7, maxDays: 14 },
  ETH: { strategy: "0x2727B807D22fCAeB7F900F49894054Ed92b9125B", feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", decimals: 18, minDays: 60, maxDays: 90 },
};
export const SEL = {
  latestRoundData: "0xfeaf968c",
  calculate: "0xd666b433",
  payOffAmount: "0x72e08c41",
  strategyData: "0xd6c8d1b4",
  ownerOf: "0x6352211e",
  lockedLiquidity: "0x3755269b",
};
const PRICE_DECIMALS = 8n;
const USDC_DECIMALS = 6n;
const DAY = 86400;

export const word = (v) => BigInt(v).toString(16).padStart(64, "0");

export function usdToUnits(usd, price1e8, decimals) {
  const usdCents = BigInt(Math.round(usd * 100));
  return (usdCents * 10n ** BigInt(decimals) * 10n ** PRICE_DECIMALS) / (100n * price1e8);
}
export function unitsToUsd6(units, price1e8, decimals) {
  return (units * price1e8 * 10n ** USDC_DECIMALS) / (10n ** BigInt(decimals) * 10n ** PRICE_DECIMALS);
}
export function breakEven1e8(strike1e8, fee6, units, decimals) {
  return strike1e8 + (fee6 * 10n ** BigInt(decimals) * 10n ** PRICE_DECIMALS) / (units * 10n ** USDC_DECIMALS);
}
export function payout6(price1e8, strike1e8, units, decimals) {
  if (price1e8 <= strike1e8) return 0n;
  return ((price1e8 - strike1e8) * units * 10n ** USDC_DECIMALS) / (10n ** BigInt(decimals) * 10n ** PRICE_DECIMALS);
}
export function encodeCalculate(amount, period) {
  return SEL.calculate + word(amount) + word(period) + word(0x60n) + word(0n);
}
export function words(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length === 0 || h.length % 64 !== 0) throw new Error("Malformed call result");
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64)));
  return out;
}
export const int256 = (v) => (v >= 1n << 255n ? v - (1n << 256n) : v);
export const periodSeconds = (days) => BigInt(days * DAY);

/* Formatting. All take bigint. */
export function usd6(v) {
  const cents = (v + 5000n) / 10000n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return "$" + whole.toLocaleString("en-US") + "." + frac;
}
export const usd8 = (v) => usd6(v / 100n);
export function units(v, decimals, places = 6) {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, places).replace(/0+$/, "");
  return frac ? whole + "." + frac : whole;
}
export const shortAddr = (a) => a.slice(0, 6) + "..." + a.slice(-4);

/* One batched JSON-RPC request. calls: [{to, data}]. Returns [{ok, result|error}] in order. Throws if the network fails. */
export async function batch(calls) {
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"] }));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let res;
  try {
    res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new Error("Could not reach the Arbitrum RPC.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error("The Arbitrum RPC answered with an error (" + res.status + ").");
  let json;
  try { json = await res.json(); } catch (e) { throw new Error("The Arbitrum RPC sent something unreadable."); }
  if (!Array.isArray(json)) throw new Error("The Arbitrum RPC refused the batch.");
  const byId = new Map(json.map((r) => [r.id, r]));
  return calls.map((_, i) => {
    const r = byId.get(i + 1);
    if (!r) return { ok: false, error: "No answer" };
    if (r.error) return { ok: false, error: r.error.message || "Reverted" };
    return { ok: true, result: r.result };
  });
}

/* Chainlink read: returns {price (1e8 bigint), updatedAt (seconds)}. */
export function parsePrice(r) {
  if (!r.ok) throw new Error("Price feed read failed.");
  const w = words(r.result);
  const price = int256(w[1]);
  if (price <= 0n) throw new Error("Price feed returned a bad value.");
  return { price, updatedAt: Number(w[3]) };
}
export const priceCall = (asset) => ({ to: ASSETS[asset].feed, data: SEL.latestRoundData });

export const arbiscan = (kind, v) => "https://arbiscan.io/" + kind + "/" + v;
export const clock = (d = new Date()) => d.toLocaleTimeString("en-GB", { hour12: false });

/* Frozen price ticker: digits churn, then settle on the real value. */
export function freezeText(el, finalText, ms = 1400) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.classList.remove("is-frozen");
  if (reduce) { el.textContent = finalText; el.classList.add("is-frozen"); return; }
  const start = performance.now();
  const chars = finalText.split("");
  function tick(now) {
    const t = Math.min(1, (now - start) / ms);
    const settled = Math.floor(t * chars.length);
    el.textContent = chars.map((c, i) => (/\d/.test(c) && i >= settled ? String(Math.floor(Math.random() * 10)) : c)).join("");
    if (t < 1) requestAnimationFrame(tick);
    else { el.textContent = finalText; el.classList.add("is-frozen"); }
  }
  requestAnimationFrame(tick);
}
