// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {TreasuryPolicyBase} from "../src/l2/TreasuryPolicyBase.sol";
import {OwnerFixture, ReadThroughManager} from "./helpers/OwnerFixture.sol";
import {TreasuryAliasReader} from "../src/chiado/TreasuryAliasReader.sol";
import {TreasuryPolicy} from "../src/chiado/TreasuryPolicy.sol";
import {DevnetUSDC} from "./fixtures/DevnetUSDC.sol";
import {TreasuryBridge} from "../src/chiado/TreasuryBridge.sol";
import {Bridge} from "eez-core-protocol/src/periphery/Bridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceModule} from "../src/interfaces/IAllowanceModule.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";

abstract contract TreasuryPolicyFixture is OwnerFixture {
    TreasuryPolicy policy;
    DevnetUSDC usdc;
    IERC20 wrapped;
    TreasuryBridge bridge1;
    TreasuryBridge bridge2;
    IAllowanceModule module1;
    IAllowanceModule module2;
    address alias_;
    address recipient = address(0x1234);
    uint256 constant U = 1_000_000;

    function setUp() public override {
        super.setUp();
        usdc = new DevnetUSDC();
        bridge1 = new TreasuryBridge(address(usdc), ROLLUP_ID);
        bridge2 = new TreasuryBridge(address(usdc), ROLLUP_ID);
        bridge1.initialize(address(l1), 0, address(this));
        bridge2.initialize(address(l2), ROLLUP_ID, address(this));
        bridge1.setCanonicalBridgeAddress(address(bridge2));
        bridge2.setCanonicalBridgeAddress(address(bridge1));
        usdc.transfer(address(safeL1), 300 * U);
        usdc.approve(address(bridge1), 150 * U);
        bridge1.bridgeTokens(address(usdc), 150 * U, ROLLUP_ID, address(safeL2));
        wrapped = IERC20(bridge2.getWrappedToken(address(usdc), 0));
        module1 = IAllowanceModule(_deployLegacy("AllowanceModule"));
        module2 = IAllowanceModule(_deployLegacy("AllowanceModule"));
        policy = _newPolicy();
        alias_ = l1.getOrCreateCrossChainProxy(address(policy), ROLLUP_ID);
        _adminL1(abi.encodeCall(ISafe.enableModule, (address(module1))));
        _callL2(address(safeL2), abi.encodeCall(ISafe.enableModule, (address(module2))));
        _configure(true, abi.encodeCall(IAllowanceModule.addDelegate, (alias_)));
        _configure(false, abi.encodeCall(IAllowanceModule.addDelegate, (address(policy))));
        _setAllowance(true, 100 * U, 10, uint32(vm.getBlockTimestamp() / 600 * 10));
        _setAllowance(false, 100 * U, 10, uint32(vm.getBlockTimestamp() / 600 * 10));
    }

    function _newPolicy() internal virtual returns (TreasuryPolicy) {
        return new TreasuryPolicy(
            address(safeL1),
            address(safeL2),
            IEEZProxyRegistry(address(l2)),
            address(new TreasuryAliasReader(IEEZProxyRegistry(address(l1)))),
            address(module1),
            module2,
            address(usdc),
            bridge2
        );
    }

    function _configure(bool onL1, bytes memory data) internal {
        if (!onL1) {
            _callL2(address(module2), data);
        } else {
            assertTrue(
                _execute(
                    safeL1,
                    address(module1),
                    data,
                    0,
                    _signTwo(keccak256(_preimage(safeL1, address(module1), data, 0)), A, B)
                )
            );
        }
    }

    function _setAllowance(bool onL1, uint256 amount, uint16 period, uint32 base) internal {
        _configure(
            onL1,
            abi.encodeCall(
                IAllowanceModule.setAllowance,
                (onL1 ? alias_ : address(policy), onL1 ? address(usdc) : address(wrapped), uint96(amount), period, base)
            )
        );
    }

    function _paymentData(bool routed, bool onL1, uint256 amount) internal view returns (bytes memory) {
        uint256 fromL1 = onL1 ? amount : 0;
        if (routed) {
            uint256[5] memory a = (onL1 ? module1 : module2)
            .getTokenAllowance(
                onL1 ? address(safeL1) : address(safeL2),
                onL1 ? alias_ : address(policy),
                onL1 ? address(usdc) : address(wrapped)
            );
            uint256 capacity = a[1] < a[0] ? a[0] - a[1] : 0;
            uint256 balance =
                (onL1 ? IERC20(address(usdc)) : wrapped).balanceOf(onL1 ? address(safeL1) : address(safeL2));
            if (capacity > balance) capacity = balance;
            uint256 local = amount < capacity ? amount : capacity;
            fromL1 = onL1 ? local : amount - local;
        }
        return abi.encodeCall(policy.paySplit, (recipient, amount, onL1, block.timestamp / 600, fromL1));
    }

    function _pay(bool routed, bool onL1, uint256 amount) internal {
        _callL2(address(policy), _paymentData(routed, onL1, amount));
    }

    function _spent(bool onL1) internal view returns (uint256) {
        return (onL1 ? module1 : module2)
        .getTokenAllowance(
            onL1 ? address(safeL1) : address(safeL2),
            onL1 ? alias_ : address(policy),
            onL1 ? address(usdc) : address(wrapped)
        )[1];
    }
}

contract TreasuryPolicyTest is TreasuryPolicyFixture {
    function testProductionPolicyHasNoInvoiceEntryPoint() public {
        vm.prank(address(safeL2));
        (bool success,) = address(policy)
            .call(
                abi.encodeWithSignature(
                    "payInvoice(address,address,uint256,bytes32,uint256)",
                    address(usdc),
                    recipient,
                    U,
                    bytes32("missing"),
                    vm.getBlockTimestamp() / 600
                )
            );
        assertFalse(success);
        assertEq(_spent(false), 0);
        assertEq(_spent(true), 0);
    }

    function testRemoteManagerDestinationIsRejectedButAliasReaderWorks() public {
        address remoteRegistry = l2.getOrCreateCrossChainProxy(address(l1), 0);
        vm.expectRevert(ReadThroughManager.EEZDestinationForbidden.selector);
        IEEZProxyRegistry(remoteRegistry).computeCrossChainProxyAddress(address(policy), ROLLUP_ID);
        TreasuryAliasReader readerProxy = policy.aliasReaderL1Proxy();
        vm.prank(address(policy));
        assertEq(readerProxy.aliasOf(address(policy), ROLLUP_ID), alias_);
    }

    function testFortyThenSplit110ThenGlobalRejectsOneWithL2Capacity() public {
        _pay(false, false, 40 * U);
        _pay(true, true, 110 * U);
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(wrapped.balanceOf(recipient), 40 * U);
        assertEq(usdc.balanceOf(address(safeL1)), 200 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 100 * U);
        assertEq(usdc.balanceOf(address(bridge1)), wrapped.totalSupply());
        assertEq(usdc.balanceOf(address(bridge1)), 140 * U);
        assertEq(_spent(true), 100 * U);
        assertEq(_spent(false), 50 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 150 * U);
        vm.expectRevert(TreasuryPolicyBase.GlobalLimit.selector);
        vm.prank(address(safeL2));
        policy.paySplit(recipient, U, false, vm.getBlockTimestamp() / 600, 0);
        assertEq(_spent(false), 50 * U);
        assertFalse(safeL1.isModuleEnabled(alias_));
        assertFalse(safeL2.isModuleEnabled(address(policy)));
        assertEq(wrapped.balanceOf(address(policy)), 0);
    }

    function testFinalL1TransferFailureRollsBackEarlierBridgeLegAndAllCounters() public {
        _pay(false, false, 40 * U);
        uint256 nonce = safeL2.nonce();
        uint256 l1Nonce = safeL1.nonce();
        uint256[5] memory a1 = module1.getTokenAllowance(address(safeL1), alias_, address(usdc));
        uint256[5] memory a2 = module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped));
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), abi.encode(false));
        bytes memory data =
            abi.encodeCall(policy.paySplit, (recipient, 110 * U, true, vm.getBlockTimestamp() / 600, 100 * U));
        bytes memory signature = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        // Require the earlier escrow release and the later failing transfer to
        // be reached, so an unrelated early rejection cannot satisfy this test.
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signature);
        assertEq(safeL2.nonce(), nonce);
        assertEq(safeL1.nonce(), l1Nonce);
        assertEq(wrapped.balanceOf(address(policy)), 0);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(wrapped.balanceOf(recipient), 40 * U);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 300 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 110 * U);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 40 * U);
        assertEq(abi.encode(a1), abi.encode(module1.getTokenAllowance(address(safeL1), alias_, address(usdc))));
        assertEq(
            abi.encode(a2), abi.encode(module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped)))
        );
    }

    function testCombinedToL2LocksAndMintsWithExactConsumedApproval() public {
        _pay(true, false, 110 * U);
        assertEq(wrapped.balanceOf(recipient), 110 * U);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 290 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 50 * U);
        assertEq(_spent(true), 10 * U);
        assertEq(_spent(false), 100 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 110 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 160 * U);
        assertEq(wrapped.totalSupply(), 160 * U);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(wrapped.balanceOf(address(policy)), 0);
        assertEq(usdc.allowance(alias_, address(bridge1)), 0);
        assertEq(bridge2.nextDepositNonce(), 1);
        assertTrue(bridge1.lockedDeposits(0));
        // The new representation shares the existing burn/release backing.
        vm.prank(recipient);
        bridge2.bridgeTokens(address(wrapped), 110 * U, 0, recipient);
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(usdc.balanceOf(address(bridge1)), wrapped.totalSupply());
    }

    function testL2DestinationUsesBalanceAndCanBeEntirelyFundedFromL1() public {
        vm.prank(address(safeL2));
        wrapped.transfer(address(0xbeef), 150 * U);
        _pay(true, false, 90 * U);
        assertEq(_spent(true), 90 * U);
        assertEq(_spent(false), 0);
        assertEq(wrapped.balanceOf(recipient), 90 * U);
        assertEq(usdc.balanceOf(address(bridge1)), wrapped.totalSupply());
    }

    function testLockFailureRollsBackEarlierLocalTransferAndBothAllowances() public {
        uint256 nonce = safeL2.nonce();
        uint256[5] memory a1 = module1.getTokenAllowance(address(safeL1), alias_, address(usdc));
        uint256[5] memory a2 = module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped));
        bytes memory lockCall = abi.encodeCall(IERC20.transferFrom, (alias_, address(bridge1), 10 * U));
        vm.mockCall(address(usdc), lockCall, abi.encode(false));
        bytes memory data =
            abi.encodeCall(policy.paySplit, (recipient, 110 * U, false, vm.getBlockTimestamp() / 600, 10 * U));
        bytes memory signature = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        vm.expectCall(address(wrapped), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (alias_, 10 * U)), 1);
        vm.expectCall(address(usdc), lockCall, 1);
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signature);
        assertEq(safeL2.nonce(), nonce);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 300 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 150 * U);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(usdc.allowance(alias_, address(bridge1)), 0);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 0);
        assertEq(bridge2.nextDepositNonce(), 0);
        assertFalse(bridge1.lockedDeposits(0));
        assertEq(abi.encode(a1), abi.encode(module1.getTokenAllowance(address(safeL1), alias_, address(usdc))));
        assertEq(
            abi.encode(a2), abi.encode(module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped)))
        );
    }

    function testLockAuthenticatesBridgeAndRejectsConsumedNonce() public {
        vm.expectRevert(Bridge.UnauthorizedCaller.selector);
        bridge1.lockForL2(address(policy), 10 * U, recipient, 0);
        _pay(true, false, 110 * U);
        address bridgeAlias = l1.computeCrossChainProxyAddress(address(bridge2), ROLLUP_ID);
        vm.expectRevert(TreasuryBridge.DepositAlreadyLocked.selector);
        vm.prank(bridgeAlias);
        bridge1.lockForL2(address(policy), 10 * U, recipient, 0);
        assertEq(wrapped.balanceOf(recipient), 110 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 160 * U);
    }

    function testCallerCannotUseAnotherPayersAliasApproval() public {
        vm.prank(address(safeL1));
        usdc.transfer(alias_, U);
        vm.prank(alias_);
        usdc.approve(address(bridge1), U);
        // bridgeFromL1 has no payer argument. An unrelated caller can only spend
        // its own alias, even when the policy's alias has funds and an approval.
        vm.expectRevert(
            abi.encodeWithSignature("ERC20InsufficientAllowance(address,uint256,uint256)", address(bridge1), 0, U)
        );
        bridge2.bridgeFromL1(U, recipient);
        assertEq(usdc.balanceOf(alias_), U);
        assertEq(usdc.allowance(alias_, address(bridge1)), U);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(bridge2.nextDepositNonce(), 0);
        assertFalse(bridge1.lockedDeposits(0));
    }

    function testMalformedLockReceiptCannotMint() public {
        address proxy = l2.getOrCreateCrossChainProxy(address(bridge1), 0);
        vm.mockCall(address(proxy), abi.encodeWithSelector(TreasuryBridge.lockForL2.selector), abi.encode(bytes32(0)));
        vm.expectRevert(TreasuryBridge.InvalidLockReceipt.selector);
        bridge2.bridgeFromL1(U, recipient);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(bridge2.nextDepositNonce(), 0);
    }

    function testLockRejectsTransferWithoutExactEscrowCredit() public {
        address bridgeAlias = l1.getOrCreateCrossChainProxy(address(bridge2), ROLLUP_ID);
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transferFrom, (alias_, address(bridge1), U)), abi.encode(true));
        vm.expectRevert(TreasuryBridge.InexactLock.selector);
        vm.prank(bridgeAlias);
        bridge1.lockForL2(address(policy), U, recipient, 0);
        assertFalse(bridge1.lockedDeposits(0));
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
    }

    function testBridgeRejectsWrongSideAndInvalidArguments() public {
        vm.expectRevert(TreasuryBridge.InvalidRoute.selector);
        bridge1.bridgeFromL1(U, recipient);
        vm.expectRevert(Bridge.ZeroAmount.selector);
        bridge2.bridgeFromL1(0, recipient);
        vm.expectRevert(Bridge.ZeroAddress.selector);
        bridge2.bridgeFromL1(U, address(0));
        bridge2.setCanonicalBridgeAddress(address(0xbeef));
        vm.expectRevert(TreasuryPolicyBase.InvalidConfiguration.selector);
        vm.prank(address(safeL2));
        policy.paySplit(recipient, U, false, vm.getBlockTimestamp() / 600, 0);
    }

    function testRouterUsesBalanceAsWellAsAllowance() public {
        vm.prank(address(safeL1));
        usdc.transfer(address(0xbeef), 250 * U);
        _pay(true, true, 60 * U);
        assertEq(_spent(true), 50 * U);
        assertEq(_spent(false), 10 * U);
        assertEq(usdc.balanceOf(recipient), 60 * U);
    }

    function testPeriodResetAndSignedEpochRejectStaleApproval() public {
        _pay(false, false, 40 * U);
        _pay(true, true, 110 * U);
        uint256 old = vm.getBlockTimestamp() / 600;
        vm.warp((old + 1) * 600 - 1);
        assertEq(_spent(false), 50 * U);
        vm.warp((old + 1) * 600);
        assertEq(_spent(true), 0);
        assertEq(_spent(false), 0);
        vm.expectRevert(TreasuryPolicyBase.StaleEpoch.selector);
        vm.prank(address(safeL2));
        policy.paySplit(recipient, U, false, old, 0);
        _pay(false, false, U);
        assertEq(policy.spent(old), 150 * U);
        assertEq(policy.spent(old + 1), U);
    }

    function testOnlySafeAndCheckedAmounts() public {
        vm.expectRevert(TreasuryPolicyBase.OnlySafe.selector);
        policy.paySplit(recipient, U, false, vm.getBlockTimestamp() / 600, 0);
        vm.startPrank(address(safeL2));
        vm.expectRevert(TreasuryPolicyBase.InvalidAmount.selector);
        policy.paySplit(recipient, type(uint256).max, false, vm.getBlockTimestamp() / 600, 0);
        vm.expectRevert(TreasuryPolicyBase.InvalidAmount.selector);
        policy.paySplit(recipient, 0, false, vm.getBlockTimestamp() / 600, 0);
        vm.expectRevert(TreasuryPolicyBase.InvalidRecipient.selector);
        policy.paySplit(address(policy), U, false, vm.getBlockTimestamp() / 600, 0);
        vm.expectRevert(TreasuryPolicyBase.Capacity.selector);
        policy.paySplit(recipient, 101 * U, true, vm.getBlockTimestamp() / 600, 101 * U);
        vm.expectRevert(TreasuryPolicyBase.Capacity.selector);
        policy.paySplit(recipient, 101 * U, false, vm.getBlockTimestamp() / 600, 0);
        vm.stopPrank();
    }

    function testMisalignedAllowanceCannotCrossEpochs() public {
        _setAllowance(true, 100 * U, 11, uint32(vm.getBlockTimestamp() / 60));
        vm.expectRevert(TreasuryPolicyBase.UnalignedAllowance.selector);
        vm.prank(address(safeL2));
        policy.paySplit(recipient, U, true, vm.getBlockTimestamp() / 600, U);
    }

    function testFuzzLocalPaymentCannotExceedEitherBudget(uint96 amount) public {
        amount = uint96(bound(amount, 1, 100 * U));
        _pay(false, false, amount);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), amount);
        assertEq(_spent(false), amount);
        assertEq(wrapped.balanceOf(recipient), amount);
    }

    function testSignedSplitKeepsItsAmountAfterAnL1OwnerTransfer() public {
        bytes memory data =
            abi.encodeCall(policy.paySplit, (recipient, 45 * U, true, vm.getBlockTimestamp() / 600, 45 * U));
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        bytes memory transfer = abi.encodeCall(IERC20.transfer, (address(0xbeef), 100 * U));
        assertTrue(
            _execute(
                safeL1,
                address(usdc),
                transfer,
                0,
                _signTwo(keccak256(_preimage(safeL1, address(usdc), transfer, 0)), A, B)
            )
        );
        // A change in holdings does not change the signed amount or contribution.
        assertTrue(_execute(safeL2, address(policy), data, 0, signatures));
        assertEq(usdc.balanceOf(recipient), 45 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 45 * U);
    }

    function testSplitLaterTransferFailureRollsBackItsEarlierBridgeContribution() public {
        _pay(false, true, 90 * U);
        uint256 nonce = safeL2.nonce();
        uint256[5] memory a1 = module1.getTokenAllowance(address(safeL1), alias_, address(usdc));
        uint256[5] memory a2 = module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped));
        bytes memory data =
            abi.encodeCall(policy.paySplit, (recipient, 36 * U, true, vm.getBlockTimestamp() / 600, 10 * U));
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), abi.encode(false));
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 26 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signatures);
        assertEq(safeL2.nonce(), nonce);
        assertEq(usdc.balanceOf(recipient), 90 * U);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 210 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 150 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(wrapped.balanceOf(address(policy)), 0);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 90 * U);
        assertEq(abi.encode(a1), abi.encode(module1.getTokenAllowance(address(safeL1), alias_, address(usdc))));
        assertEq(
            abi.encode(a2), abi.encode(module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped)))
        );
    }

    function testOldPaymentSelectorsCannotExecuteOnNewPolicy() public {
        assertEq(policy.SPLIT_VERSION(), 2);
        vm.prank(address(safeL2));
        (bool success,) = address(policy)
            .call(
                abi.encodeWithSignature(
                    "paySplit(address,address,uint256,bool,uint256,uint256)",
                    address(usdc),
                    recipient,
                    U,
                    false,
                    block.timestamp / 600,
                    0
                )
            );
        assertFalse(success);
        vm.prank(address(safeL2));
        (success,) = address(policy)
            .call(
                abi.encodeWithSignature(
                    "payRule(address,address,uint16,bool,uint256)",
                    address(usdc),
                    recipient,
                    uint16(1000),
                    true,
                    block.timestamp / 600
                )
            );
        assertFalse(success);
        vm.prank(address(safeL2));
        (success,) = address(policy)
            .call(
                abi.encodeWithSignature(
                    "payRule(address,uint16,bool,uint256)", recipient, uint16(1000), true, block.timestamp / 600
                )
            );
        assertFalse(success);
        assertEq(_spent(true), 0);
        assertEq(_spent(false), 0);
        assertEq(policy.spent(block.timestamp / 600), 0);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(wrapped.balanceOf(recipient), 0);
    }
}
