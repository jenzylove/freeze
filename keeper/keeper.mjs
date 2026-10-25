// Freeze keeper. Runs every 30 minutes on GitHub Actions.
// 1. Finds every freeze card bought through Freeze (Hegic BTC/ETH calls bought with Freeze's exact call shape).
// 2. Cashes any card that opted into auto cash and is worth something in its last 6 hours.
//    The FreezeAutoCash contract always pays the card's owner; the keeper only pays gas.
// 3. Writes web/board.json, the public record of every freeze and how it ended.
// Usage: KEEPER_KEY=0x... node keeper.mjs   (without KEEPER_KEY it only reads and writes the board)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, id, formatUnits } from "ethers";

const RPC = process.env.ARBITRUM_RPC ?? "https://arb1.arbitrum.io/rpc";
const BOARD = new URL("../web/board.json", import.meta.url);
const START_BLOCK = 515_500_000; // Freeze launched after this block
const CHUNK = 2_000_000;

const TREASURY = "0xec096ea6eB9aa5ea689b0CF00882366E92377371";
const CARDS = "0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5";
const AUTOCASH = "0x679399608d973c2476d1D9ECd8eB1150e97936Ec";
const ASSETS = {
  "0x527d1086c3dd22fcdb338f69d47a1e4bfe11e539": { asset: "BTC", decimals: 8 },
  "0x2727b807d22fcaeb7f900f49894054ed92b9125b": { asset: "ETH", decimals: 18 },
};
const TRANSFER = id("Transfer(address,address,uint256)");
const PAID = id("Paid(uint256,address,uint256)");
const ZERO32 = "0x" + "0".repeat(64);

const provider = new JsonRpcProvider(RPC, 42161, { staticNetwork: true, batchMaxCount: 20 });
const treasury = new Contract(TREASURY, [
  "function lockedLiquidity(uint256) view returns (uint8 state, address strategy, uint128 negativepnl, uint128 positivepnl, uint32 expiration)",
], provider);
const cards = new Contract(CARDS, [
  "function ownerOf(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
], provider);
const strategyAbi = [
  "function strategyData(uint256) view returns (uint128 amount, uint128 strike)",
  "function payOffAmount(uint256) view returns (uint256)",
];
const autocashAbi = ["function cashable(uint256) view returns (bool)", "function cash(uint256)"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

async function logs(filter, from, to) {
  const out = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = Math.min(a + CHUNK - 1, to);
    out.push(...(await retry(() => provider.getLogs({ ...filter, fromBlock: a, toBlock: b }))));
  }
  return out;
}

// Freeze's buy() call: buy(strategy, holder, amount, period, bytes[] empty), nothing else.
const isFreezeBuy = (tx) =>
  tx?.to?.toLowerCase() === TREASURY.toLowerCase() &&
  tx.data.startsWith("0x0e5024d7") &&
  tx.data.length === 2 + 8 + 64 * 6 &&
  tx.data.endsWith("a0" + "0".repeat(64));

const usd = (v6) => Number(formatUnits(v6, 6));

async function main() {
  const prev = existsSync(BOARD) ? JSON.parse(readFileSync(BOARD, "utf8")) : { scannedTo: START_BLOCK - 1, cards: [] };
  const head = await retry(() => provider.getBlockNumber());
  const byId = new Map(prev.cards.map((c) => [c.card, c]));

  // New mints since the last run.
  const mints = await logs({ address: CARDS, topics: [TRANSFER, ZERO32] }, prev.scannedTo + 1, head);
  for (const l of mints) {
    const card = BigInt(l.topics[3]).toString();
    if (byId.has(card)) continue;
    const tx = await retry(() => provider.getTransaction(l.transactionHash));
    if (!isFreezeBuy(tx)) continue;
    const block = await retry(() => provider.getBlock(l.blockNumber));
    byId.set(card, { card, buyer: tx.from, opened: block.timestamp, buyTx: l.transactionHash });
  }

  // Payouts for our cards.
  const paid = await logs({ address: TREASURY, topics: [PAID] }, START_BLOCK, head);
  const payouts = new Map();
  for (const l of paid) {
    const card = BigInt(l.topics[1]).toString();
    if (!byId.has(card)) continue;
    const tx = await retry(() => provider.getTransaction(l.transactionHash));
    payouts.set(card, {
      paid: usd(BigInt(l.data)),
      paidTx: l.transactionHash,
      paidBy: tx.to?.toLowerCase() === AUTOCASH.toLowerCase() ? "auto cash" : "owner",
    });
  }

  // Refresh every card's live state.
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const base of byId.values()) {
    const n = BigInt(base.card);
    const ll = await retry(() => treasury.lockedLiquidity(n));
    const meta = ASSETS[ll.strategy.toLowerCase()];
    if (!meta) continue;
    const strategy = new Contract(ll.strategy, strategyAbi, provider);
    const [data, worth, owner] = await Promise.all([
      retry(() => strategy.strategyData(n)),
      retry(() => strategy.payOffAmount(n)),
      retry(() => cards.ownerOf(n)),
    ]);
    const autoOn = await retry(() => cards.isApprovedForAll(owner, AUTOCASH));
    const ends = Number(ll.expiration);
    const locked = Number(ll.state) === 1;
    const status = ends <= now ? (payouts.has(base.card) ? "cashed" : "ended") : locked ? "open" : "cashed";
    out.push({
      ...base,
      asset: meta.asset,
      amount: Number(formatUnits(data.amount, meta.decimals)),
      frozenPrice: Number(formatUnits(data.strike, 8)),
      fee: usd(ll.positivepnl),
      ends,
      status,
      worthNow: status === "open" ? usd(worth) : 0,
      autoCash: autoOn,
      ...(payouts.get(base.card) ?? {}),
    });
  }
  out.sort((a, b) => Number(b.card) - Number(a.card));

  // Cash winners in their last hours.
  const key = process.env.KEEPER_KEY;
  if (key) {
    const signer = new Wallet(key, provider);
    const autocash = new Contract(AUTOCASH, autocashAbi, signer);
    for (const c of out.filter((c) => c.status === "open" && c.autoCash && c.worthNow > 0 && c.ends - now <= 6 * 3600)) {
      try {
        if (!(await retry(() => autocash.cashable(BigInt(c.card))))) continue;
        const tx = await autocash.cash(BigInt(c.card));
        const rcpt = await tx.wait();
        console.log(`cashed card ${c.card} for ~$${c.worthNow} to its owner: ${rcpt.hash}`);
        Object.assign(c, { status: "cashed", paid: c.worthNow, paidTx: rcpt.hash, paidBy: "auto cash", worthNow: 0 });
      } catch (e) {
        console.error(`card ${c.card}: ${e.shortMessage ?? e.message}`);
      }
    }
  }

  const done = out.filter((c) => c.status !== "open");
  const board = {
    updated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    scannedTo: head,
    autoCashContract: AUTOCASH,
    totals: {
      freezes: out.length,
      people: new Set(out.map((c) => c.buyer.toLowerCase())).size,
      open: out.length - done.length,
      paidOut: Number(out.reduce((s, c) => s + (c.paid ?? 0), 0).toFixed(2)),
      feesPaid: Number(out.reduce((s, c) => s + c.fee, 0).toFixed(2)),
      won: done.filter((c) => (c.paid ?? 0) > 0).length,
      finished: done.length,
    },
    cards: out,
  };
  // Only rewrite when something real changed, so the repo isn't committed to every half hour.
  const strip = ({ updated, scannedTo, ...rest }) => JSON.stringify(rest);
  const live = (b) => strip({ ...b, cards: b.cards.map(({ worthNow, ...c }) => c) });
  if (!prev.updated || live(prev) !== live(board) || head - prev.scannedTo > 1_000_000) {
    writeFileSync(BOARD, JSON.stringify(board, null, 2) + "\n");
  }
  console.log(`board: ${out.length} freezes, ${board.totals.open} open, scanned to ${head}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
