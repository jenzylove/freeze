# Freeze: product requirements

Lock today's price. Decide later.

## Problem

"I see the dip, but my money isn't ready." Every crypto holder knows the moment: the price is low today, the salary or client payment lands next week, and by then the price has moved.

- Hopper proved people pay to wait: its Price Freeze and Rebooking Guarantee made up about 70% of Hopper's air revenue (TechCrunch, Feb 2022).
- Crypto already has the instrument (a call option is a price freeze), but only for professionals. Onchain options did roughly 4.8 to 5.6 billion USD of notional in September 2026 (Cobo), while Delphi Digital notes the retail options crowd is "largely nonexistent onchain" because there is "no good UX for retail."
- A chat agent can't hold a price for anyone. Locking a price needs a counterparty that carries the risk, and a contract that remembers the deal for weeks.

## User and front door

**User:** a PayBox user who wants a crypto asset but doesn't have the money ready: waiting for payday, a client payment or a prize. Second user: someone who wants a cheap, capped bet that the price goes up, without the risk of buying.

**First ten seconds**, in Claude or ChatGPT with PayBox:

> "BTC dipped. Freeze 20 dollars of BTC for a week."
>
> "Done for 40 cents: BTC is frozen at 81,379 until Fri 24 Oct. If BTC is higher when you use it, the freeze pays you the difference. The most you can lose is the 40 cents. Approve in PayBox."

The approval is one transaction. A freeze card appears with a link anyone can open.

## How it works (one picture)

```
"freeze $20 of BTC till Friday"
        |
   freeze_quote  ->  fee, frozen price, end date, break-even, max loss (read live from the market)
        |
   freeze_lock   ->  one PayBox approval (first time: a USDC allowance, then the purchase)
        |
   Freeze card (an NFT in your wallet)  ->  live value page, shareable
        |
   any time before it ends:
     use it   -> the market pays the difference in USDC   (freeze_use)
     buy real -> that USDC plus your money buys the coin   (freeze_buy_real)
     gift it  -> send the card to someone                   (freeze_gift)
     ignore   -> it lapses; you lost only the fee
```

Under the hood every freeze is a call option bought from Hegic's pool on Arbitrum (proof in `docs/spikes/hegic-engine.md`). Freeze never holds user money: the card goes straight to the user's wallet and only its owner can cash it.

## Full scope

1. **PayBox plugin** (official starter 1.0.2), reading Arbitrum directly:
   - `freeze_quote(asset, usd, days)`: picks a valid length (BTC 7 to 14 days, ETH 60 to 90 days), reads the live fee and capacity, returns fee, frozen price, end date, break-even price and maximum loss in plain words.
   - `freeze_lock(asset, usd, days, owner)`: returns the USDC.e allowance proposal when needed, otherwise the purchase proposal (one transaction each).
   - `my_freezes(owner)`: every card the address holds, with frozen price, current price, value now, days left.
   - `freeze_use(card, owner)`: proposes cashing the card (owner-only payout in USDC).
   - `freeze_buy_real(asset, usdc, owner)`: proposes the swap that turns cash into the actual coin on Arbitrum.
   - `freeze_gift(card, owner, to)`: proposes sending the card to someone.
   - `freeze_fund(owner)`: tells the user exactly what's missing (USDC.e or gas on Arbitrum) and proposes the USDC to USDC.e swap when the user holds native USDC there.
2. **Website** (Vercel):
   - Home: "Lock today's price. Decide later." with live fees for BTC and ETH.
   - Card page `/card/<id>`: live card read from chain (asset, frozen price, today's price, value, days left), share to X with a card image.
   - `/proof`: the real mainnet freeze made through PayBox, with Arbiscan links, and the fork run from the spike, labelled as a simulation.
3. **Demo video posted to X.**

### Not in scope, and why

- Freezes on other assets: Hegic sells plain calls only on ETH and BTC.
- Lengths outside 7 to 14 days (BTC) and 60 to 90 days (ETH): those are the only call lengths the market sells. The quote says so in plain words.

## Judging criteria

The terms list quality, completeness, creativity, usefulness and technical execution; no weights are published.

| Criterion | How Freeze meets it |
|---|---|
| Quality | One sentence anyone gets: lock the price, decide later |
| Completeness | Quote, lock, card, live value, use, buy real, gift; real mainnet card |
| Creativity | Hopper's freeze, brought to crypto through a chat agent; options with no jargon |
| Usefulness | The "price is low but my money isn't ready" moment; capped loss |
| Technical execution | Live onchain quoting, approval-aware proposals, ERC-721 cards, payout math checked on a mainnet fork |
| PayBox | Chat to quote to one approval to a card in the user's own wallet; Arbitrum proposals |

## Claims and how each is proven

| Claim | Proof |
|---|---|
| Fees are live, not invented | `freeze_quote` reads `calculateNegativepnlAndPositivepnl` on Arbitrum at call time |
| One approval buys a freeze | Mainnet purchase through PayBox, Arbiscan link on /proof |
| The card is yours | `ownerOf(card)` is the buyer's PayBox address |
| It pays the difference | Fork run: frozen 2,418.67, price 2,900, paid 19.25 USDC (spike doc); mainnet `payOffAmount` shown live on the card page |
| Only the owner can cash it | `isPayoffAvailable(card, stranger)` is false (spike doc) |
| Max loss is the fee | Hegic premiums are paid upfront; nothing else is owed |

## What it does not do

- It doesn't predict prices or tell anyone to buy.
- It isn't a loan and never holds user money.
- It doesn't make the market: Hegic's pool sells the freeze and sets the fee.
- If the price ends below the frozen price, the card is worth nothing; the fee is gone.

## Business

A small fee on top of each freeze (for example 2% of the market fee) can be added to the purchase later; the hackathon build charges nothing extra.

## Sponsor checklist

`docs/SUBMISSION_CHECKLIST.md`, ticked only from the live product.
