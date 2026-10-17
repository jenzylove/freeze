// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Test-only Chainlink feed stand-in used on a local fork to simulate ETH moving.
contract MockFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, 290000000000, block.timestamp, block.timestamp, 1); // $2,900.00
    }

    function latestAnswer() external pure returns (int256) {
        return 290000000000;
    }
}
