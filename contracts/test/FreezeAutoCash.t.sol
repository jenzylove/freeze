// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FreezeAutoCash} from "../src/FreezeAutoCash.sol";

interface Vm {
    function createSelectFork(string calldata url) external returns (uint256);
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

interface IERC20 { function balanceOf(address) external view returns (uint256); }
interface ICards {
    function setApprovalForAll(address, bool) external;
    function ownerOf(uint256) external view returns (address);
    function transferFrom(address, address, uint256) external;
}

contract FreezeAutoCashTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IERC20 constant USDCE = IERC20(0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8);
    ICards constant CARDS = ICards(0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5);
    uint256 constant CARD = 16708; // live BTC call, in the money at fork time
    FreezeAutoCash ac;
    address owner;
    uint32 endsAt;

    function setUp() public {
        vm.createSelectFork("https://arb1.arbitrum.io/rpc");
        ac = new FreezeAutoCash();
        owner = CARDS.ownerOf(CARD);
        (,,,, endsAt) = ac.TREASURY().lockedLiquidity(CARD);
    }

    function _optIn() internal {
        vm.prank(owner);
        CARDS.setApprovalForAll(address(ac), true);
    }

    function test_paysOwnerInWindow_evenWhenStrangerCalls() public {
        _optIn();
        vm.warp(endsAt - 1 hours);
        require(ac.cashable(CARD), "should be cashable");
        uint256 before = USDCE.balanceOf(owner);
        vm.prank(address(0xBEEF));
        ac.cash(CARD);
        require(USDCE.balanceOf(owner) > before, "owner not paid");
        require(USDCE.balanceOf(address(0xBEEF)) == 0, "stranger paid");
        require(USDCE.balanceOf(address(ac)) == 0, "contract kept funds");
    }

    function test_revertsBeforeWindow() public {
        _optIn();
        vm.warp(endsAt - 7 hours);
        require(!ac.cashable(CARD), "cashable too early");
        vm.expectRevert(abi.encodeWithSelector(FreezeAutoCash.TooEarly.selector, CARD, uint256(endsAt)));
        ac.cash(CARD);
    }

    function test_revertsAfterEnd() public {
        _optIn();
        vm.warp(endsAt + 1);
        vm.expectRevert(abi.encodeWithSelector(FreezeAutoCash.Ended.selector, CARD));
        ac.cash(CARD);
    }

    function test_needsOptIn() public {
        vm.warp(endsAt - 1 hours);
        require(!ac.cashable(CARD), "cashable without opt in");
        vm.expectRevert(bytes("You can not execute this option strat"));
        ac.cash(CARD);
    }

    function test_paysNewOwnerAfterGift() public {
        address friend = address(0xF00D);
        vm.prank(owner);
        CARDS.transferFrom(owner, friend, CARD);
        vm.prank(friend);
        CARDS.setApprovalForAll(address(ac), true);
        vm.warp(endsAt - 1 hours);
        uint256 before = USDCE.balanceOf(friend);
        ac.cash(CARD);
        require(USDCE.balanceOf(friend) > before, "new owner not paid");
    }

    function test_cannotCashTwice() public {
        _optIn();
        vm.warp(endsAt - 1 hours);
        ac.cash(CARD);
        require(!ac.cashable(CARD), "still cashable");
        vm.expectRevert(abi.encodeWithSelector(FreezeAutoCash.AlreadyCashed.selector, CARD));
        ac.cash(CARD);
    }
}
