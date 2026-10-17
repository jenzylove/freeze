import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { evmOutputSchema, proposeEvm } from "./paybox.js";
import { first, readMany } from "./chain.js";
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
const owner = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe("The user's PayBox EVM wallet address on Arbitrum (from list_credentials). The freeze card is sent here.");

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
        "Free. Tells the user what it costs to freeze today's BTC or ETH price for a dollar amount, read live from the Hegic options market on Arbitrum. " +
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
        `Most you can lose: ${out.max_loss}.` +
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
        "Proposes a one-time USDC.e allowance on Arbitrum so the freeze fee can be paid. Only needed when freeze_lock says an approval is missing. " +
        "The allowance covers the quoted fee plus 5% for price moves. Nothing is bought by this step.",
      inputSchema: z.object({ asset, usd, days, owner }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ asset: a, usd: dollars, days: d, owner: who }) => {
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
            text: `Allow up to ${usd6(need)} USDC.e (the ${usd6(q.fee)} fee plus 5% for price moves) to be paid to Hegic's options pool on Arbitrum. Approve in PayBox, then call freeze_lock.`,
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
        "Quote first with freeze_quote and get the user's go-ahead. If the allowance is missing it says so; call freeze_approve first.",
      inputSchema: z.object({ asset, usd, days, owner }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ asset: a, usd: dollars, days: d, owner: who }) => {
      const q = await quote(a, dollars, d);
      if (q.capacity < q.collateral) throw new Error("The market can't sell a freeze this size right now. Try a smaller amount.");
      const [balHex, allowHex] = await readMany([
        { to: HEGIC.usdce, data: encodeBalanceOf(who) },
        { to: HEGIC.usdce, data: encodeAllowance(who, HEGIC.treasury) },
      ]);
      if (first(balHex!) < q.fee)
        throw new Error(`This wallet needs ${usd6(q.fee)} of USDC.e on Arbitrum for the fee and has ${usd6(first(balHex!))}.`);
      if (first(allowHex!) < q.fee) throw new Error("Approval missing: call freeze_approve first, then freeze_lock.");
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
            text: `Freeze ${out.asset} at ${out.frozen_price} on ${out.amount} for ${out.days} days, fee ${out.fee}. The freeze card goes to ${who}. Approve in PayBox.`,
          },
        ],
      };
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
