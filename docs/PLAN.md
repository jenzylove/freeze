# Freeze: build plan

Deadline: Saturday 2026-10-17 8pm New York = Sunday 00:00 UTC = 01:00 Lagos.

## Phases

| # | Phase | Done when |
|---|---|---|
| 1 | **Gate plugin**: `freeze_quote` and `freeze_lock` only, reading Arbitrum; built with the starter, `pnpm test` passing | Conformance report "passed" |
| 2 | Upload in the portal, add host `arb1.arbitrum.io`, run hosted checks, test `freeze_quote`, validate a `freeze_lock` proposal with the user's wallet | Portal shows a simulated preview on Arbitrum. **This proves PayBox accepts Arbitrum proposals.** If it doesn't, stop and bring a changed plan |
| 3 | Core as pure functions with unit tests: length picking, USD to asset amount, fee formatting, break-even, card value, calldata for approve, buy, payOff, transferFrom, swap | `node --test` green |
| 4 | Remaining tools: `my_freezes`, `freeze_use`, `freeze_buy_real`, `freeze_gift`, `freeze_fund`; fork tests for every proposal against anvil | Each proposal executes on the fork |
| 5 | Website on Vercel: home with live fees, `/card/<id>`, `/proof` | Pages render live data in light and dark |
| 6 | Submit Project for private install; real run from Claude with PayBox: quote, approve, buy a small mainnet freeze | Card on Arbiscan, owned by the user's PayBox address |
| 7 | Release readiness audit, fixes, README | Findings fixed or listed |
| 8 | Final upload before the deadline, demo video on X, submission text | Checklist ticked |

## Risks

| Risk | Status |
|---|---|
| PayBox may not accept Arbitrum proposals | Needs proof: phase 2, before anything else is built on it |
| User needs USDC.e and a little ETH on Arbitrum | Known: `freeze_fund` explains and proposes the swap; demo needs about 3 USD |
| Only owner can cash a card, so no automatic payout | Known: "use my freeze" is a user action, by design |
| Hegic pool capacity (ETH calls about 9,770 USDC left, BTC calls about 2,070) | Known: quotes include availability and refuse above it |
| Price can't be moved on mainnet for the demo | Known: the card page shows the honest live value; the payout math is shown on the fork run, labelled |
| Plugin calls have a 10 second budget | Known: two or three RPC reads per call, 4 second timeouts |

## Money needed

About 3 USD of USDC.e plus about 0.0001 ETH of gas on Arbitrum in the user's PayBox wallet, for one real BTC freeze of about 20 USD notional.
