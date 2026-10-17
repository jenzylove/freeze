# Build log

| Date (UTC) | What now works |
|---|---|
| 2026-10-17 03:40 | Spike: Hegic engine on Arbitrum. Fork run: quote 8.09 USDC, buy, card #16685 to buyer, payout 19.25 USDC at a simulated 2,900, owner-only cashing (docs/spikes/hegic-engine.md) |
| 2026-10-17 04:28 | Plugin gate: `freeze_quote`, `freeze_approve`, `freeze_lock`; 9 unit tests; starter conformance passed with a live Arbitrum quote |
| 2026-10-17 04:35 | `freeze_cards`, `freeze_use`, `freeze_gift`; 6 tools pass conformance. Live: card 16684 (10 ETH frozen at 2,361.86) read as worth 620.79 USDC; a stranger is refused. Fork: the `freeze_use` proposal paid the owner 620.794797 USDC.e; the `freeze_gift` proposal moved the card to the new owner |
