// Pure logic for Freeze: no network. Every number the plugin shows is computed here
// from values read on chain, so it can be tested without RPC.

export const ARBITRUM = "eip155:42161" as const;

export const HEGIC = {
  treasury: "0xec096ea6eB9aa5ea689b0CF00882366E92377371", // OperationalTreasury: buy(), payOff()
  cards: "0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5", // PositionsManager: one ERC-721 card per freeze
  usdce: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // settlement token, 6 decimals
} as const;

/** FreezeAutoCash: cashes a winning card in its last 6 hours, always to the card's owner. */
export const AUTOCASH = "0x679399608d973c2476d1D9ECd8eB1150e97936Ec";

export type Asset = "BTC" | "ETH";

export const ASSETS: Record<
  Asset,
  { strategy: string; feed: string; decimals: number; minDays: number; maxDays: number }
> = {
  // Plain calls only. Lengths are what each Hegic strategy accepts (minPeriod/maxPeriod on chain).
  BTC: {
    strategy: "0x527d1086C3DD22FcdB338F69D47A1e4bFE11E539",
    feed: "0x6ce185860a4963106506C203335A2910413708e9",
    decimals: 8,
    minDays: 7,
    maxDays: 14,
  },
  ETH: {
    strategy: "0x2727B807D22fCAeB7F900F49894054Ed92b9125B",
    feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
    decimals: 18,
    minDays: 60,
    maxDays: 90,
  },
};

export const MIN_USD = 2;
export const MAX_USD = 500;
const DAY = 86400;
const PRICE_DECIMALS = 8n; // Chainlink USD feeds
const USDC_DECIMALS = 6n;

/** Pick a length the market sells. Returns the days used and, if changed, why. */
export function pickDays(asset: Asset, requested?: number): { days: number; note?: string } {
  const { minDays, maxDays } = ASSETS[asset];
  if (requested === undefined) return { days: minDays };
  const whole = Math.round(requested);
  if (whole < minDays)
    return { days: minDays, note: `${asset} freezes run ${minDays} to ${maxDays} days, so this one is ${minDays} days.` };
  if (whole > maxDays)
    return { days: maxDays, note: `${asset} freezes run ${minDays} to ${maxDays} days, so this one is ${maxDays} days.` };
  return { days: whole };
}

/** USD amount -> asset base units at a Chainlink price (8 decimals). Rounds down. */
export function usdToUnits(usd: number, price1e8: bigint, decimals: number): bigint {
  if (!(usd > 0) || price1e8 <= 0n) throw new Error("Amount and price must be positive.");
  const usdCents = BigInt(Math.round(usd * 100));
  return (usdCents * 10n ** BigInt(decimals) * 10n ** PRICE_DECIMALS) / (100n * price1e8);
}

/** Base units -> USD value (6 decimals) at a price (8 decimals). */
export function unitsToUsd6(units: bigint, price1e8: bigint, decimals: number): bigint {
  return (units * price1e8 * 10n ** USDC_DECIMALS) / (10n ** BigInt(decimals) * 10n ** PRICE_DECIMALS);
}

/** Price at which the freeze pays back its own fee: strike + fee / amount. 8 decimals. */
export function breakEven1e8(strike1e8: bigint, fee6: bigint, units: bigint, decimals: number): bigint {
  if (units <= 0n) throw new Error("Amount must be positive.");
  return strike1e8 + (fee6 * 10n ** BigInt(decimals) * 10n ** PRICE_DECIMALS) / (units * 10n ** USDC_DECIMALS);
}

/** What the card pays now: (price − strike) × amount, never negative. 6 decimals. */
export function payout6(price1e8: bigint, strike1e8: bigint, units: bigint, decimals: number): bigint {
  if (price1e8 <= strike1e8) return 0n;
  return ((price1e8 - strike1e8) * units * 10n ** USDC_DECIMALS) / (10n ** BigInt(decimals) * 10n ** PRICE_DECIMALS);
}

/** Smallest allowance asked for: $5, so the first approval also covers the next few freezes (one tap each). */
export const MIN_ALLOWANCE6 = 5_000_000n;

/** Allowance to request: fee plus 5% for the price moving between approve and buy, rounded up, never under $5. */
export function allowanceFor(fee6: bigint): bigint {
  const need = (fee6 * 105n + 99n) / 100n;
  return need > MIN_ALLOWANCE6 ? need : MIN_ALLOWANCE6;
}

export const periodSeconds = (days: number) => BigInt(days * DAY);

export function endDateIso(nowSec: number, days: number): string {
  return new Date((nowSec + days * DAY) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function usd6(v: bigint): string {
  const cents = (v + 5000n) / 10000n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${frac}`;
}

export function usd8(v: bigint): string {
  return usd6(v / 100n);
}

export function units(v: bigint, decimals: number, places = 6): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ---------- ABI encoding (static words + one empty bytes[]) ----------

const word = (v: bigint) => {
  if (v < 0n) throw new Error("negative word");
  return v.toString(16).padStart(64, "0");
};
const addr = (a: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Not an address: ${a}`);
  return a.slice(2).toLowerCase().padStart(64, "0");
};

export const SEL = {
  latestRoundData: "0xfeaf968c",
  calculate: "0xd666b433", // calculateNegativepnlAndPositivepnl(uint256,uint256,bytes[])
  lockedLimit: "0xd3d5c121",
  locked: "0xd03d4aee", // getLockedByStrategy()
  allowance: "0xdd62ed3e",
  balanceOf: "0x70a08231",
  approve: "0x095ea7b3",
  buy: "0x0e5024d7", // buy(address,address,uint256,uint256,bytes[])
  payOff: "0x914fb518", // payOff(uint256,address)
  payOffAmount: "0x72e08c41",
  strategyData: "0xd6c8d1b4",
  positionExpiration: "0x90e4144e",
  ownerOf: "0x6352211e",
  safeTransferFrom: "0x42842e0e", // safeTransferFrom(address,address,uint256)
  lockedLiquidity: "0x3755269b",
  setApprovalForAll: "0xa22cb465",
  isApprovedForAll: "0xe985e9c5",
} as const;

export function encodeCalculate(amount: bigint, period: bigint): string {
  return SEL.calculate + word(amount) + word(period) + word(0x60n) + word(0n);
}

export function encodeBuy(strategy: string, holder: string, amount: bigint, period: bigint): string {
  return SEL.buy + addr(strategy) + addr(holder) + word(amount) + word(period) + word(0xa0n) + word(0n);
}

export function encodeApprove(spender: string, amount: bigint): string {
  return SEL.approve + addr(spender) + word(amount);
}

export function encodeAllowance(owner: string, spender: string): string {
  return SEL.allowance + addr(owner) + addr(spender);
}

export function encodeBalanceOf(owner: string): string {
  return SEL.balanceOf + addr(owner);
}

export function encodePayOff(card: bigint, to: string): string {
  return SEL.payOff + word(card) + addr(to);
}

export function encodeTransfer(from: string, to: string, card: bigint): string {
  return SEL.safeTransferFrom + addr(from) + addr(to) + word(card);
}

export function encodeSetApprovalForAll(operator: string, on: boolean): string {
  return SEL.setApprovalForAll + addr(operator) + word(on ? 1n : 0n);
}

export function encodeIsApprovedForAll(owner: string, operator: string): string {
  return SEL.isApprovedForAll + addr(owner) + addr(operator);
}

export function encodeUint(sel: string, v: bigint): string {
  return sel + word(v);
}

export const UNISWAP = {
  router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // SwapRouter02 on Arbitrum
  weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  fee: 500n, // WETH/USDC.e 0.05% pool 0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443
} as const;

/** exactInputSingle: ETH sent as value, USDC.e out to `to`, never less than minOut. */
export function encodeSwapEthToUsdce(to: string, amountIn: bigint, minOut: bigint): string {
  return (
    "0x04e45aaf" +
    addr(UNISWAP.weth) +
    addr(HEGIC.usdce) +
    word(UNISWAP.fee) +
    addr(to) +
    word(amountIn) +
    word(minOut) +
    word(0n)
  );
}

/** USD (6 decimals) -> wei at an ETH price (8 decimals). Rounds up so the swap covers the target. */
export function usd6ToWei(usd6: bigint, price1e8: bigint): bigint {
  return (usd6 * 10n ** 20n + price1e8 - 1n) / price1e8;
}

/** Split an eth_call result into 32-byte words. */
export function words(hex: string): bigint[] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 64 !== 0) throw new Error("Malformed call result");
  const out: bigint[] = [];
  for (let i = 0; i < h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64)));
  return out;
}

/** The i-th word of a call result, or an error if the result is shorter. */
export function wordAt(hex: string, i: number): bigint {
  const w = words(hex)[i];
  if (w === undefined) throw new Error("Call result too short");
  return w;
}

/** Interpret a word as a signed int256 (Chainlink answers). */
export function int256(v: bigint): bigint {
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}
