// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {IStandardBridge} from "../src/interfaces/IStandardBridge.sol";
import {Bridge} from "eez-core-protocol/src/periphery/Bridge.sol";

interface FaucetVm {
    function prank(address sender) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function getNonce(address account) external view returns (uint64);
}

// Only the remote transport is a fixture. Deposits execute the real normal L1
// Bridge, including its ERC20 transferFrom and token metadata reads. These tests
// establish local escrow/rollback behavior, not cross-chain proof validation.
contract FaucetRemoteReceiver {
    uint256 public received;
    address public recipient;
    address public originalToken;
    bool public fail;

    function setFail(bool value) external {
        fail = value;
    }

    function receiveTokens(
        address token,
        uint64 origin,
        address to,
        uint256 amount,
        string calldata,
        string calldata,
        uint8 decimals,
        uint64 source
    ) external {
        require(origin == 0 && source == 0 && decimals == 6);
        received += amount;
        recipient = to;
        originalToken = token;
        require(!fail, "remote delivery failed");
    }
}

contract FaucetTransportFixture {
    address private immutable receiver;

    constructor(address receiver_) {
        receiver = receiver_;
    }

    function computeCrossChainProxyAddress(address, uint64) external view returns (address) {
        return receiver;
    }
}

contract FaucetNonPullingBridge {
    function rollupId() external pure returns (uint64) {
        return 0;
    }

    function bridgeTokens(address, uint256, uint64, address) external pure {}
}

contract TestUSDCTest {
    FaucetVm private constant vm = FaucetVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestUSDC private token;
    Bridge private bridge;
    FaucetRemoteReceiver private receiver;
    address private constant USER = address(0xABC);
    address private constant RECIPIENT = address(0xDEF);
    uint256 private constant CLAIM = 1_000_000_000;

    function setUp() public {
        receiver = new FaucetRemoteReceiver();
        bridge = new Bridge();
        bridge.initialize(address(new FaucetTransportFixture(address(receiver))), 0, address(this));
        bridge.setCanonicalBridgeAddress(address(receiver));
        token = new TestUSDC(IStandardBridge(address(bridge)), 1);
    }

    function testAnyoneCanClaimRepeatedlyForAnotherRecipient() public {
        assert(token.totalSupply() == 0);
        assert(token.decimals() == 6);
        assert(token.MAX_REQUEST_AMOUNT() == CLAIM);
        vm.prank(USER);
        token.claim(RECIPIENT);
        vm.prank(USER);
        token.claim(RECIPIENT);
        vm.prank(address(0xBEEF));
        token.claim(USER);
        assert(token.balanceOf(RECIPIENT) == 2 * CLAIM);
        assert(token.balanceOf(USER) == CLAIM);
        assert(token.totalSupply() == 3 * CLAIM);
    }

    function testRepeatedL2ClaimsUseNormalBridgeWithoutUserFundsOrHelpers() public {
        token.claim(address(token)); // unrelated existing balance must survive
        uint64 nonce = vm.getNonce(address(token));
        vm.prank(USER);
        token.claimOnL2(RECIPIENT);
        vm.prank(USER);
        token.claimOnL2(RECIPIENT);
        assert(token.balanceOf(USER) == 0);
        assert(token.allowance(USER, address(bridge)) == 0);
        assert(token.balanceOf(address(token)) == CLAIM);
        assert(token.balanceOf(address(bridge)) == 2 * CLAIM);
        assert(token.totalSupply() == 3 * CLAIM);
        assert(token.allowance(address(token), address(bridge)) == 0);
        assert(receiver.received() == 2 * CLAIM);
        assert(receiver.recipient() == RECIPIENT);
        assert(receiver.originalToken() == address(token));
        assert(vm.getNonce(address(token)) == nonce);
    }

    function testFailureAfterLockRollsBackMintEscrowAllowanceAndDelivery() public {
        token.claim(address(token));
        receiver.setFail(true);
        vm.expectRevert();
        token.claimOnL2(RECIPIENT);
        assert(token.totalSupply() == CLAIM);
        assert(token.balanceOf(address(token)) == CLAIM);
        assert(token.balanceOf(address(bridge)) == 0);
        assert(token.allowance(address(token), address(bridge)) == 0);
        assert(receiver.received() == 0);
        receiver.setFail(false);
        token.claimOnL2(RECIPIENT);
        assert(receiver.received() == CLAIM);
    }

    function testConstructorRejectsMissingBridgeAndWrongChain() public {
        vm.expectRevert(TestUSDC.InvalidBridge.selector);
        new TestUSDC(IStandardBridge(address(0)), 1);
        vm.expectRevert(TestUSDC.InvalidBridge.selector);
        new TestUSDC(IStandardBridge(USER), 1);
        vm.expectRevert(TestUSDC.InvalidBridge.selector);
        new TestUSDC(IStandardBridge(address(bridge)), 0);
        Bridge wrongSide = new Bridge();
        wrongSide.initialize(address(new FaucetTransportFixture(address(receiver))), 1, address(this));
        vm.expectRevert(TestUSDC.InvalidBridge.selector);
        new TestUSDC(IStandardBridge(address(wrongSide)), 1);
    }

    function testZeroRecipientDoesNotMint() public {
        vm.expectRevert();
        token.claim(address(0));
        vm.expectRevert(TestUSDC.InvalidRecipient.selector);
        token.claimOnL2(address(0));
        assert(token.totalSupply() == 0);
    }

    function testSuccessfulReturnWithoutPullingTokensReverts() public {
        address broken = address(new FaucetNonPullingBridge());
        TestUSDC fresh = new TestUSDC(IStandardBridge(broken), 1);
        vm.expectRevert(TestUSDC.IncompleteBridge.selector);
        fresh.claimOnL2(RECIPIENT);
        assert(fresh.totalSupply() == 0);
        assert(fresh.allowance(address(fresh), broken) == 0);
    }

    function testTokenCanHoldAndTransferItsOwnTokens() public {
        token.claim(address(token));
        vm.prank(address(token));
        token.transfer(RECIPIENT, 4);
        assert(token.balanceOf(address(token)) == CLAIM - 4);
        assert(token.balanceOf(RECIPIENT) == 4);
    }

    function testSelfTransferPreservesBalanceButTransferFromStillNeedsAllowance() public {
        token.claim(USER);
        vm.prank(USER);
        token.transfer(USER, 4);
        assert(token.balanceOf(USER) == CLAIM);
        vm.prank(USER);
        vm.expectRevert();
        token.transferFrom(USER, USER, 4);
        vm.prank(USER);
        token.approve(USER, 4);
        vm.prank(USER);
        token.transferFrom(USER, USER, 4);
        assert(token.balanceOf(USER) == CLAIM);
        assert(token.allowance(USER, USER) == 0);
        assert(token.totalSupply() == CLAIM);
    }

    function testArbitraryAmountEntryPointsAreAbsent() public {
        (bool mintOk,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", USER, type(uint256).max));
        (bool bridgeOk,) = address(token).call(
            abi.encodeWithSignature("claimOnL2(address,uint256,uint64)", USER, type(uint256).max, uint64(1))
        );
        assert(!mintOk && !bridgeOk);
        assert(token.totalSupply() == 0);
    }
}
