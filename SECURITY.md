# Security

Freeze holds no money and no keys. It is a PayBox plugin that reads Arbitrum and returns unsigned
transaction proposals. PayBox shows each one to the user, simulates it, and only signs after the
user approves with their passkey. This page lists what that means in practice and how to report a
problem.

## What the plugin can and cannot do

| | |
|---|---|
| Sign or send a transaction | No. Every money move is a proposal the user approves in PayBox. |
| Hold funds | No. Fees go straight from the user's wallet to Hegic's options pool, and the freeze card (an ERC 721 token) goes straight to the user's wallet. |
| Reach the network | Only `arb1.arbitrum.io`, the one host allowed in the PayBox portal. |
| Keep state between calls | No. Each call is a fresh process with a 10 second budget. |
| Secrets | None. The plugin needs no API key and stores nothing. |

## Contracts each proposal can touch

Every proposal goes to one of these addresses on Arbitrum One, and the plugin builds the calldata
itself from the user's own arguments.

| Contract | Address | Calls Freeze proposes |
|---|---|---|
| Hegic OperationalTreasury | [`0xec096ea6eB9aa5ea689b0CF00882366E92377371`](https://arbiscan.io/address/0xec096ea6eB9aa5ea689b0CF00882366E92377371) | `buy` (freeze), `payOff` (cash a card) |
| Hegic PositionsManager (cards) | [`0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5`](https://arbiscan.io/address/0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5) | `safeTransferFrom` (gift a card) |
| USDC.e | [`0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8`](https://arbiscan.io/address/0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8) | `approve` the treasury for fees |
| Uniswap SwapRouter02 | [`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`](https://arbiscan.io/address/0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45) | `exactInputSingle` ETH to USDC.e, at most 2% below the oracle price |

## Known risks a user takes

- **A card must be cashed before it ends.** Hegic refuses `payOff` after expiry ("The option has
  already expired"), even for a card that was worth money. We confirmed this on a fork of mainnet.
  The plugin warns about it in every quote and card listing, and the card page offers a calendar
  reminder a day before the end.
- **The exact fee is set when the freeze goes through.** Hegic's `buy` has no maximum fee argument,
  so the fee can differ slightly from the quote if the price moves between quote and approval. The
  fee allowance caps what can be taken: at least $5 in total across freezes, or the fee plus 5% for
  larger ones.
- **The fee allowance stays open** until it is used up. A user can set it back to zero at any time
  with an `approve(treasury, 0)` from their wallet.
- **Hegic and Chainlink are trusted.** Pricing, payouts and the price feed come from Hegic's
  contracts and Chainlink's BTC/USD and ETH/USD feeds on Arbitrum. Freeze adds no contract of its own.
- **Gifts are final.** A card sent to the wrong address cannot be recalled.

## Reporting

Please report anything that could cost a user money privately through GitHub's
[private vulnerability reporting](https://github.com/jenzylove/freeze/security/advisories/new) for
this repository, with the tool name, the arguments and what you expected. Please don't open a
public issue for it. We aim to reply within 72 hours.
