# Build log

| Date (UTC) | What now works |
|---|---|
| 2026-10-17 03:40 | Spike: Hegic engine on Arbitrum. Fork run: quote 8.09 USDC, buy, card #16685 to buyer, payout 19.25 USDC at a simulated 2,900, owner-only cashing (docs/spikes/hegic-engine.md) |
| 2026-10-17 04:28 | Plugin gate: `freeze_quote`, `freeze_approve`, `freeze_lock`; 9 unit tests; starter conformance passed with a live Arbitrum quote |
| 2026-10-17 04:35 | `freeze_cards`, `freeze_use`, `freeze_gift`; 6 tools pass conformance. Live: card 16684 (10 ETH frozen at 2,361.86) read as worth 620.79 USDC; a stranger is refused. Fork: the `freeze_use` proposal paid the owner 620.794797 USDC.e; the `freeze_gift` proposal moved the card to the new owner |
| 2026-10-17 05:45 | PayBox portal: hosted checks + `freeze_quote` live ($0.40 to freeze $20 of BTC for 7 days); `freeze_approve` proposal **simulation passed on Arbitrum (eip155:42161)** with the user wallet. Site live at freeze-paybox.vercel.app |
| 2026-10-17 05:55 | `freeze_fund` (ETH to USDC.e via Uniswap, one tx with value); 7 tools pass conformance. Fork run from the user's real PayBox wallet: fund $1, approve $0.42, lock $20 BTC for 7 days (fee $0.40), card found by `freeze_cards` |
| 2026-10-17 | | First real mainnet freeze through PayBox (Claude chat with the PayBox connector): swap 0xe2d3d2ed…5957, approve 0x61bfba40…1223, lock 0x6c819fea…893f, card 16685, 0.00024543 BTC at $81,486.80 until Oct 24, fee $0.40. freeze_lock now returns the allowance step itself when it is missing, after the PayBox agent skipped freeze_approve. Proof page updated. |
| 2026-10-17 | | One ask flow: tools take `sender` (PayBox fills the selected wallet, user never types it). freeze_lock chains every missing step (swap ETH for the fee, allow fees, freeze); first allowance is $5 so later freezes are one approval. Fork test: first ask 3 approvals, second ask 1 approval, cards 16686 and 16687 (fork only). Discovery wording added to freeze_quote (payday, cash tied up, dip). |
