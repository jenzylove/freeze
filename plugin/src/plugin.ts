import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { evmOutputSchema, proposeEvm, proposeSolana, solanaOutputSchema } from "./paybox.js";
import { baseEthBalance, baseUsdcBalance, cardIdsSentTo, ethBalance, first, readMany } from "./chain.js";
import * as relay from "./relay.js";
import * as solana from "./solana.js";
import {
  ARBITRUM,
  ASSETS,
  AUTOCASH,
  encodeIsApprovedForAll,
  encodeSetApprovalForAll,
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
const PROPOSAL = "io.paybox/transactionProposal";

// Money tools return either a proposal to approve, or the next step in plain words (never an error),
// so the agent can carry on: for example "bring the fee over from Solana first".
const nextStepField = z.string().optional().describe("What to do next when there is nothing to approve yet.");
const evmOrNextStep = z.object({ [PROPOSAL]: evmOutputSchema.shape[PROPOSAL].optional(), next_step: nextStepField }).strict();
const solanaOrNextStep = z.object({ [PROPOSAL]: solanaOutputSchema.shape[PROPOSAL].optional(), next_step: nextStepField }).strict();
const nextStep = (text: string) => ({ content: [{ type: "text" as const, text }], structuredContent: { next_step: text } });

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
  const server = new McpServer({ name: "freeze", version: "0.2.2" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool(
    "freeze_quote",
    {
      title: "Freeze: price to lock today's price",
      description:
        "Free. Use this when the user wants to buy bitcoin (BTC) or ether (ETH) but can't or won't right now: waiting for payday or salary, cash tied up, or scared to miss the rebound after a dip. " +
        "Also for: buy the dip later, lock a price, price lock, call option, keep the upside without buying. " +
        "It tells them what it costs to freeze today's BTC or ETH price for a dollar amount, read live from the Hegic options market on Arbitrum. " +
        "A freeze is the right, until the end date, to be paid the difference if the price rises above today's price. " +
        "The most the user can lose is the fee. Use this before freeze_lock and show the user the fee, frozen price, end date and break-even price in plain words. " +
        "The user needs only a few dollars for the fee, not the full amount, and can pay it from USDC or SOL on Solana, USDC or ETH on Base, or ETH on Arbitrum. " +
        "Every freeze comes with auto cash: if it is worth something in its last hours, it is cashed to the user automatically, so a forgotten win still pays.",
      inputSchema: z.object({ asset, usd, days }).strict(),
      outputSchema: quoteOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ asset: a, usd: dollars, days: d }) => {
      const out = describe(await quote(a, dollars, d));
      const text =
        `${out.fee} freezes ${out.asset} at ${out.frozen_price} on ${out.amount} (about $${dollars}) for ${out.days} days, until ${out.ends_utc}. ` +
        `If ${out.asset} is above ${out.frozen_price} when it's used, the freeze pays the difference in USDC; it pays for itself above ${out.break_even_price}. ` +
        `Most you can lose: ${out.max_loss}. You can cash it any time before ${out.ends_utc}; if it is still worth something in its last 6 hours, auto cash pays it to you. ` +
        `The fee can be paid from USDC or SOL on Solana, USDC or ETH on Base, or ETH on Arbitrum.` +
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
        "Quote first with freeze_quote and get the user's go-ahead. This is the only tool needed to freeze: if the wallet first needs to allow the fee or turn on auto cash, it returns that transaction instead, " +
        "and if the wallet has no money on Arbitrum it says how to pay from Solana or Base. If the user says where to pay from (\"with my Solana USDC\", \"from Base\"), pass pay_from so their choice is used. " +
        "Each time PayBox confirms one, call freeze_lock again with the same arguments until it returns the freeze itself. Tell the user which step they are on.",
      inputSchema: z
        .object({
          asset,
          usd,
          days,
          sender,
          pay_from: z
            .enum(["solana", "base", "arbitrum"])
            .optional()
            .describe(
              "Where the user wants the fee paid from, if they said so: anything on Solana (USDC or SOL) is solana, anything on Base (USDC or ETH) is base, ETH on Arbitrum is arbitrum. Leave it out if they didn't say.",
            ),
          auto_cash: z
            .boolean()
            .optional()
            .describe("Default true. Auto cash pays a winning card to its owner in its last 6 hours. Set false only if the user asks to turn it off."),
        })
        .strict(),
      outputSchema: evmOrNextStep,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ asset: a, usd: dollars, days: d, sender: who, pay_from, auto_cash }) => {
      const q = await quote(a, dollars, d);
      if (q.capacity < q.collateral) throw new Error("The market can't sell a freeze this size right now. Try a smaller amount.");
      const [[balHex, allowHex, autoHex, feedHex], eth] = await Promise.all([
        readMany([
          { to: HEGIC.usdce, data: encodeBalanceOf(who) },
          { to: HEGIC.usdce, data: encodeAllowance(who, HEGIC.treasury) },
          { to: HEGIC.cards, data: encodeIsApprovedForAll(who, AUTOCASH) },
          { to: ASSETS.ETH.feed, data: SEL.latestRoundData },
        ]),
        ethBalance(who),
      ]);
      const bal = first(balHex!);
      const needFee = bal < q.fee;
      const needGas = eth < MIN_GAS_WEI;
      const needAllow = first(allowHex!) < q.fee;
      const needAuto = auto_cash !== false && first(autoHex!) === 0n;
      const total = (needFee || needGas ? 1 : 0) + (needAllow ? 1 : 0) + (needAuto ? 1 : 0) + 1;
      const step = () => (total === 1 ? "Last step" : `Next step (${total} approvals to go, counting the freeze)`);

      if (needFee || needGas) {
        // Enough ETH already on Arbitrum: swap a little for the fee right here (at least $1, so a few freezes are covered).
        const target = q.fee + 100_000n > 1_000_000n ? q.fee + 100_000n : 1_000_000n;
        const wei = usd6ToWei(target, int256(wordAt(feedHex!, 1)));
        // Swap Arbitrum ETH only when the user didn't ask to pay from Solana or Base.
        if (needFee && (pay_from === undefined || pay_from === "arbitrum") && eth >= wei + GAS_RESERVE_WEI) {
          const minOut = (target * 98n) / 100n;
          return {
            ...proposeEvm({ chain: ARBITRUM, to: UNISWAP.router, value: wei.toString(), data: encodeSwapEthToUsdce(who, wei, minOut) }),
            content: [
              {
                type: "text" as const,
                text: `${step()}: the fee is paid in USDC.e and this wallet has ${usd6(bal)}. Swap ${units(wei, 18, 8)} ETH (about ${usd6(target)}) for at least ${usd6(minOut)} USDC.e on Uniswap. Nothing is frozen yet. Approve in PayBox; once it confirms, call freeze_lock again with the same arguments.`,
              },
            ],
          };
        }
        return nextStep(NEEDS_FUNDING(who, needFee ? fundTarget(q.fee, bal) : 1_000_000n, needFee, needGas, pay_from));
      }
      if (needAllow) {
        // First freeze from this wallet: hand back the allowance step so the agent never dead ends.
        const need = allowanceFor(q.fee);
        return {
          ...proposeEvm({ chain: ARBITRUM, to: HEGIC.usdce, value: "0", data: encodeApprove(HEGIC.treasury, need) }),
          content: [
            {
              type: "text" as const,
              text: `${step()}: allow Hegic's options pool to take freeze fees from this wallet, up to ${usd6(need)} USDC.e in total. This covers today's ${usd6(q.fee)} fee and the next few freezes. Nothing is bought yet. Approve in PayBox; once it confirms, call freeze_lock again with the same arguments.`,
            },
          ],
        };
      }
      if (needAuto) {
        return {
          ...proposeEvm({ chain: ARBITRUM, to: HEGIC.cards, value: "0", data: encodeSetApprovalForAll(AUTOCASH, true) }),
          content: [
            {
              type: "text" as const,
              text: `${step()}: turn on auto cash, once for this wallet. If a freeze card is worth something in its last 6 hours, Freeze's auto cash contract (${AUTOCASH}) cashes it and the money goes to the card's owner, never anywhere else. It has no other powers, no admin and holds no money. Approve in PayBox; once it confirms, call freeze_lock again with the same arguments.`,
            },
          ],
        };
      }
      const out = describe(q);
      const source =
        pay_from === "solana" || pay_from === "base"
          ? " The fee is paid from the USDC.e in this Arbitrum wallet."
          : "";
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
            text: `Last step: freeze ${out.asset} at ${out.frozen_price} on ${out.amount} for ${out.days} days, fee about ${out.fee} (the market sets the exact fee when it goes through). The freeze card goes to ${who}.${source} Approve in PayBox; once it confirms, call freeze_cards to show the card and its link.`,
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
      status: z.enum(["open", "cashed", "ended"]),
      link: z.string(),
    })
    .strict();

  server.registerTool(
    "freeze_cards",
    {
      title: "Freeze: my freeze cards",
      description:
        "Free. Lists the freeze cards an address holds, with the frozen price, today's price, what each is worth right now, when it ends and a link to its live card page. Read live from Arbitrum. " +
        "A card can be cashed with freeze_use any time before it ends; after the end date it pays nothing. With auto cash on, a card that is worth something is cashed to its owner in its last 6 hours. " +
        "If auto cash is off, warn the user about any card that is worth something and ends soon. Always show each card's link.",
      inputSchema: z.object({ sender }).strict(),
      outputSchema: z.object({ cards: z.array(cardOutput), auto_cash: z.boolean() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ sender: who }) => {
      const [ids, [autoHex]] = await Promise.all([
        cardIdsSentTo(HEGIC.cards, who, FREEZE_START_BLOCK),
        readMany([{ to: HEGIC.cards, data: encodeIsApprovedForAll(who, AUTOCASH) }]),
      ]);
      const auto = first(autoHex!) !== 0n;
      const cards = [];
      for (const id of ids.slice(-20)) {
        const c = await readCard(id).catch(() => null);
        if (c && c.owner.toLowerCase() === who.toLowerCase()) cards.push(c.view);
      }
      const text = cards.length
        ? cards
            .map(
              (c) =>
                `Card ${c.card}: ${c.amount} frozen at ${c.frozen_price}, now ${c.price_now}, ` +
                (c.status === "cashed" ? "already cashed." : c.status === "ended" ? "ended." : `worth ${c.worth_now}, ends ${c.ends_utc}.`) +
                (c.active && c.worth_now !== "$0.00"
                  ? auto
                    ? " Auto cash will pay it in its last 6 hours if it is still worth something; cash it now with freeze_use to lock in today's value."
                    : " Auto cash is off: cash it with freeze_use before it ends or the payout is lost."
                  : "") +
                ` Live card: ${c.link}`,
            )
            .join("\n") + `\nAuto cash is ${auto ? "on" : "off (turn it on with freeze_auto_cash)"} for this wallet.`
        : "No freeze cards found for this address.";
      return { content: [{ type: "text" as const, text }], structuredContent: { cards, auto_cash: auto } };
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
      if (c.view.status === "cashed") throw new Error(`Card ${card} has already been cashed.`);
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

  const solanaSender = z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .describe("The user's PayBox Solana wallet public address, which pays. Fill it in yourself from the selected Solana wallet; never ask the user to type it.");
  const fundUsd = z
    .number()
    .min(0.5)
    .max(100)
    .optional()
    .describe("Dollars of USDC.e to land on Arbitrum for freeze fees. Use the amount freeze_lock named; default 1.");
  const coinAmount = (q: relay.RelayQuote) =>
    q.coin === "USDC" ? `${Number(q.payIn).toFixed(2)} USDC` : `${Number(q.payIn).toFixed(q.coin === "SOL" ? 4 : 6)} ${q.coin}`;

  server.registerTool(
    "freeze_fund",
    {
      title: "Freeze: pay the fee from Base or Arbitrum",
      description:
        "Gets USDC.e on Arbitrum for freeze fees, paid from the user's own PayBox EVM wallet. " +
        "from \"base\": moves USDC or ETH on Base to Arbitrum through Relay, plus a little ETH for network fees when the Arbitrum wallet has none. It pays with USDC when the wallet has enough, otherwise with ETH on Base. With ETH it is one transaction; with USDC an allowance step may come first (call again after it confirms). " +
        "from \"arbitrum\": swaps a little ETH on Arbitrum into USDC.e on Uniswap, at most 2% slippage. " +
        "For Solana use freeze_fund_solana. Funds land in under a minute; then call freeze_lock again.",
      inputSchema: z
        .object({
          from: z.enum(["base", "arbitrum"]).optional().describe("Where the money comes from. Default arbitrum."),
          usd: fundUsd,
          pay_with: z.enum(["usdc", "eth"]).optional().describe("Base only. Leave out to let Freeze pick from what the wallet holds."),
          sender,
        })
        .strict(),
      outputSchema: evmOrNextStep,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ from, usd: dollars, pay_with, sender: who }) => {
      const target = BigInt(Math.round((dollars ?? 1) * 1e6));
      if (from === "base") {
        const [arbEth, baseEth, baseUsdc] = await Promise.all([ethBalance(who), baseEthBalance(who), baseUsdcBalance(who)]);
        const gas = arbEth < MIN_GAS_WEI ? GAS_TOPUP_USD6 : 0n;
        const useUsdc = pay_with ? pay_with === "usdc" : baseUsdc === undefined || baseUsdc >= (target * 105n) / 100n + gas;
        let q: relay.RelayQuote;
        try {
          q = await relay.quote({ from: "base", user: who, recipient: who, usdce6: target, gasUsd6: gas, pay: useUsdc ? "usdc" : "native" });
        } catch (e) {
          return nextStep(`Nothing was sent. ${(e as Error).message} Try freeze_fund again in a moment.`);
        }
        // Base network fees are a fraction of a cent, paid in ETH on Base.
        const reserve = 5_000_000_000_000n;
        const needEth = (useUsdc ? 0n : q.payInRaw) + reserve;
        if (baseEth !== undefined && baseEth < needEth)
          return nextStep(
            useUsdc
              ? `Nothing was sent. This wallet has no ETH on Base for the network fee (well under a cent). Ask the user to add a little ETH on Base, then call freeze_fund again.`
              : `Nothing was sent. Paying from Base takes about ${coinAmount(q)} (fee money plus network costs), and this wallet holds ${units(baseEth, 18, 6)} ETH and ${usd6(baseUsdc ?? 0n)} USDC on Base. Ask the user to add a little ETH or USDC on Base, or pay from Solana or Arbitrum.`,
          );
        const next = relay.nextEvmStep(q);
        // Give a USDC allowance 3% headroom so a small price move before the deposit doesn't need a second approval.
        const data = next.id === "approve" && next.tx.data.startsWith("0x095ea7b3") ? withHeadroom(next.tx.data) : next.tx.data;
        const proposal = proposeEvm({ chain: "eip155:8453", to: next.tx.to, value: next.tx.value, data });
        const what = `${usd6(q.usdceOut)} USDC.e${q.gasTopupUsd ? ` and $${Number(q.gasTopupUsd).toFixed(2)} of ETH for network fees` : ""} on Arbitrum for about ${coinAmount(q)} on Base`;
        const text =
          next.id === "approve"
            ? `Step 1 of 2 on Base: allow Relay to take ${coinAmount(q)} from this wallet for the transfer (${what}). Approve in PayBox; once it confirms, call freeze_fund again with the same arguments.`
            : `Move ${what} through Relay. Approve in PayBox. It usually lands within a minute; then call freeze_lock again. Don't pay again for this freeze: if freeze_lock still says money is missing, wait 30 seconds and call it again.`;
        return { ...proposal, content: [{ type: "text" as const, text }] };
      }
      const [feedHex] = await readMany([{ to: ASSETS.ETH.feed, data: SEL.latestRoundData }]);
      const price = int256(wordAt(feedHex!, 1));
      const wei = usd6ToWei(target, price);
      const minOut = (target * 98n) / 100n;
      if ((await ethBalance(who)) < wei + MIN_GAS_WEI) return nextStep(NEEDS_FUNDING(who, target, true, true));
      const proposal = proposeEvm({ chain: ARBITRUM, to: UNISWAP.router, value: wei.toString(), data: encodeSwapEthToUsdce(who, wei, minOut) });
      return {
        ...proposal,
        content: [
          {
            type: "text" as const,
            text: `Swap ${units(wei, 18, 8)} ETH (about ${usd6(target)}) for at least ${usd6(minOut)} USDC.e on Uniswap, Arbitrum. Approve in PayBox, then call freeze_lock again.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "freeze_fund_solana",
    {
      title: "Freeze: pay the fee from Solana",
      description:
        "Moves USDC or SOL from the user's PayBox Solana wallet to USDC.e on their Arbitrum wallet through Relay, plus a little ETH for network fees when the Arbitrum wallet has none. " +
        "It pays with USDC when the wallet has enough, otherwise with SOL. One Solana transaction, one approval. Funds land in under a minute; then call freeze_lock again with the same arguments as before.",
      inputSchema: z
        .object({
          usd: fundUsd,
          pay_with: z.enum(["usdc", "sol"]).optional().describe("Leave out to let Freeze pick from what the wallet holds."),
          sender,
          solana_sender: solanaSender,
        })
        .strict(),
      outputSchema: solanaOrNextStep,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ usd: dollars, pay_with, sender: who, solana_sender: sol }) => {
      const target = BigInt(Math.round((dollars ?? 1) * 1e6));
      const [arbEth, lamports, held] = await Promise.all([ethBalance(who), solana.lamports(sol), solana.usdc(sol)]);
      const gas = arbEth < MIN_GAS_WEI ? GAS_TOPUP_USD6 : 0n;
      if (lamports !== undefined && lamports < solana.MIN_LAMPORTS)
        return nextStep(
          `Nothing was sent. This Solana wallet (${sol}) has no SOL, and every Solana transaction needs a tiny network fee paid in SOL (about $0.001). ` +
            `PayBox doesn't let anyone else pay that fee, so the wallet needs a few cents of SOL first (even $0.10 is plenty). Easiest ways: Fund Wallet in PayBox to buy a little SOL, or send a few cents of SOL from any exchange or wallet to ${sol}. ` +
            `Then call freeze_fund_solana again. If the user's Arbitrum or Base wallet already holds enough for the fee, paying from there works too.`,
        );
      const useUsdc = pay_with ? pay_with === "usdc" : held === undefined || held >= (target * 105n) / 100n + gas;
      let q: relay.RelayQuote;
      try {
        q = await relay.quote({ from: "solana", user: sol, recipient: who, usdce6: target, gasUsd6: gas, pay: useUsdc ? "usdc" : "native" });
      } catch (e) {
        return nextStep(`Nothing was sent. ${(e as Error).message} Check this Solana wallet has USDC or SOL, then try freeze_fund_solana again in a moment.`);
      }
      // Keep a little SOL back for the network fee and any account the deposit opens.
      const solReserve = 2_500_000n;
      const short =
        useUsdc ? held !== undefined && held < q.payInRaw : lamports !== undefined && BigInt(lamports) < q.payInRaw + solReserve;
      if (short)
        return nextStep(
          `Nothing was sent. Bringing ${usd6(q.usdceOut)} over takes about ${coinAmount(q)}, and this Solana wallet holds ${usd6(held ?? 0n)} of USDC and ${((lamports ?? 0) / 1e9).toFixed(4)} SOL. ` +
            `Ask the user to add a little USDC or SOL on Solana, or pay from Base or Arbitrum.`,
        );
      const tx = relay.buildSolanaTx(sol, relay.solanaInstructions(q));
      const sim = await solana.simulate(tx);
      if (sim)
        return nextStep(
          `Nothing was sent. A test run of this Solana transfer failed on Solana: ${sim}. Check the wallet has a little SOL for fees and enough to pay, then call freeze_fund_solana again.`,
        );
      return {
        ...proposeSolana({ transactionBase64: tx }),
        content: [
          {
            type: "text" as const,
            text: `Pay about ${coinAmount(q)} from Solana to land ${usd6(q.usdceOut)} USDC.e${q.gasTopupUsd ? ` and $${Number(q.gasTopupUsd).toFixed(2)} of ETH for network fees` : ""} in ${who} on Arbitrum, through Relay. Approve in PayBox within about 4 minutes, before this proposal expires. It usually lands within a minute; then call freeze_lock again. Don't call freeze_fund_solana again for this freeze: if freeze_lock still says money is missing, wait 30 seconds and call freeze_lock again.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "freeze_auto_cash",
    {
      title: "Freeze: turn auto cash on or off",
      description:
        "Auto cash pays any freeze card that is worth something to its owner in its last 6 hours, so a forgotten win still pays. freeze_lock turns it on with the first freeze. " +
        "Use this only when the user asks to switch it on or off. The auto cash contract can only cash cards to their owner; it cannot move cards or money anywhere else.",
      inputSchema: z.object({ on: z.boolean(), sender }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ on, sender: who }) => {
      const [autoHex] = await readMany([{ to: HEGIC.cards, data: encodeIsApprovedForAll(who, AUTOCASH) }]);
      if ((first(autoHex!) !== 0n) === on) throw new Error(`Auto cash is already ${on ? "on" : "off"} for this wallet.`);
      return {
        ...proposeEvm({ chain: ARBITRUM, to: HEGIC.cards, value: "0", data: encodeSetApprovalForAll(AUTOCASH, on) }),
        content: [
          {
            type: "text" as const,
            text: on
              ? `Turn on auto cash for this wallet: winning freeze cards are cashed to their owner in their last 6 hours by ${AUTOCASH}. Approve in PayBox.`
              : "Turn off auto cash for this wallet. Winning cards must then be cashed with freeze_use before they end. Approve in PayBox.",
          },
        ],
      };
    },
  );

  return server;
}

// About $0.50 of ETH at today's prices: enough for the three Arbitrum transactions of a first freeze.
const GAS_RESERVE_WEI = 200_000_000_000_000n;
// Below this the wallet can't pay Arbitrum network fees for the remaining steps (about $0.10).
const MIN_GAS_WEI = 40_000_000_000_000n;
// ETH delivered with a cross-chain payment when the Arbitrum wallet has none: $0.25, many freezes' worth of fees.
const GAS_TOPUP_USD6 = 250_000n;

/** approve(spender, amount) with the amount raised 3%. */
function withHeadroom(data: string): string {
  const amount = BigInt("0x" + data.slice(74, 138));
  return data.slice(0, 74) + ((amount * 103n) / 100n).toString(16).padStart(64, "0");
}

/** USDC.e to bring: this freeze's fee plus a little room, at least $1, minus what is already there. */
function fundTarget(fee: bigint, have: bigint): bigint {
  // Room for this fee and one more, so the next freeze is a single approval.
  const want = fee * 2n + 250_000n;
  const target = (want > 1_000_000n ? want : 1_000_000n) - (have < want ? have : 0n);
  return ((target + 9_999n) / 10_000n) * 10_000n; // whole cents
}

const NEEDS_FUNDING = (who: string, target: bigint, fee: boolean, gas: boolean, from?: "solana" | "base" | "arbitrum") => {
  const dollars = Number(target) / 1e6;
  const what = fee && gas ? `about ${usd6(target)} for freeze fees plus a little ETH for network fees` : fee ? `about ${usd6(target)} for freeze fees` : "a little ETH for network fees";
  const again = "Once it lands (usually under a minute), call freeze_lock again with the same arguments.";
  if (from === "solana")
    return `The user chose to pay from Solana. If a Solana payment for this freeze was already approved in this conversation, don't pay again: it is on its way, so wait 30 seconds and call freeze_lock again. Otherwise call freeze_fund_solana with usd ${dollars}, sender ${who} and solana_sender set to their PayBox Solana address, to bring ${what} to Arbitrum in one approval. Nothing has been bought yet. ${again}`;
  if (from === "base")
    return `The user chose to pay from Base. If a Base deposit for this freeze was already approved in this conversation, don't pay again: wait 30 seconds and call freeze_lock again. Otherwise call freeze_fund with from "base", usd ${dollars} and sender ${who}, to bring ${what} to Arbitrum. Nothing has been bought yet. ${again}`;
  if (from === "arbitrum")
    return `This Arbitrum wallet (${who}) doesn't have enough ETH for ${what}. Ask the user to send a few dollars of ETH on Arbitrum to it, or to pay from Solana or Base instead. Nothing has been bought.`;
  return (
    `This Arbitrum wallet (${who}) needs ${what} before it can freeze. Nothing has been bought. ` +
    `If a payment for this freeze was already approved in this conversation, don't pay again: wait 30 seconds and call freeze_lock again. ` +
    `Otherwise ask the user where to pay from, then call one of these and, once it lands (under a minute), call freeze_lock again with the same arguments: ` +
    `USDC or SOL on Solana: freeze_fund_solana with usd ${dollars}, sender ${who} and solana_sender set to their PayBox Solana address. ` +
    `USDC or ETH on Base: freeze_fund with from "base", usd ${dollars} and sender ${who}. ` +
    `ETH on Arbitrum: send a few dollars of ETH to ${who}, then call freeze_lock again.`
  );
};

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
  const locked = wordAt(liq!, 0) === 1n; // Hegic unlocks a card once it is cashed
  const fee = wordAt(liq!, 3);
  const expiry = Number(wordAt(liq!, 4));
  const open = expiry > Math.floor(Date.now() / 1000);
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
      active: locked && open,
      status: (!open ? "ended" : locked ? "open" : "cashed") as "open" | "cashed" | "ended",
      link: `${SITE}/card.html?id=${id}`,
    },
  };
}

serveStdio(createServer, { legacy: "reject" });
