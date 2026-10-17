import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { evmOutputSchema, proposeEvm } from "./paybox.js";
import { cardIdsSentTo, first, readMany } from "./chain.js";
import {
  ARBITRUM,
  ASSETS,
  HEGIC,
  MAX_USD,
  MIN_USD,
  SEL,
  allowanceFor,
  breakEven1e8,
  encodeAllowance,
  encodeApprove,
  encodeBalanceOf,
  encodeBuy,
  encodeCalculate,
  encodePayOff,
  encodeTransfer,
  encodeUint,
  encodeSwapEthToUsdce,
  usd6ToWei,
  UNISWAP,
  endDateIso,
  int256,
  periodSeconds,
  pickDays,
  units,
  usd6,
  usd8,
  usdToUnits,
  wordAt,
  type Asset,
} from "./core.js";

const PROTOCOL_VERSION = "2026-07-28";

const asset = z.enum(["BTC", "ETH"]).describe("What to freeze: BTC (7 to 14 days) or ETH (60 to 90 days).");
const usd = z
  .number()
  .min(MIN_USD)
  .max(MAX_USD)
  .describe(`How many US dollars' worth to freeze, ${MIN_USD} to ${MAX_USD}.`);
const days = z
  .number()
  .int()
  .min(1)
  .max(365)
  .optional()
  .describe("How long to keep the price frozen. BTC: 7 to 14 days. ETH: 60 to 90 days. Other values are moved into range.");
const sender = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe("The selected PayBox EVM wallet's public address. Fill it in yourself from the wallet you use for this call; never ask the user to type it. Freeze cards are sent to and read from this wallet.");

type Quote = {
  asset: Asset;
  days: number;
  note?: string;
  price: bigint; // 8 decimals
  amount: bigint; // asset base units
  fee: bigint; // USDC.e, 6 decimals
  collateral: bigint;
  capacity: bigint;
};

async function quote(a: Asset, dollars: number, wantDays?: number): Promise<Quote> {
  const cfg = ASSETS[a];
  const picked = pickDays(a, wantDays);
  const [feedHex] = await readMany([{ to: cfg.feed, data: SEL.latestRoundData }]);
  const price = int256(wordAt(feedHex!, 1));
  if (price <= 0n) throw new Error(`The ${a} price feed returned no price.`);
  const amount = usdToUnits(dollars, price, cfg.decimals);
  const [calcHex, limitHex, lockedHex] = await readMany([
    { to: cfg.strategy, data: encodeCalculate(amount, periodSeconds(picked.days)) },
    { to: cfg.strategy, data: SEL.lockedLimit },
    { to: cfg.strategy, data: SEL.locked },
  ]);
  const collateral = wordAt(calcHex!, 0);
  const fee = wordAt(calcHex!, 1);
  const capacity = first(limitHex!) - first(lockedHex!);
  return { asset: a, days: picked.days, note: picked.note, price, amount, fee, collateral, capacity };
}

function describe(q: Quote) {
  const cfg = ASSETS[q.asset];
  const ends = endDateIso(Math.floor(Date.now() / 1000), q.days);
  const breakEven = breakEven1e8(q.price, q.fee, q.amount, cfg.decimals);
  return {
    asset: q.asset,
    amount: `${units(q.amount, cfg.decimals, cfg.decimals === 8 ? 8 : 6)} ${q.asset}`,
    frozen_price: usd8(q.price),
    fee: usd6(q.fee),
    days: q.days,
    ends_utc: ends,
    break_even_price: usd8(breakEven),
    max_loss: usd6(q.fee),
    available: q.capacity >= q.collateral,
    ...(q.note ? { note: q.note } : {}),
  };
}

const quoteOutput = z
  .object({
    asset: z.enum(["BTC", "ETH"]),
    amount: z.string(),
    frozen_price: z.string(),
    fee: z.string(),
    days: z.number().int(),
    ends_utc: z.string(),
    break_even_price: z.string(),
    max_loss: z.string(),
    available: z.boolean(),
    note: z.string().optional(),
  })
  .strict();

function createServer() {
  const server = new McpServer({ name: "freeze", version: "0.1.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool(
    "freeze_quote",
    {
      title: "Freeze: price to lock today's price",
      description:
        "Free. Use this when the user wants to buy bitcoin (BTC) or ether (ETH) but can't or won't right now: waiting for payday or salary, cash tied up, or scared to miss the rebound after a dip. " +
        "Also for: buy the dip later, lock a price, price lock, call option, keep the upside without buying. " +
        "It tells them what it costs to freeze today's BTC or ETH price for a dollar amount, read live from the Hegic options market on Arbitrum. " +
        "A freeze is the right, until the end date, to be paid the difference if the price rises above today's price. " +
        "The most the user can lose is the fee. Use this before freeze_lock and show the user the fee, frozen price, end date and break-even price in plain words.",
      inputSchema: z.object({ asset, usd, days }).strict(),
      outputSchema: quoteOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ asset: a, usd: dollars, days: d }) => {
      const out = describe(await quote(a, dollars, d));
      const text =
        `${out.fee} freezes ${out.asset} at ${out.frozen_price} on ${out.amount} (about $${dollars}) for ${out.days} days, until ${out.ends_utc}. ` +
        `If ${out.asset} is above ${out.frozen_price} when it's used, the freeze pays the difference in USDC; it pays for itself above ${out.break_even_price}. ` +
        `Most you can lose: ${out.max_loss}. To collect, cash it before ${out.ends_utc}; after the end date it can't be cashed.` +
        (out.available ? "" : " The market can't sell a freeze this size right now; try a smaller amount.") +
        (out.note ? ` ${out.note}` : "");
      return { content: [{ type: "text" as const, text }], structuredContent: out };
    },
  );

  server.registerTool(
    "freeze_approve",
    {
      title: "Freeze: allow the fee to be paid (first time)",
      description:
        "Proposes a one-time USDC.e allowance on Arbitrum so the freeze fee can be paid. freeze_lock returns this same step on its own when the allowance is missing, so calling this directly is optional. " +
        "The allowance is at least $5, so it also covers the next few freezes. Nothing is bought by this step.",
      inputSchema: z.object({ asset, usd, days, sender }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ asset: a, usd: dollars, days: d, sender: who }) => {
      const q = await quote(a, dollars, d);
      const need = allowanceFor(q.fee);
      const [allowHex] = await readMany([{ to: HEGIC.usdce, data: encodeAllowance(who, HEGIC.treasury) }]);
      if (first(allowHex!) >= need) throw new Error("No approval needed: the allowance already covers this fee. Call freeze_lock.");
      const proposal = proposeEvm({ chain: ARBITRUM, to: HEGIC.usdce, value: "0", data: encodeApprove(HEGIC.treasury, need) });
      return {
        ...proposal,
        content: [
          {
            type: "text" as const,
            text: `Allow Hegic's options pool on Arbitrum to take freeze fees from this wallet, up to ${usd6(need)} USDC.e in total. This covers today's ${usd6(q.fee)} fee and the next few freezes. Nothing is bought yet. Approve in PayBox, then call freeze_lock.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "freeze_lock",
    {
      title: "Freeze: lock today's price",
      description:
        "Proposes buying the freeze on Arbitrum: one transaction that pays the fee in USDC.e and sends a freeze card (an NFT) to the owner. " +
        "Quote first with freeze_quote and get the user's go-ahead. This is the only tool needed to freeze: if the wallet first needs USDC.e for the fee or needs to allow the fee, it returns that transaction instead. " +
        "Each time PayBox confirms one, call freeze_lock again with the same arguments until it returns the freeze itself. Tell the user how many approvals are left.",
      inputSchema: z.object({ asset, usd, days, sender }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ asset: a, usd: dollars, days: d, sender: who }) => {
      const q = await quote(a, dollars, d);
      if (q.capacity < q.collateral) throw new Error("The market can't sell a freeze this size right now. Try a smaller amount.");
      const [balHex, allowHex] = await readMany([
        { to: HEGIC.usdce, data: encodeBalanceOf(who) },
        { to: HEGIC.usdce, data: encodeAllowance(who, HEGIC.treasury) },
      ]);
      const bal = first(balHex!);
      const allowed = first(allowHex!) >= q.fee;
      if (bal < q.fee) {
        // No USDC.e for the fee yet: swap a little ETH first (at least $1, so a few freezes are covered).
        const target = q.fee + 100_000n > 1_000_000n ? q.fee + 100_000n : 1_000_000n;
        const [feedHex] = await readMany([{ to: ASSETS.ETH.feed, data: SEL.latestRoundData }]);
        const wei = usd6ToWei(target, int256(wordAt(feedHex!, 1)));
        const minOut = (target * 98n) / 100n;
        return {
          ...proposeEvm({ chain: ARBITRUM, to: UNISWAP.router, value: wei.toString(), data: encodeSwapEthToUsdce(who, wei, minOut) }),
          content: [
            {
              type: "text" as const,
              text: `Step 1 of ${allowed ? 2 : 3}: the fee is paid in USDC.e and this wallet has ${usd6(bal)}. Swap ${units(wei, 18, 8)} ETH (about ${usd6(target)}) for at least ${usd6(minOut)} USDC.e on Uniswap. Nothing is frozen yet. Approve in PayBox; once it confirms, call freeze_lock again with the same arguments.`,
            },
          ],
        };
      }
      if (!allowed) {
        // First freeze from this wallet: hand back the allowance step so the agent never dead ends.
        const need = allowanceFor(q.fee);
        return {
          ...proposeEvm({ chain: ARBITRUM, to: HEGIC.usdce, value: "0", data: encodeApprove(HEGIC.treasury, need) }),
          content: [
            {
              type: "text" as const,
              text: `Next step: allow Hegic's options pool to take freeze fees from this wallet, up to ${usd6(need)} USDC.e in total. This covers today's ${usd6(q.fee)} fee and the next few freezes, so later ones need one approval. Nothing is bought yet. Approve in PayBox; once it confirms, call freeze_lock again with the same arguments.`,
            },
          ],
        };
      }
      const out = describe(q);
      const proposal = proposeEvm({
        chain: ARBITRUM,
        to: HEGIC.treasury,
        value: "0",
        data: encodeBuy(ASSETS[a].strategy, who, q.amount, periodSeconds(q.days)),
      });
      return {
        ...proposal,
        content: [
          {
            type: "text" as const,
            text: `Last step: freeze ${out.asset} at ${out.frozen_price} on ${out.amount} for ${out.days} days, fee about ${out.fee} (the market sets the exact fee when it goes through). The freeze card goes to ${who}. Approve in PayBox; once it confirms, call freeze_cards to show the card and its link.`,
          },
        ],
      };
    },
  );

  const cardOutput = z
    .object({
      card: z.string(),
      asset: z.enum(["BTC", "ETH"]),
      amount: z.string(),
      frozen_price: z.string(),
      price_now: z.string(),
      worth_now: z.string(),
      fee_paid: z.string(),
      ends_utc: z.string(),
      active: z.boolean(),
      link: z.string(),
    })
    .strict();

  server.registerTool(
    "freeze_cards",
    {
      title: "Freeze: my freeze cards",
      description:
        "Free. Lists the freeze cards an address holds, with the frozen price, today's price, what each is worth right now, when it ends and a link to its live card page. Read live from Arbitrum. " +
        "A card must be cashed with freeze_use before it ends; after the end date it pays nothing, so warn the user about any card that is worth something and ends soon. Always show each card's link.",
      inputSchema: z.object({ sender }).strict(),
      outputSchema: z.object({ cards: z.array(cardOutput) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ sender: who }) => {
      const ids = await cardIdsSentTo(HEGIC.cards, who, FREEZE_START_BLOCK);
      const cards = [];
      for (const id of ids.slice(-20)) {
        const c = await readCard(id).catch(() => null);
        if (c && c.owner.toLowerCase() === who.toLowerCase()) cards.push(c.view);
      }
      const text = cards.length
        ? cards
            .map(
              (c) =>
                `Card ${c.card}: ${c.amount} frozen at ${c.frozen_price}, now ${c.price_now}, worth ${c.worth_now}, ${c.active ? `ends ${c.ends_utc}` : "ended"}.` +
                (c.active && c.worth_now !== "$0.00" ? " Cash it with freeze_use before it ends or the payout is lost." : "") +
                ` Live card and reminder: ${c.link}`,
            )
            .join("\n")
        : "No freeze cards found for this address.";
      return { content: [{ type: "text" as const, text }], structuredContent: { cards } };
    },
  );

  server.registerTool(
    "freeze_use",
    {
      title: "Freeze: use a freeze card",
      description:
        "Proposes cashing a freeze card: if the price is above the frozen price, the market pays the difference in USDC.e to the card's owner. Only the owner can do this. If it's worth nothing right now it says so instead.",
      inputSchema: z.object({ card: z.string().regex(/^\d{1,12}$/).describe("Freeze card number."), sender }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ card, sender: who }) => {
      const c = await readCard(BigInt(card));
      if (c.owner.toLowerCase() !== who.toLowerCase()) throw new Error(`Card ${card} belongs to ${c.owner}, not ${who}.`);
      if (!c.view.active) throw new Error(`Card ${card} has ended.`);
      if (c.payout === 0n)
        throw new Error(`Card ${card} is worth nothing right now: ${c.view.asset} is ${c.view.price_now}, at or below the frozen ${c.view.frozen_price}. Keep it until it ends or the price rises.`);
      const proposal = proposeEvm({ chain: ARBITRUM, to: HEGIC.treasury, value: "0", data: encodePayOff(BigInt(card), who) });
      return {
        ...proposal,
        content: [{ type: "text" as const, text: `Cash card ${card} for about ${c.view.worth_now} in USDC.e (${c.view.asset} ${c.view.price_now} vs frozen ${c.view.frozen_price}). Approve in PayBox.` }],
      };
    },
  );

  server.registerTool(
    "freeze_gift",
    {
      title: "Freeze: give a freeze card to someone",
      description: "Proposes sending a freeze card (and everything it's worth) to another address. Only the owner can send it.",
      inputSchema: z
        .object({
          card: z.string().regex(/^\d{1,12}$/).describe("Freeze card number."),
          sender,
          to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Address to give the card to."),
        })
        .strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ card, sender: who, to }) => {
      const c = await readCard(BigInt(card));
      if (c.owner.toLowerCase() !== who.toLowerCase()) throw new Error(`Card ${card} belongs to ${c.owner}, not ${who}.`);
      const proposal = proposeEvm({ chain: ARBITRUM, to: HEGIC.cards, value: "0", data: encodeTransfer(who, to, BigInt(card)) });
      return {
        ...proposal,
        content: [{ type: "text" as const, text: `Give freeze card ${card} (${c.view.amount} frozen at ${c.view.frozen_price}) to ${to}. Approve in PayBox.` }],
      };
    },
  );

  server.registerTool(
    "freeze_fund",
    {
      title: "Freeze: get USDC.e for fees",
      description:
        "Proposes swapping a little ETH on Arbitrum into USDC.e (what freeze fees are paid in) through Uniswap, with at most 2% slippage. freeze_lock already does this step on its own when needed, so this is only for topping up. One transaction; the ETH is sent as value, no approval needed.",
      inputSchema: z
        .object({ usd: z.number().min(0.5).max(100).describe("How many dollars of USDC.e to get."), sender })
        .strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ usd: dollars, sender: who }) => {
      const [feedHex] = await readMany([{ to: ASSETS.ETH.feed, data: SEL.latestRoundData }]);
      const price = int256(wordAt(feedHex!, 1));
      const target = BigInt(Math.round(dollars * 1e6));
      const wei = usd6ToWei(target, price);
      const minOut = (target * 98n) / 100n;
      const proposal = proposeEvm({ chain: ARBITRUM, to: UNISWAP.router, value: wei.toString(), data: encodeSwapEthToUsdce(who, wei, minOut) });
      return {
        ...proposal,
        content: [
          {
            type: "text" as const,
            text: `Swap ${units(wei, 18, 8)} ETH (about ${usd6(target)}) for at least ${usd6(minOut)} USDC.e on Uniswap, Arbitrum. Approve in PayBox, then freeze.`,
          },
        ],
      };
    },
  );

  return server;
}

// Freeze launched after this block; cards bought through Freeze are all later.
const FREEZE_START_BLOCK = 515_500_000;
const SITE = process.env.FREEZE_SITE ?? "https://freeze-paybox.vercel.app";

async function readCard(id: bigint) {
  const [liq, owner] = await readMany([
    { to: HEGIC.treasury, data: encodeUint(SEL.lockedLiquidity, id) },
    { to: HEGIC.cards, data: encodeUint(SEL.ownerOf, id) },
  ]);
  const strategy = "0x" + wordAt(liq!, 1).toString(16).padStart(40, "0");
  const asset = (Object.keys(ASSETS) as Asset[]).find((a) => ASSETS[a].strategy.toLowerCase() === strategy.toLowerCase());
  if (!asset) throw new Error(`Card ${id} is not a Freeze card (not a BTC or ETH call).`);
  const cfg = ASSETS[asset];
  const fee = wordAt(liq!, 3);
  const expiry = Number(wordAt(liq!, 4));
  const [data, pay, feed] = await readMany([
    { to: cfg.strategy, data: encodeUint(SEL.strategyData, id) },
    { to: cfg.strategy, data: encodeUint(SEL.payOffAmount, id) },
    { to: cfg.feed, data: SEL.latestRoundData },
  ]);
  const amount = wordAt(data!, 0);
  const strike = wordAt(data!, 1);
  const price = int256(wordAt(feed!, 1));
  const payout = wordAt(pay!, 0);
  const holder = "0x" + wordAt(owner!, 0).toString(16).padStart(40, "0");
  return {
    owner: holder,
    payout,
    view: {
      card: id.toString(),
      asset,
      amount: `${units(amount, cfg.decimals, cfg.decimals === 8 ? 8 : 6)} ${asset}`,
      frozen_price: usd8(strike),
      price_now: usd8(price),
      worth_now: usd6(payout),
      fee_paid: usd6(fee),
      ends_utc: new Date(expiry * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      active: expiry > Math.floor(Date.now() / 1000),
      link: `${SITE}/card.html?id=${id}`,
    },
  };
}

serveStdio(createServer, { legacy: "reject" });
