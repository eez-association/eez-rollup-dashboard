// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {SharedTestUSDC} from "../src/chiado/SharedTestUSDC.sol";
import {TestUSDCFaucet} from "../src/chiado/TestUSDCFaucet.sol";

contract FaucetBridgeFixture {
    address public immutable canonicalToken;
    uint64 public constant treasuryRollupId = 1;
    uint64 public constant rollupId = 0;
    mapping(address => uint256) public received;
    bool public fail;
    error BridgeFailure();

    constructor(address token) {
        canonicalToken = token;
    }

    function setFail(bool value) external {
        fail = value;
    }

    function bridgeTokens(address token, uint256 amount, uint64 destination, address recipient) external {
        require(token == canonicalToken && destination == treasuryRollupId);
        SharedTestUSDC(token).transferFrom(msg.sender, address(this), amount);
        received[recipient] += amount;
        if (fail) revert BridgeFailure();
    }
}

contract TestUSDCFaucetTest is Test {
    SharedTestUSDC token;
    FaucetBridgeFixture bridge;
    address recipient = address(0xCAFE);

    function setUp() public {
        token = new SharedTestUSDC();
        bridge = new FaucetBridgeFixture(address(token));
    }

    function testExactRepeatedFractionalRequestsToFundedRecipient() public {
        vm.prank(recipient);
        token.claim();
        uint256 supply = token.totalSupply();
        TestUSDCFaucet faucet = new TestUSDCFaucet(address(token), address(bridge));
        faucet.request(recipient, 1_234_567, false);
        assertEq(token.balanceOf(recipient), 451_234_567);
        assertEq(token.balanceOf(address(faucet)), 448_765_433);
        vm.prank(recipient);
        faucet.request(recipient, 2_000_001, false);
        assertEq(token.balanceOf(recipient), 453_234_568);
        assertEq(token.totalSupply(), supply + 450_000_000, "reuse the reserve without another claim");
        faucet.request(address(0xBEEF), 1_000_000_123, false);
        assertEq(token.balanceOf(address(0xBEEF)), 1_000_000_123);
        assertEq(token.balanceOf(recipient), 453_234_568);
        assertEq(token.balanceOf(address(faucet)), 346_765_309);
        assertEq(token.totalSupply(), supply + 1_350_000_000);
    }

    function testRepeatBridgeExactAmount() public {
        TestUSDCFaucet faucet = new TestUSDCFaucet(address(token), address(bridge));
        faucet.request(recipient, 500_000_001, true);
        assertEq(bridge.received(recipient), 500_000_001);
        assertEq(token.balanceOf(address(bridge)), 500_000_001);
        assertEq(token.allowance(address(faucet), address(bridge)), 0);
        faucet.request(recipient, 2_000_000, true);
        assertEq(bridge.received(recipient), 502_000_001);
        assertEq(token.balanceOf(address(bridge)), 502_000_001);
        assertEq(token.balanceOf(address(faucet)), 397_999_999);
        assertEq(token.allowance(address(faucet), address(bridge)), 0);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testRevertAfterMintAndLockRestoresEverything() public {
        TestUSDCFaucet faucet = new TestUSDCFaucet(address(token), address(bridge));
        faucet.request(recipient, 450_000_000, false);
        uint256 supply = token.totalSupply();
        bridge.setFail(true);
        vm.expectRevert(FaucetBridgeFixture.BridgeFailure.selector);
        faucet.request(recipient, 901_000_000, true);
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(address(faucet)), 0);
        assertEq(token.balanceOf(address(bridge)), 0);
        assertEq(token.allowance(address(faucet), address(bridge)), 0);
        assertEq(bridge.received(recipient), 0);
        assertEq(token.balanceOf(recipient), 450_000_000);
        bridge.setFail(false);
        faucet.request(recipient, 1, true);
        assertEq(bridge.received(recipient), 1);
    }

    function testInvalidInputsDoNotMint() public {
        uint256 supply = token.totalSupply();
        TestUSDCFaucet faucet = new TestUSDCFaucet(address(token), address(bridge));
        vm.expectRevert(TestUSDCFaucet.InvalidRequest.selector);
        faucet.request(address(0), 1, false);
        vm.expectRevert(TestUSDCFaucet.InvalidRequest.selector);
        faucet.request(recipient, 0, false);
        FaucetBridgeFixture wrong = new FaucetBridgeFixture(address(0xBAD));
        vm.expectRevert(TestUSDCFaucet.InvalidBridge.selector);
        new TestUSDCFaucet(address(token), address(wrong));
        assertEq(token.totalSupply(), supply);
        vm.expectRevert(TestUSDCFaucet.InvalidRequest.selector);
        faucet.request(address(faucet), 1, false);
    }

    function testFuzzExactAmountAndPooledRemainder(uint64 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1, 10_000_000_000);
        uint256 supply = token.totalSupply();
        TestUSDCFaucet faucet = new TestUSDCFaucet(address(token), address(bridge));
        faucet.request(recipient, amount, false);
        assertEq(token.balanceOf(recipient), amount);
        uint256 minted = token.totalSupply() - supply;
        assertEq(minted, ((amount + 449_999_999) / 450_000_000) * 450_000_000);
        assertEq(token.balanceOf(address(faucet)), minted - amount);
    }
}
