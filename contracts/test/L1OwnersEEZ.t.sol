// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {OwnerFixture, OwnerTestTarget} from "./helpers/OwnerFixture.sol";
import {EEZL2} from "eez-core-protocol/src/L2/EEZL2.sol";
import {ExecutionEntry, StaticExecutionEntryL2} from "eez-core-protocol/src/interfaces/IEEZL2.sol";
import {L1Owners} from "../src/l2/L1Owners.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";

/// @dev Actual pinned EEZL2 and proxy, with a manually loaded table derived from an L1
///      Safe call. This checks the adapter's real static route and table identity. It is
///      not Composer/signature/proof/follower or L1 settlement evidence.
contract L1OwnersEEZTest is OwnerFixture {
    EEZL2 private manager;
    address private constant SYSTEM = address(0xeeee);

    function setUp() public override {
        super.setUp();
        manager = new EEZL2(ROLLUP_ID, SYSTEM, false, SYSTEM);
        manager.getOrCreateCrossChainProxy(address(safeL1), 0);
        adapter = new L1Owners(IEEZProxyRegistry(address(manager)), address(safeL1));
        l1.getOrCreateCrossChainProxy(address(adapter), ROLLUP_ID);
        safeL2 = _safeForAdapter(adapter);
    }

    function _row(bytes memory data, bytes memory inner) private returns (StaticExecutionEntryL2[] memory rows) {
        bytes memory preimage = _preimage(safeL2, address(target), data, 0);
        bytes memory remoteCall = abi.encodeCall(ISafe.checkSignatures, (keccak256(preimage), preimage, inner));
        address alias_ = l1.computeCrossChainProxyAddress(address(adapter), ROLLUP_ID);
        // Observe the actual L1 Safe result with the adapter alias as caller. No canned success.
        vm.prank(alias_);
        (bool success, bytes memory result) = address(safeL1).staticcall(remoteCall);
        rows = new StaticExecutionEntryL2[](1);
        rows[0].proxyEntryHash =
            manager.computeCrossChainCallHash(true, address(adapter), ROLLUP_ID, address(safeL1), 0, 0, 0, remoteCall);
        rows[0].success = success;
        rows[0].returnData = result;
    }

    function _load(StaticExecutionEntryL2[] memory rows) private {
        vm.prank(SYSTEM);
        manager.loadExecutionTable(new ExecutionEntry[](0), rows);
    }

    function testActualStaticProxyPathFromSafeSignatureCheck() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (42));
        bytes memory inner = _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), A, B);
        _load(_row(data, inner));
        assertTrue(_execute(safeL2, address(target), data, 0, _outer(adapter, inner)));
        assertEq(target.value(), 42);
        assertEq(safeL2.nonce(), 1);
        assertEq(manager.entryIndex(), 0, "static verification must not advance mutable cursor");
    }

    function testRemoteVerificationFailurePropagates() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (42));
        bytes memory inner = _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), B, C);
        StaticExecutionEntryL2[] memory rows = _row(data, inner);
        assertFalse(rows[0].success);
        _load(rows);
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, _outer(adapter, inner));
        assertEq(target.value(), 0);
        assertEq(safeL2.nonce(), 0);
    }

    function testMissingMispositionedAndStaleTableRejected() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (42));
        bytes memory inner = _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), A, B);
        StaticExecutionEntryL2[] memory rows = _row(data, inner);
        _load(new StaticExecutionEntryL2[](0));
        vm.expectPartialRevert(EEZL2.EntryNotFound.selector);
        _execute(safeL2, address(target), data, 0, _outer(adapter, inner));
        rows[0].expectedEntryIndex = 1;
        _load(rows);
        vm.expectPartialRevert(EEZL2.EntryNotFound.selector);
        _execute(safeL2, address(target), data, 0, _outer(adapter, inner));
        rows[0].expectedEntryIndex = 0;
        _load(rows);
        vm.roll(block.number + 1);
        vm.expectRevert(EEZL2.ExecutionNotInCurrentBlock.selector);
        _execute(safeL2, address(target), data, 0, _outer(adapter, inner));
        assertEq(safeL2.nonce(), 0);
    }

    function testWrongCallIdentityIsNotAccepted() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (42));
        bytes memory inner = _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), A, B);
        StaticExecutionEntryL2[] memory rows = _row(data, inner);
        rows[0].proxyEntryHash = keccak256("different caller or calldata");
        _load(rows);
        vm.expectPartialRevert(EEZL2.EntryNotFound.selector);
        _execute(safeL2, address(target), data, 0, _outer(adapter, inner));
        assertEq(safeL2.nonce(), 0);
    }
}
