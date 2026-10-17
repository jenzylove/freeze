<p align="center">
  <img src="docs/media/brand/mark.svg" alt="Freeze" width="84">
</p>

<h1 align="center">Freeze</h1>

<p align="center">
  <b>Lock today's price. Decide later.</b><br>
  BTC dipped but payday is a week away? Ask your agent to freeze today's price for a small fee. If it rises, the gain is yours. If not, you only lose the fee.
</p>

<p align="center">
  <a href="https://freeze-paybox.vercel.app"><img src="https://img.shields.io/badge/live-freeze--paybox.vercel.app-0a6fa8" alt="Live site"></a>
  <a href="https://freeze-paybox.vercel.app/proof.html"><img src="https://img.shields.io/badge/Arbitrum-2%20mainnet%20freezes-12AAFF" alt="Mainnet freezes"></a>
  <a href="https://github.com/jenzylove/freeze/actions/workflows/verify.yml"><img src="https://github.com/jenzylove/freeze/actions/workflows/verify.yml/badge.svg" alt="Tests"></a>
  <a href="https://developer.paybox.sh"><img src="https://img.shields.io/badge/built%20for-PayBox%20by%20MoonPay-7D00FF" alt="Built for PayBox by MoonPay"></a>
  <a href="https://x.com/Dollar782/status/2111512033762111718"><img src="https://img.shields.io/badge/demo-watch%20on%20X-111111?logo=x" alt="Demo video on X"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT license"></a>
</p>

<p align="center">
  <img src="docs/media/hero.png" alt="Freeze landing page with the live BTC price frozen on the chart" width="100%">
</p>

Most people who watch BTC dip can't buy it that day. The money is in next week's salary, in a
locked savings plan, or simply not here yet. By the time it lands, the dip is gone.

Exchanges answer this with options, which most people will never open. Freeze puts the same
protection behind one sentence to the agent you already use. You pay a small fee now, and the price
you saw is yours until the end date. If BTC rises, you collect the gain as if you had bought at
the frozen price. If it falls, the fee is the most you can lose.

Freeze is a [PayBox](https://developer.paybox.sh) plugin. PayBox is MoonPay's wallet for AI agents
in Claude and ChatGPT, so there is no new app, no exchange account and no seed phrase: you talk,
PayBox asks you to approve, and the freeze card lands in your wallet.

## Start here

| | |
|---|---|
| Live site | https://freeze-paybox.vercel.app |
| Demo video | [Watch on X](https://x.com/Dollar782/status/2111512033762111718) |
| Real freezes on Arbitrum mainnet | [Proof page](https://freeze-paybox.vercel.app/proof.html), cards [16686](https://freeze-paybox.vercel.app/card.html?id=16686) and [16685](https://freeze-paybox.vercel.app/card.html?id=16685) |
| The freeze from one chat message | [`0x28538aa5…1afc`](https://arbiscan.io/tx/0x28538aa56aa35300f67740f1afc0a14136abc1fb49a1ba77ab72c64b28411afc) |
| How to use it | [Three steps](#use-it-in-three-steps) |
| Plugin source | [`plugin/src/plugin.ts`](plugin/src/plugin.ts), math in [`plugin/src/core.ts`](plugin/src/core.ts) |
| Build log | [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md) |

## Judge fast path (five minutes, no keys)

1. Open https://freeze-paybox.vercel.app. The chart is BTC's last day of real price updates read
   from Arbitrum, and the dashed line is today's price, frozen. The fee under it is live.
2. Scroll to **Why not just buy?** and drag BTC to -10%. Buying $500 loses $50. Freezing $500 loses
   only today's fee, about $10.
3. Open [card 16686](https://freeze-paybox.vercel.app/card.html?id=16686). It was bought on mainnet
   from one message in Claude: *"hey chat, btc dipped today but payday is in 7 days can you pull up my freeze plugin so i lock price for $20 btc"*. Claude found Freeze in the user's plugins by
   itself. Everything on the card is read live from the chain.
4. Open the [proof page](https://freeze-paybox.vercel.app/proof.html) and follow any step to
   Arbiscan.

With PayBox connected to Claude and Freeze enabled, the same sentence runs it for real.

<p align="center">
  <img src="docs/media/chat.png" alt="Setup steps beside a replay of the real chat that bought card 16686" width="100%">
</p>

## Freeze or buy?

| Example: $500 of BTC for 7 days | Buy today | Freeze today |
|---|---|---|
| Money needed today | $500 | about $10 (live fee) |
| BTC falls 10% | you lose $50 | you lose the fee, about $10 |
| BTC rises 10% | you gain $50 | you gain $50 minus the fee |

Buying is better when the money is already here and you are sure. Freeze is for when it isn't
here yet, or when you want the rise without carrying every drop.

**The business in one number:** freezing $500 of BTC for a week costs about 2% of the amount today,
instead of the full $500 up front.

## Use it in three steps

1. **Connect PayBox** to Claude or ChatGPT. In Claude: Settings, Connectors, add
   `https://api.paybox.sh/mcp`.
2. **Turn on Freeze** in PayBox under Plugins. Keep a few dollars of ETH on Arbitrum; Freeze swaps
   a little into USDC for the fee when needed.
3. **Say it.** "Use Freeze to lock today's price on $20 of BTC for a week." Approve in PayBox. When
   BTC is above your price, ask your agent to cash the card before it ends.

The first freeze from a wallet takes up to three approvals (get USDC for the fee, allow fees, freeze).
After that, each freeze is one approval.

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant U as You
    participant A as Your agent (Claude or ChatGPT)
    participant P as PayBox
    participant F as Freeze plugin
    participant H as Hegic on Arbitrum
    U->>A: "btc dipped, payday is in 7 days, lock price for $20 btc"
    A->>P: use_plugin freeze_quote
    P->>F: tools/call
    F->>H: read price feed and the pool's fee
    F-->>A: fee, frozen price, end date, most you can lose
    U->>A: "Lock it."
    A->>P: use_plugin freeze_lock
    F-->>P: unsigned proposal (allow fees, or the freeze itself)
    P->>U: approval window with simulation
    U->>P: passkey
    P->>H: signed transaction
    H-->>U: freeze card (an NFT) in your wallet
```

Under the hood a freeze is a call option bought from [Hegic](https://www.hegic.co)'s pool on
Arbitrum. The card stores the amount and the frozen price. Its value at any moment is
(price now minus frozen price) times the amount, and only its owner can cash it.

### Tools

| Tool | What it does | Moves money |
|---|---|---|
| `freeze_quote` | Live fee, frozen price, end date and break even for a dollar amount | No |
| `freeze_lock` | The one tool needed to freeze. Returns whichever step is missing: swap a little ETH for the fee, allow fees, or the freeze itself | Yes, with approval |
| `freeze_cards` | Your cards, what each is worth now, when each ends, and a link to its live page | No |
| `freeze_use` | Cash a card that is worth something, paid to the owner in USDC | Yes, with approval |
| `freeze_gift` | Send a card, and everything it is worth, to someone else | Yes, with approval |
| `freeze_approve`, `freeze_fund` | The allowance and the ETH swap on their own, for topping up | Yes, with approval |

Every money tool returns an unsigned `io.paybox/transactionProposal`. The wallet address comes from
PayBox as the `sender` argument, so a user never types it.

## What is real

| Part | Status |
|---|---|
| Plugin in PayBox | Submitted and running in PayBox, 7 tools, starter conformance passing |
| Freezes on Arbitrum mainnet | 2, both made through PayBox with real money: [card 16686](https://arbiscan.io/tx/0x28538aa56aa35300f67740f1afc0a14136abc1fb49a1ba77ab72c64b28411afc), [card 16685](https://arbiscan.io/tx/0x6c819fea4aa0059b7514a8f97380193c1b03b1e93b2604367f31b533fe73893f) |
| Payout | Tested on a fork of mainnet: price moved to $2,900, card paid 19.25 USDC, a stranger was refused ([spike notes](docs/spikes/hegic-engine.md)) |
| Prices and fees on the site | Read live from Arbitrum on every load, never stored |
| Reminder before a card ends | Calendar file from the card page |

## Scope

BTC freezes run 7 to 14 days and ETH freezes 60 to 90 days, the terms Hegic's pool sells. Amounts
run from $2 to $500 per freeze, on Arbitrum. A card has to be cashed before its end date. See
[SECURITY.md](SECURITY.md) for the contracts involved and the risks a user takes.

## Run it locally

The PayBox starter needs Linux or WSL with Node 24 and pnpm 11.

```bash
cd plugin
pnpm install
node --test "test/*.test.ts"    # pricing, payout and calldata math
pnpm test                       # typecheck, two identical builds, PayBox conformance
node scripts/call.mjs freeze_quote '{"asset":"BTC","usd":20,"days":7}'
```

`scripts/one-ask.mjs` replays a full first freeze (swap, allow, freeze, then a second one step
freeze) against a local `anvil --fork-url https://arb1.arbitrum.io/rpc --port 8546`.

The site in `web/` is static HTML and needs no build.

## Layout

```
plugin/   PayBox plugin (MCP server bundled to dist/plugin.mjs)
web/      the live site: landing page, card page, proof page
docs/     PRD, plan, build log, spikes
```

MIT licensed.
