// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TestUSDC} from "../src/l1/TestUSDC.sol";
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

    function setUp() public {
        token = new TestUSDC();
        receiver = new FaucetRemoteReceiver();
        bridge = new Bridge();
        bridge.initialize(address(new FaucetTransportFixture(address(receiver))), 0, address(this));
        bridge.setCanonicalBridgeAddress(address(receiver));
        token.registerBridge(IStandardBridge(address(bridge)));
    }

    function testAnyoneCanMintRepeatedlyForAnotherRecipient() public {
        assert(token.totalSupply() == 0);
        assert(token.decimals() == 6);
        vm.prank(USER);
        token.mint(RECIPIENT, 1_234_567);
        vm.prank(USER);
        token.mint(RECIPIENT, 2_000_001);
        vm.prank(address(0xBEEF));
        token.mint(USER, 999_000_123);
        assert(token.balanceOf(RECIPIENT) == 3_234_568);
        assert(token.balanceOf(USER) == 999_000_123);
        assert(token.totalSupply() == 1_002_234_691);
    }

    function testRepeatedL2ClaimsUseNormalBridgeWithoutUserFundsOrHelpers() public {
        token.mint(address(token), 7); // unrelated existing balance must survive
        uint64 nonce = vm.getNonce(address(token));
        vm.prank(USER);
        token.claimOnL2(RECIPIENT, 100_123_456, 1);
        vm.prank(USER);
        token.claimOnL2(RECIPIENT, 2_000_001, 1);
        assert(token.balanceOf(USER) == 0);
        assert(token.allowance(USER, address(bridge)) == 0);
        assert(token.balanceOf(address(token)) == 7);
        assert(token.balanceOf(address(bridge)) == 102_123_457);
        assert(token.totalSupply() == 102_123_464);
        assert(token.allowance(address(token), address(bridge)) == 0);
        assert(receiver.received() == 102_123_457);
        assert(receiver.recipient() == RECIPIENT);
        assert(receiver.originalToken() == address(token));
        assert(vm.getNonce(address(token)) == nonce);
    }

    function testFailureAfterLockRollsBackMintEscrowAllowanceAndDelivery() public {
        token.mint(address(token), 7);
        receiver.setFail(true);
        vm.expectRevert();
        token.claimOnL2(RECIPIENT, 80_000_000, 1);
        assert(token.totalSupply() == 7);
        assert(token.balanceOf(address(token)) == 7);
        assert(token.balanceOf(address(bridge)) == 0);
        assert(token.allowance(address(token), address(bridge)) == 0);
        assert(receiver.received() == 0);
        receiver.setFail(false);
        token.claimOnL2(RECIPIENT, 1, 1);
        assert(receiver.received() == 1);
    }

    function testOnlyCreatorCanRegisterExactlyOneL1Bridge() public {
        TestUSDC fresh = new TestUSDC();
        vm.prank(USER);
        vm.expectRevert(TestUSDC.InvalidRegistration.selector);
        fresh.registerBridge(IStandardBridge(address(bridge)));
        fresh.registerBridge(IStandardBridge(address(bridge)));
        vm.expectRevert(TestUSDC.InvalidRegistration.selector);
        fresh.registerBridge(IStandardBridge(address(bridge)));
    }

    function testRejectsMissingOrL2Bridge() public {
        TestUSDC fresh = new TestUSDC();
        vm.expectRevert(TestUSDC.InvalidRegistration.selector);
        fresh.registerBridge(IStandardBridge(address(0)));
        vm.expectRevert(TestUSDC.InvalidRegistration.selector);
        fresh.registerBridge(IStandardBridge(USER));
        Bridge wrongSide = new Bridge();
        wrongSide.initialize(address(new FaucetTransportFixture(address(receiver))), 1, address(this));
        vm.expectRevert(TestUSDC.InvalidRegistration.selector);
        fresh.registerBridge(IStandardBridge(address(wrongSide)));
    }

    function testInvalidClaimsDoNotMint() public {
        TestUSDC fresh = new TestUSDC();
        vm.expectRevert(TestUSDC.InvalidRequest.selector);
        fresh.claimOnL2(RECIPIENT, 1, 1);
        vm.expectRevert(TestUSDC.InvalidRequest.selector);
        token.claimOnL2(address(0), 1, 1);
        vm.expectRevert(TestUSDC.InvalidRequest.selector);
        token.claimOnL2(RECIPIENT, 0, 1);
        vm.expectRevert(TestUSDC.InvalidRequest.selector);
        token.claimOnL2(RECIPIENT, 1, 0);
        vm.expectRevert();
        token.mint(address(0), 1);
        assert(token.totalSupply() == 0 && fresh.totalSupply() == 0);
    }

    function testSuccessfulReturnWithoutPullingTokensReverts() public {
        TestUSDC fresh = new TestUSDC();
        address broken = address(new FaucetNonPullingBridge());
        fresh.registerBridge(IStandardBridge(broken));
        vm.expectRevert(TestUSDC.IncompleteBridge.selector);
        fresh.claimOnL2(RECIPIENT, 10, 1);
        assert(fresh.totalSupply() == 0);
        assert(fresh.allowance(address(fresh), broken) == 0);
    }

    function testTokenCanHoldAndTransferItsOwnTokens() public {
        token.mint(address(token), 10);
        vm.prank(address(token));
        token.transfer(RECIPIENT, 4);
        assert(token.balanceOf(address(token)) == 6);
        assert(token.balanceOf(RECIPIENT) == 4);
    }

    function testSelfTransferPreservesBalanceButTransferFromStillNeedsAllowance() public {
        token.mint(USER, 10);
        vm.prank(USER);
        token.transfer(USER, 4);
        assert(token.balanceOf(USER) == 10);
        vm.prank(USER);
        vm.expectRevert();
        token.transferFrom(USER, USER, 4);
        vm.prank(USER);
        token.approve(USER, 4);
        vm.prank(USER);
        token.transferFrom(USER, USER, 4);
        assert(token.balanceOf(USER) == 10);
        assert(token.allowance(USER, USER) == 0);
        assert(token.totalSupply() == 10);
    }

    function testThousandTokenLimitAllowsRepeatedRequests() public {
        uint256 limit = token.MAX_REQUEST_AMOUNT();
        assert(limit == 1_000_000_000);
        vm.prank(USER);
        token.mint(USER, limit);
        vm.prank(USER);
        token.mint(USER, limit);
        vm.prank(USER);
        token.claimOnL2(RECIPIENT, limit, 1);
        vm.prank(USER);
        token.claimOnL2(RECIPIENT, limit, 1);
        assert(token.balanceOf(USER) == 2 * limit);
        assert(token.balanceOf(address(bridge)) == 2 * limit);
        assert(token.totalSupply() == 4 * limit);
    }

    function testRejectsAmountsAboveLimitWithoutMinting() public {
        uint256 tooMuch = token.MAX_REQUEST_AMOUNT() + 1;
        vm.expectRevert(TestUSDC.InvalidRequest.selector);
        token.mint(USER, tooMuch);
        vm.expectRevert(TestUSDC.InvalidRequest.selector);
        token.claimOnL2(RECIPIENT, tooMuch, 1);
        vm.expectRevert(TestUSDC.InvalidRequest.selector);
        token.mint(USER, type(uint256).max);
        vm.expectRevert(TestUSDC.InvalidRequest.selector);
        token.claimOnL2(RECIPIENT, type(uint256).max, 1);
        assert(token.totalSupply() == 0);
        assert(token.allowance(address(token), address(bridge)) == 0);
    }

    function testFuzzExactClaim(uint96 rawAmount) public {
        uint256 amount = uint256(rawAmount) % token.MAX_REQUEST_AMOUNT() + 1;
        vm.prank(USER);
        token.claimOnL2(RECIPIENT, amount, 1);
        assert(token.totalSupply() == amount);
        assert(token.balanceOf(address(bridge)) == amount);
        assert(token.balanceOf(address(token)) == 0);
        assert(token.allowance(address(token), address(bridge)) == 0);
        assert(receiver.received() == amount);
    }
}
