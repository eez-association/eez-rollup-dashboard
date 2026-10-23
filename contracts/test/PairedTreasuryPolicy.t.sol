// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {OwnerFixture} from "./helpers/OwnerFixture.sol";
import {TreasuryPolicyL1} from "../src/l1/TreasuryPolicyL1.sol";
import {TreasuryPolicyL2} from "../src/l2/TreasuryPolicyL2.sol";
import {PairedTreasuryPolicy} from "../src/shared/PairedTreasuryPolicy.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {IStandardBridge} from "../src/interfaces/IStandardBridge.sol";
import {IAllowanceModule} from "../src/interfaces/IAllowanceModule.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {Bridge} from "eez-core-protocol/src/periphery/Bridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Real Safes, allowance modules and normal bridges. OwnerFixture substitutes
/// synchronous single-EVM delivery for EEZ execution tables; no native proof claim.
contract PairedTreasuryPolicyTest is OwnerFixture {
    TreasuryPolicyL1 internal policy1;
    TreasuryPolicyL2 internal policy2;
    TestUSDC internal usdc;
    IERC20 internal wrapped;
    Bridge internal bridge1;
    Bridge internal bridge2;
    IAllowanceModule internal module1;
    IAllowanceModule internal module2;
    address internal recipient = address(0x1234);
    uint256 internal constant U = 1_000_000;

    function setUp() public override {
        super.setUp();
        bridge1 = new Bridge();
        bridge2 = new Bridge();
        bridge1.initialize(address(l1), 0, address(this));
        bridge2.initialize(address(l2), ROLLUP_ID, address(this));
        bridge1.setCanonicalBridgeAddress(address(bridge2));
        bridge2.setCanonicalBridgeAddress(address(bridge1));
        usdc = new TestUSDC(IStandardBridge(address(bridge1)), ROLLUP_ID);
        usdc.claim(address(safeL1));
        usdc.claimOnL2(address(safeL2));
        wrapped = IERC20(bridge2.getWrappedToken(address(usdc), 0));
        module1 = IAllowanceModule(_deployLegacy("AllowanceModule"));
        module2 = IAllowanceModule(_deployLegacy("AllowanceModule"));
        policy1 = new TreasuryPolicyL1(address(safeL1), module1, usdc, IStandardBridge(address(bridge1)), ROLLUP_ID);
        policy2 = new TreasuryPolicyL2(address(safeL2), module2, wrapped, IStandardBridge(address(bridge2)), ROLLUP_ID);
        _callSafe(true, address(policy1), abi.encodeCall(policy1.connectPeer, (address(policy2))));
        _callSafe(false, address(policy2), abi.encodeCall(policy2.connectPeer, (address(policy1))));
        _callSafe(true, address(safeL1), abi.encodeCall(ISafe.enableModule, (address(module1))));
        _callSafe(false, address(safeL2), abi.encodeCall(ISafe.enableModule, (address(module2))));
        _callSafe(true, address(module1), abi.encodeCall(IAllowanceModule.addDelegate, (address(policy1))));
        _callSafe(false, address(module2), abi.encodeCall(IAllowanceModule.addDelegate, (address(policy2))));
        _setAllowance(true, 100 * U);
        _setAllowance(false, 100 * U);
    }

    function _callSafe(bool onL1, address to, bytes memory data) internal {
        if (onL1) {
            bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, to, data, 0)), A, B);
            assertTrue(_execute(safeL1, to, data, 0, signatures));
        } else {
            _callL2(to, data);
        }
    }

    function _setAllowance(bool onL1, uint256 amount) internal {
        _callSafe(onL1, onL1 ? address(module1) : address(module2), abi.encodeCall(IAllowanceModule.setAllowance, (
            onL1 ? address(policy1) : address(policy2), onL1 ? address(usdc) : address(wrapped),
            uint96(amount), 10, uint32(block.timestamp / 600 * 10)
        )));
    }

    function _pay(bool startL1, bool onL1, uint256 amount, uint256 fromL1) internal {
        address policy = startL1 ? address(policy1) : address(policy2);
        _callSafe(startL1, policy, abi.encodeCall(PairedTreasuryPolicy.paySplit, (
            recipient, amount, onL1, block.timestamp / 600, fromL1
        )));
    }

    function _expectL1Failure(bytes memory) internal virtual {
        vm.expectRevert("GS013");
    }

    function _signedPayment(bool startL1, bool onL1, uint256 amount, uint256 fromL1)
        internal view returns (ISafe account, address policy, bytes memory data, bytes memory signatures)
    {
        account = startL1 ? safeL1 : safeL2;
        policy = startL1 ? address(policy1) : address(policy2);
        data = abi.encodeCall(PairedTreasuryPolicy.paySplit, (recipient, amount, onL1, block.timestamp / 600, fromL1));
        signatures = _signTwo(keccak256(_preimage(account, policy, data, 0)), A, B);
        if (!startL1) signatures = _outer(adapter, signatures);
    }

    function _expectPaymentFailure(bool startL1, bool onL1, uint256 amount, uint256 fromL1, bytes memory reason) internal {
        (ISafe account, address policy, bytes memory data, bytes memory signatures) = _signedPayment(startL1, onL1, amount, fromL1);
        // Prepare signatures and nonce reads before setting the next-call expectation.
        if (startL1) _expectL1Failure(reason);
        else vm.expectRevert("GS013");
        _execute(account, policy, data, 0, signatures);
    }

    function _snapshot() internal view returns (bytes32) {
        return keccak256(abi.encode(
            usdc.balanceOf(address(safeL1)), wrapped.balanceOf(address(safeL2)),
            usdc.balanceOf(recipient), wrapped.balanceOf(recipient),
            usdc.balanceOf(address(bridge1)), wrapped.totalSupply(),
            module1.getTokenAllowance(address(safeL1), address(policy1), address(usdc)),
            module2.getTokenAllowance(address(safeL2), address(policy2), address(wrapped)),
            policy2.spent(block.timestamp / 600), safeL1.nonce(), safeL2.nonce()
        ));
    }

    function testFuzzExactSplitFromEitherSafeToEitherChain(bool startL1, bool onL1, uint96 raw, uint96 split) public {
        uint256 amount = bound(uint256(raw), 1, 150 * U);
        uint256 fromL1 = bound(uint256(split), amount > 100 * U ? amount - 100 * U : 0, amount < 100 * U ? amount : 100 * U);
        _pay(startL1, onL1, amount, fromL1);
        assertEq(usdc.balanceOf(address(safeL1)), 1000 * U - fromL1);
        assertEq(wrapped.balanceOf(address(safeL2)), 1000 * U - (amount - fromL1));
        assertEq(usdc.balanceOf(recipient), onL1 ? amount : 0);
        assertEq(wrapped.balanceOf(recipient), onL1 ? 0 : amount);
        assertEq(policy1.spent(block.timestamp / 600), amount);
        assertEq(policy2.spent(block.timestamp / 600), amount);
        assertEq(wrapped.totalSupply(), usdc.balanceOf(address(bridge1)));
        assertEq(usdc.balanceOf(address(policy1)), 0);
        assertEq(wrapped.balanceOf(address(policy2)), 0);
        assertEq(usdc.allowance(address(policy1), address(bridge1)), 0);
        assertEq(wrapped.allowance(address(policy2), address(bridge2)), 0);
    }

    function testFuzzLocalContributionTransfersFirst(bool startL1, bool onL1) public {
        vm.recordLogs();
        _pay(startL1, onL1, 120 * U, 80 * U);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        address firstSafe;
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.topics.length != 3 || log.topics[0] != transferTopic) continue;
            address sender = address(uint160(uint256(log.topics[1])));
            if ((log.emitter == address(usdc) && sender == address(safeL1))
                || (log.emitter == address(wrapped) && sender == address(safeL2))) {
                if (count == 0) firstSafe = sender;
                ++count;
            }
        }
        assertEq(count, 2);
        assertEq(firstSafe, startL1 ? address(safeL1) : address(safeL2));
    }

    function testGlobalBudgetCountsBothInitiatorsAndZeroRemoteContribution() public {
        _pay(false, false, 140 * U, 90 * U);
        bytes32 beforeState = _snapshot();
        _expectPaymentFailure(true, false, 20 * U, 10 * U, abi.encodeWithSelector(PairedTreasuryPolicy.GlobalLimit.selector));
        assertEq(_snapshot(), beforeState);
        // L1 transfers locally first; L2 must count it even though L2 contributes zero.
        _pay(true, true, 10 * U, 10 * U);
        assertEq(policy2.spent(block.timestamp / 600), 150 * U);
        beforeState = _snapshot();
        _expectPaymentFailure(false, false, U, 0, abi.encodeWithSelector(PairedTreasuryPolicy.GlobalLimit.selector));
        assertEq(_snapshot(), beforeState);
    }

    function testFuzzPeerFailureRollsBackLocalTransferAndSafeNonce(bool startL1, bool onL1) public {
        _setAllowance(!startL1, 0);
        bytes32 beforeState = _snapshot();
        _expectPaymentFailure(startL1, onL1, 120 * U, 80 * U, abi.encodeWithSelector(PairedTreasuryPolicy.Capacity.selector));
        assertEq(_snapshot(), beforeState);
        assertEq(usdc.allowance(address(policy1), address(bridge1)), 0);
    }

    function testOnlyLocalSafeAndAuthenticatedPeerCanSpend() public {
        uint256 epoch = block.timestamp / 600;
        vm.expectRevert(PairedTreasuryPolicy.OnlySafe.selector);
        policy1.paySplit(recipient, U, true, epoch, U);
        vm.expectRevert(PairedTreasuryPolicy.OnlySafe.selector);
        policy2.paySplit(recipient, U, false, epoch, 0);
        vm.expectRevert(PairedTreasuryPolicy.OnlyPeer.selector);
        policy1.payFromPeer(recipient, U, true, epoch, U);
        vm.prank(address(policy2)); // Original peer address is not its authenticated L1 proxy.
        vm.expectRevert(PairedTreasuryPolicy.OnlyPeer.selector);
        policy1.payFromPeer(recipient, U, true, epoch, U);
        address stranger = l1.getOrCreateCrossChainProxy(address(0xBEEF), ROLLUP_ID);
        vm.prank(stranger);
        vm.expectRevert(PairedTreasuryPolicy.OnlyPeer.selector);
        policy1.payFromPeer(recipient, U, true, epoch, U);
    }

    function testPeerConnectionRequiresSafeAndCannotBeChanged() public {
        TreasuryPolicyL1 fresh = new TreasuryPolicyL1(address(safeL1), module1, usdc, IStandardBridge(address(bridge1)), ROLLUP_ID);
        vm.expectRevert(PairedTreasuryPolicy.OnlySafe.selector);
        fresh.connectPeer(address(policy2));
        vm.prank(address(safeL1));
        fresh.connectPeer(address(policy2));
        vm.prank(address(safeL1));
        vm.expectRevert(PairedTreasuryPolicy.InvalidConfiguration.selector);
        fresh.connectPeer(address(policy2));
        vm.prank(address(safeL1));
        vm.expectRevert(PairedTreasuryPolicy.InvalidConfiguration.selector);
        fresh.paySplit(recipient, U, true, block.timestamp / 600, U); // peer still points to the original L1 policy
    }

    function testSignedEpochAndAlignedPeriodsRemainRequired() public {
        uint256 old = block.timestamp / 600;
        _pay(true, true, 100 * U, 100 * U);
        vm.warp((old + 1) * 600);
        vm.prank(address(safeL1));
        vm.expectRevert(PairedTreasuryPolicy.StaleEpoch.selector);
        policy1.paySplit(recipient, U, true, old, U);
        _pay(false, false, 100 * U, 0);
        assertEq(policy2.spent(old), 100 * U);
        assertEq(policy2.spent(old + 1), 100 * U);
    }

    function testChangedBridgePeerRejectsPayment() public {
        bridge1.setCanonicalBridgeAddress(address(0xBAD));
        bytes32 beforeState = _snapshot();
        _expectPaymentFailure(true, true, U, U, abi.encodeWithSelector(PairedTreasuryPolicy.InvalidConfiguration.selector));
        assertEq(_snapshot(), beforeState);
    }

    function testFuzzChangedSplitAndReplayRejectOwnerSignatures(bool startL1) public {
        (ISafe account, address policy, bytes memory data, bytes memory signatures) = _signedPayment(startL1, false, 120 * U, 80 * U);
        bytes memory changed = abi.encodeCall(PairedTreasuryPolicy.paySplit, (recipient, 120 * U, false, block.timestamp / 600, 81 * U));
        bytes32 beforeState = _snapshot();
        vm.expectRevert();
        _execute(account, policy, changed, 0, signatures);
        assertEq(_snapshot(), beforeState);
        assertTrue(_execute(account, policy, data, 0, signatures));
        beforeState = _snapshot();
        vm.expectRevert();
        _execute(account, policy, data, 0, signatures);
        assertEq(_snapshot(), beforeState);
    }

    function testConstructorsRejectTheWrongSide() public {
        vm.expectRevert(PairedTreasuryPolicy.InvalidConfiguration.selector);
        new TreasuryPolicyL1(address(safeL2), module2, wrapped, IStandardBridge(address(bridge2)), ROLLUP_ID);
        vm.expectRevert(PairedTreasuryPolicy.InvalidConfiguration.selector);
        new TreasuryPolicyL2(address(safeL1), module1, usdc, IStandardBridge(address(bridge1)), ROLLUP_ID);
    }
    function testMisalignedAllowanceRejectsBeforeSpending() public {
        uint256 epoch = block.timestamp / 600;
        _callSafe(true, address(module1), abi.encodeCall(IAllowanceModule.setAllowance, (
            address(policy1), address(usdc), uint96(100 * U), 11, uint32(epoch * 10)
        )));
        bytes32 beforeState = _snapshot();
        vm.prank(address(safeL1));
        vm.expectRevert(PairedTreasuryPolicy.UnalignedAllowance.selector);
        policy1.paySplit(recipient, U, true, epoch, U);
        assertEq(_snapshot(), beforeState);
    }

    function testInvalidAmountsAndInternalRecipientsReject() public {
        uint256 epoch = block.timestamp / 600;
        vm.prank(address(safeL1));
        vm.expectRevert(PairedTreasuryPolicy.InvalidAmount.selector);
        policy1.paySplit(recipient, 0, true, epoch, 0);
        vm.prank(address(safeL1));
        vm.expectRevert(PairedTreasuryPolicy.InvalidAmount.selector);
        policy1.paySplit(recipient, 151 * U, true, epoch, 100 * U);
        vm.prank(address(safeL1));
        vm.expectRevert(PairedTreasuryPolicy.InvalidAmount.selector);
        policy1.paySplit(recipient, U, true, epoch, 2 * U);
        vm.prank(address(safeL1));
        vm.expectRevert(PairedTreasuryPolicy.InvalidRecipient.selector);
        policy1.paySplit(address(policy2), U, true, epoch, U);
    }

}
