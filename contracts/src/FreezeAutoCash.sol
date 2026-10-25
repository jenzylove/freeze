// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IHegicTreasury {
    function payOff(uint256 positionID, address account) external;
    function lockedLiquidity(uint256 positionID)
        external
        view
        returns (uint8 state, address strategy, uint128 negativepnl, uint128 positivepnl, uint32 expiration);
}

interface IHegicStrategy {
    function payOffAmount(uint256 positionID) external view returns (uint256);
}

interface IERC721Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

/// @title Freeze auto cash
/// @notice Cashes a winning freeze card in its last hours, so a forgotten card still pays.
/// A card owner opts in once with setApprovalForAll(this, true) on Hegic's card contract.
/// Anyone may then call cash(), but the payout always goes to the card's current owner,
/// only inside the final window, and only when the card is worth something.
/// No owner, no admin, no upgrade, no funds held.
contract FreezeAutoCash {
    IHegicTreasury public constant TREASURY = IHegicTreasury(0xec096ea6eB9aa5ea689b0CF00882366E92377371);
    IERC721Owner public constant CARDS = IERC721Owner(0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5);

    /// @notice How close to its end a card must be before it can be cashed for its owner.
    uint256 public constant WINDOW = 6 hours;

    event Cashed(uint256 indexed card, address indexed owner, uint256 amount);

    error TooEarly(uint256 card, uint256 endsAt);
    error Ended(uint256 card);
    error NothingToCash(uint256 card);
    error AlreadyCashed(uint256 card);

    /// @notice True when cash(card) would pay the owner right now.
    function cashable(uint256 card) public view returns (bool) {
        (uint8 state, address strategy,,, uint32 expiration) = TREASURY.lockedLiquidity(card);
        if (state != 1) return false;
        if (expiration <= block.timestamp || expiration > block.timestamp + WINDOW) return false;
        address owner = CARDS.ownerOf(card);
        if (!CARDS.isApprovedForAll(owner, address(this))) return false;
        return IHegicStrategy(strategy).payOffAmount(card) > 0;
    }

    /// @notice Pays a winning card to its owner in the card's last hours.
    function cash(uint256 card) external {
        (uint8 state, address strategy,,, uint32 expiration) = TREASURY.lockedLiquidity(card);
        if (state != 1) revert AlreadyCashed(card);
        if (expiration <= block.timestamp) revert Ended(card);
        if (expiration > block.timestamp + WINDOW) revert TooEarly(card, expiration);
        uint256 amount = IHegicStrategy(strategy).payOffAmount(card);
        if (amount == 0) revert NothingToCash(card);
        address owner = CARDS.ownerOf(card);
        TREASURY.payOff(card, owner);
        emit Cashed(card, owner, amount);
    }
}
