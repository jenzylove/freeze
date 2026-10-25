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

Every Arbitrum proposal goes to one of these addresses, and the plugin builds the calldata itself
from the user's own arguments. Paying the fee from Solana or Base uses a deposit quoted by
[Relay](https://relay.link) (`api.relay.link`): the plugin checks that it is a single signer
transaction from the user's own wallet, and PayBox simulates it before the user approves.

| Contract | Address | Calls Freeze proposes |
|---|---|---|
| Hegic OperationalTreasury | [`0xec096ea6eB9aa5ea689b0CF00882366E92377371`](https://arbiscan.io/address/0xec096ea6eB9aa5ea689b0CF00882366E92377371) | `buy` (freeze), `payOff` (cash a card) |
| Hegic PositionsManager (cards) | [`0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5`](https://arbiscan.io/address/0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5) | `safeTransferFrom` (gift a card), `setApprovalForAll` for auto cash |
| FreezeAutoCash | [`0x679399608d973c2476d1D9ECd8eB1150e97936Ec`](https://arbiscan.io/address/0x679399608d973c2476d1D9ECd8eB1150e97936Ec) | none directly; it is the operator approved for auto cash |
| USDC.e | [`0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8`](https://arbiscan.io/address/0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8) | `approve` the treasury for fees |
| Uniswap SwapRouter02 | [`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`](https://arbiscan.io/address/0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45) | `exactInputSingle` ETH to USDC.e, at most 2% below the oracle price |

## Known risks a user takes

- **A card pays nothing after it ends.** Hegic refuses `payOff` after expiry ("The option has
  already expired"), even for a card that was worth money. Auto cash covers this: with it on, a card
  worth something is cashed in its last 6 hours by `FreezeAutoCash`, which our keeper calls every
  30 minutes. If the keeper or GitHub Actions were down for that whole window, the owner would still
  need to cash it themselves. The card page also offers a calendar reminder.
- **What auto cash can do.** Turning it on approves `FreezeAutoCash` as an operator of the wallet's
  Hegic cards. The contract has one write function, `cash(card)`, which only works in a card's last
  6 hours, only when it is worth something, and always calls `payOff(card, ownerOf(card))`. It has no
  admin, no upgrade path and no way to transfer cards. Hegic's `payOff` does not check the recipient,
  which is why the keeper never holds the approval itself. Turn it off any time with `freeze_auto_cash`.
- **The exact fee is set when the freeze goes through.** Hegic's `buy` has no maximum fee argument,
  so the fee can differ slightly from the quote if the price moves between quote and approval. The
  fee allowance caps what can be taken: at least $5 in total across freezes, or the fee plus 5% for
  larger ones.
- **The fee allowance stays open** until it is used up. A user can set it back to zero at any time
  with an `approve(treasury, 0)` from their wallet.
- **Hegic and Chainlink are trusted.** Pricing, payouts and the price feed come from Hegic's
  contracts and Chainlink's BTC/USD and ETH/USD feeds on Arbitrum. Freeze's only contract is
  `FreezeAutoCash`, described above.
- **Relay is trusted for cross-chain fee payments.** When the fee comes from Solana or Base, Relay
  delivers it on Arbitrum. The amount is a few dollars at a time.
- **Gifts are final.** A card sent to the wrong address cannot be recalled.

## Reporting

Please report anything that could cost a user money privately through GitHub's
[private vulnerability reporting](https://github.com/jenzylove/freeze/security/advisories/new) for
this repository, with the tool name, the arguments and what you expected. Please don't open a
public issue for it. We aim to reply within 72 hours.
