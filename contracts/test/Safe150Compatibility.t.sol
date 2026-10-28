// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PairedTreasuryPolicyTest} from "./PairedTreasuryPolicy.t.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {OwnerTestTarget} from "./helpers/OwnerFixture.sol";

/// @dev Published Safe 1.5.0 bytecode with the current 1.4.1 mirror, adapter and
///      mainnet policy. Inherits the payment/rollback suite using read-through
///      EEZ managers; this does not exercise Composer or proof validation.
contract Safe150CompatibilityTest is PairedTreasuryPolicyTest {
    function _singletonName() internal pure virtual returns (string memory) {
        return "Safe";
    }

    function _deploy150(string memory name, bytes memory args) internal returns (address deployed) {
        string memory fixture = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/safe-150.json"));
        bytes memory creation =
            bytes.concat(vm.parseJsonBytes(fixture, string.concat(".contracts.", name, ".bytecode")), args);
        assembly ("memory-safe") {
            deployed := create(0, add(creation, 32), mload(creation))
        }
        assertTrue(deployed != address(0));
        assertEq(deployed.codehash, vm.parseJsonBytes32(fixture, string.concat(".contracts.", name, ".codeHash")));
    }

    function _newL1Safe(address[] memory owners, uint256 threshold) internal override returns (ISafe safe) {
        address implementation = _deploy150(_singletonName(), "");
        safe = ISafe(_deploy150("SafeProxy", abi.encode(implementation)));
        safe.setup(owners, threshold, address(0), "", address(0), address(0), 0, payable(address(0)));
        assertEq(safe.VERSION(), "1.5.0");
    }

    function _preimage(
        ISafe safe,
        address to,
        bytes memory data,
        uint256 safeTxGas
    )
        internal
        view
        override
        returns (bytes memory)
    {
        if (address(safe) != address(safeL1)) return super._preimage(safe, to, data, safeTxGas);
        // 1.5 no longer exposes encodeTransactionData. Reproduce the frontend's
        // EIP-712 preimage and compare it to the real Safe's hash independently.
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(uint256 chainId,address verifyingContract)"), block.chainid, address(safe)
            )
        );
        bytes32 message = keccak256(
            abi.encode(
                keccak256(
                    "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
                ),
                to,
                uint256(0),
                keccak256(data),
                uint8(0),
                safeTxGas,
                uint256(0),
                uint256(0),
                address(0),
                address(0),
                safe.nonce()
            )
        );
        bytes memory preimage = abi.encodePacked(hex"1901", domain, message);
        assertEq(
            keccak256(preimage),
            safe.getTransactionHash(to, 0, data, 0, safeTxGas, 0, 0, address(0), address(0), safe.nonce())
        );
        return preimage;
    }

    function _expectL1Failure(bytes memory reason) internal override {
        // With zero Safe gas fields, 1.5 bubbles the inner error instead of GS013.
        vm.expectRevert(reason);
    }

    function testLiveOwnerAdditionAndRemovalThroughLegacyVerification() public {
        assertEq(safeL2.VERSION(), "1.4.1");
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (9));
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), B, C));
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, signatures);
        _adminL1(abi.encodeCall(ISafe.addOwnerWithThreshold, (vm.addr(C), 2)));
        assertTrue(_execute(safeL2, address(target), data, 0, signatures));
        assertEq(target.value(), 9);
        signatures = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), B, C));
        _adminL1(abi.encodeCall(ISafe.removeOwner, (address(1), vm.addr(C), 2)));
        uint256 nonce = safeL2.nonce();
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, signatures);
        assertEq(safeL2.nonce(), nonce);
    }

    function testCurrentL1ThresholdRejectsOldQuorum() public {
        _adminL1(abi.encodeCall(ISafe.addOwnerWithThreshold, (vm.addr(C), 2)));
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (5));
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), A, B));
        _adminL1(abi.encodeCall(ISafe.changeThreshold, (3)));
        uint256 nonce = safeL2.nonce();
        vm.expectRevert("GS020");
        _execute(safeL2, address(target), data, 0, signatures);
        assertEq(safeL2.nonce(), nonce);
        assertEq(target.value(), 0);
    }
}

contract Safe150L2CompatibilityTest is Safe150CompatibilityTest {
    function _singletonName() internal pure override returns (string memory) {
        return "SafeL2";
    }
}
