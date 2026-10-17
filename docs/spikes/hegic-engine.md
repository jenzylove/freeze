# Spike: can Freeze run on a live options market?

Date: 2026-10-17. Question: is there a live on-chain market that sells plain call options (a price freeze) at small sizes, with a fee known upfront, on a chain PayBox supports?

## Candidates

| Market | Chain | Verdict |
|---|---|---|
| Panoptic v1.1 (ETH/USDC 5bps v4 pool `0x36a3088B94f73853a3964a0352B47605C6354f27`) | Base | Rejected: fee streams per block with no upfront quote, buyers can only buy what sellers posted (about 15 ETH plus 10,100 USDC of collateral in the whole market), and sellers can force-exercise long positions |
| Hypercall | Hyperliquid | Rejected: order-book trading with signed orders, which a PayBox plugin cannot propose |
| Derive | Derive chain | Rejected: chain not supported by PayBox; signed orders |
| **Hegic Herge** | **Arbitrum** | **Chosen**: pool-based, fee paid upfront, small sizes accepted, every option is an ERC-721 card |

## Hegic facts read from chain

- OperationalTreasury `0xec096ea6eB9aa5ea689b0CF00882366E92377371`: `buy(strategy, holder, amount, period, bytes[] additional)`, `payOff(positionID, account)`.
- PositionsManager `0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5`: ERC-721, one token per option.
- Settlement token: USDC.e `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` (6 decimals).
- DefiLlama, 2026-10-17: Arbitrum TVL 8,270,821 USD; option premiums 6,185 USD over the last 7 days.
- 11 options were minted in the 2,000,000 blocks before block 515,563,128 (premiums from 0.02 to 2,555 USDC).

| Strategy | Feed | Kind | Periods | Capacity left |
|---|---|---|---|---|
| `0x2727B807D22fCAeB7F900F49894054Ed92b9125B` | ETH/USD `0x639F…a612` | Call (verified `HegicStrategyCall`) | 60 to 90 days | 9,770.91 USDC |
| `0x527d1086C3DD22FcdB338F69D47A1e4bFE11E539` | BTC/USD `0x6ce1…08e9` | Call (verified `HegicStrategyCall`) | 7 to 14 days | about 2,070 USDC |
| `0x64622a28F97D877E9Ff1E2A7322786A58c3D8Fc7` | ETH/USD | Pays when ETH falls (put or straddle) | 7 to 14 days | not used |
| `0x0ac1995C43B5566760AD1D88B812f3e51e12eCc6` | ETH/USD | Needs extra parameters (spread) | 14 to 30 days | not used |

Premiums are paid by the buyer; the exercise window is unlimited (American style, usable any time before expiry); only the card's owner can cash it (`isPayoffAvailable(id, stranger, stranger)` is false).

## Live quotes (`calculateNegativepnlAndPositivepnl`, second value = fee)

ETH at 2,419.89 USD (Chainlink), 0.04 ETH (about 96.80 USD):

| Period | Fee (USDC) |
|---|---|
| 60 days | 8.09 |
| 90 days | 10.50 |

BTC at 81,379.20 USD, 0.001 BTC (about 81.38 USD):

| Period | Fee (USDC) |
|---|---|
| 7 days | 1.62 |
| 10 days | 1.97 |
| 14 days | 2.40 |

## Fork run (local anvil fork of Arbitrum mainnet at block 515,564,054)

Script: `docs/spikes/hegic-fork-buy.sh`. Steps and output:

1. Test buyer funded with 20 USDC.e from a large holder (fork only).
2. Quote for 0.04 ETH, 60 days: 8,088,533 (8.09 USDC).
3. `approve(OperationalTreasury, 20 USDC.e)` then `buy(0x2727…, buyer, 0.04e18, 5184000, [])`: status 1, gas 395,991.
4. Buyer balance 20.00 → 11.91 USDC.e (paid exactly the quote). Card #16685 owned by the buyer.
5. `strategyData(16685)` = amount 0.04 ETH, strike 2,418.67 USD (the frozen price). Expiry 1797391268.
6. Price feed replaced on the fork with `docs/spikes/mock/MockFeed.sol` returning 2,900 USD (fork only, to simulate a rise).
7. `payOffAmount(16685)` = 19,253,088 (19.25 USDC) = (2,900 − 2,418.67) × 0.04.
8. A stranger cannot trigger the payout; the owner can. `payOff(16685, buyer)` from the owner: status 1, buyer received 19.25 USDC.e.

## Verdict

Proven on a mainnet fork: quote, buy, card in wallet, cash out at the right amount, owner-only. Freeze runs on Hegic: BTC 7 to 14 days, ETH 60 to 90 days.

Still open (must be proven through PayBox, not a fork):

- PayBox proposals on Arbitrum (`eip155:42161`): MoonPay lists Arbitrum among PayBox chains; the developer portal's proposal validation is the proof.
- Funding: the buyer needs USDC.e on Arbitrum and a little ETH for gas.
