// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {OwnerFixture, ReadThroughManager, OwnerTestTarget} from "./helpers/OwnerFixture.sol";
import {L1Owners} from "../src/l2/L1Owners.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";

contract PreimageCheckingOwner {
    address private immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes calldata data, bytes calldata signature) external view returns (bytes4) {
        require(data.length == 66 && data[0] == 0x19 && data[1] == 0x01, "full Safe preimage required");
        require(signature.length == 65, "signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(ecrecover(keccak256(data), v, r, s) == signer, "signature");
        return 0x20c13b0b;
    }
}

contract L1OwnersTest is OwnerFixture {
    function testEOAQuorumAuthorizesRealSafe() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (7));
        bytes memory preimage = _preimage(safeL2, address(target), data, 0);
        bytes memory signatures = _signTwo(keccak256(preimage), A, B);
        assertEq(adapter.isValidSignature(preimage, signatures), bytes4(0x20c13b0b));
        assertTrue(_execute(safeL2, address(target), data, 0, _outer(adapter, signatures)));
        assertEq(target.value(), 7);
        assertEq(safeL2.nonce(), 1);
        assertEq(safeL1.VERSION(), "1.4.1");
        assertEq(safeL2.getThreshold(), 1);
        assertEq(safeL2.getOwners()[0], address(adapter));
    }

    function testSharedAdapterKeepsMirrorSignatureDomainsSeparate() public {
        ISafe other = _safeForAdapter(adapter);
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (8));
        bytes memory first = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), A, B));
        vm.expectRevert("GS026");
        _execute(other, address(target), data, 0, first);
        assertTrue(_execute(safeL2, address(target), data, 0, first));
        bytes memory second = _outer(adapter, _signTwo(keccak256(_preimage(other, address(target), data, 0)), A, B));
        assertTrue(_execute(other, address(target), data, 0, second));
        assertEq(safeL2.nonce(), 1);
        assertEq(other.nonce(), 1);
        _adminL1(abi.encodeCall(ISafe.changeThreshold, (1)));
        bytes memory single = _outer(adapter, _sign(A, keccak256(_preimage(other, address(target), data, 0))));
        assertTrue(_execute(other, address(target), data, 0, single));
        single = _outer(adapter, _sign(A, keccak256(_preimage(safeL2, address(target), data, 0))));
        assertTrue(_execute(safeL2, address(target), data, 0, single));
    }

    function testAddedOwnerAndSubsequentRemoval() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (9));
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), B, C);
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, _outer(adapter, signatures));
        _adminL1(abi.encodeCall(ISafe.addOwnerWithThreshold, (vm.addr(C), 2)));
        assertTrue(_execute(safeL2, address(target), data, 0, _outer(adapter, signatures)));
        bytes memory nextSignatures = _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), B, C);
        _adminL1(abi.encodeCall(ISafe.removeOwner, (address(1), vm.addr(C), 2)));
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, _outer(adapter, nextSignatures));
        assertEq(safeL2.nonce(), 1);
        assertEq(target.value(), 9);
        _callL2(address(target), data);
        assertEq(safeL2.nonce(), 2);
    }

    function testCurrentThresholdIsReadAtVerification() public {
        _adminL1(abi.encodeCall(ISafe.addOwnerWithThreshold, (vm.addr(C), 2)));
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (5));
        bytes32 hash = keccak256(_preimage(safeL2, address(target), data, 0));
        bytes memory signatures = _signTwo(hash, A, B);
        _adminL1(abi.encodeCall(ISafe.changeThreshold, (3)));
        vm.expectRevert("GS020");
        _execute(safeL2, address(target), data, 0, _outer(adapter, signatures));
        assertEq(safeL2.nonce(), 0);
    }

    function testDuplicateAndInsufficientSignaturesRejected() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (5));
        bytes memory sig = _sign(A, keccak256(_preimage(safeL2, address(target), data, 0)));
        vm.expectRevert("GS020");
        _execute(safeL2, address(target), data, 0, _outer(adapter, sig));
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, _outer(adapter, bytes.concat(sig, sig)));
        assertEq(safeL2.nonce(), 0);
        assertEq(target.value(), 0);
    }

    function testWrongChainWrongSafeAndReplayRejected() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (6));
        vm.chainId(1);
        bytes memory wrongDomain = _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), A, B);
        vm.chainId(L2_CHAIN_ID);
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, _outer(adapter, wrongDomain));
        bytes memory wrongSafe = _signTwo(keccak256(_preimage(safeL1, address(target), data, 0)), A, B);
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, _outer(adapter, wrongSafe));
        bytes memory valid = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), A, B));
        assertTrue(_execute(safeL2, address(target), data, 0, valid));
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), data, 0, valid);
        assertEq(safeL2.nonce(), 1);
    }

    function testFuzz_ChangingCalldataInvalidatesApproval(uint256 approved, uint256 changed) public {
        vm.assume(approved != changed);
        bytes memory first = abi.encodeCall(OwnerTestTarget.setValue, (approved));
        bytes memory signature =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(target), first, 0)), A, B));
        vm.expectRevert("GS026");
        _execute(safeL2, address(target), abi.encodeCall(OwnerTestTarget.setValue, (changed)), 0, signature);
        assertEq(target.value(), 0);
        assertEq(safeL2.nonce(), 0);
    }

    function testEthSignSignaturesUseSafeConvention() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (3));
        bytes32 hash = keccak256(_preimage(safeL2, address(target), data, 0));
        bytes32 personalHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        bytes memory signatures = _signTwo(personalHash, A, B);
        signatures[64] = bytes1(uint8(signatures[64]) + 4);
        signatures[129] = bytes1(uint8(signatures[129]) + 4);
        assertTrue(_execute(safeL2, address(target), data, 0, _outer(adapter, signatures)));
    }

    function testSubmittingOwnerIsNotImplicitlyApprovedOnL1() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (1));
        bytes32 hash = keccak256(_preimage(safeL2, address(target), data, 0));
        bytes memory approvedA = abi.encodePacked(bytes32(uint256(uint160(vm.addr(A)))), bytes32(0), uint8(1));
        bytes memory sigB = _sign(B, hash);
        bytes memory inner = vm.addr(A) < vm.addr(B) ? bytes.concat(approvedA, sigB) : bytes.concat(sigB, approvedA);
        vm.prank(vm.addr(A));
        vm.expectRevert("GS025");
        _execute(safeL2, address(target), data, 0, _outer(adapter, inner));
        vm.prank(vm.addr(A));
        safeL1.approveHash(hash);
        assertTrue(_execute(safeL2, address(target), data, 0, _outer(adapter, inner)));
    }

    function testZeroSafeGasFieldsRevertNonceOnRequiredFailure() public {
        bytes memory data = abi.encodeCall(OwnerTestTarget.fail, ());
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(target), data, 0)), A, B));
        vm.expectRevert("GS013");
        _execute(safeL2, address(target), data, 0, signatures);
        assertEq(safeL2.nonce(), 0);
        // Control: nonzero safeTxGas permits Safe's returned-failure mode.
        signatures = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(target), data, 100_000)), A, B));
        assertFalse(_execute(safeL2, address(target), data, 100_000, signatures));
        assertEq(safeL2.nonce(), 1);
    }

    function testUninitializedRemoteSafeCannotValidateZeroSignatures() public {
        ISafe empty = ISafe(factory.createProxyWithNonce(singleton, "", 100));
        l2.getOrCreateCrossChainProxy(address(empty), 0);
        L1Owners owner = new L1Owners(IEEZProxyRegistry(address(l2)), address(empty));
        l1.getOrCreateCrossChainProxy(address(owner), ROLLUP_ID);
        vm.expectRevert("GS001");
        owner.isValidSignature("data", "");
    }

    function testConstructorRejectsMissingProxyAndWrongIdentity() public {
        address remote = address(0x12345);
        address predicted = l2.computeCrossChainProxyAddress(remote, 0);
        vm.expectRevert(abi.encodeWithSelector(L1Owners.ProxyNotDeployed.selector, predicted));
        new L1Owners(IEEZProxyRegistry(address(l2)), remote);
        l2.getOrCreateCrossChainProxy(remote, 0);
        l2.corruptRegistration(predicted, true, remote, 1);
        vm.expectRevert(abi.encodeWithSelector(L1Owners.InvalidProxyIdentity.selector, predicted));
        new L1Owners(IEEZProxyRegistry(address(l2)), remote);
        l2.corruptRegistration(predicted, true, address(5), 0);
        vm.expectRevert(abi.encodeWithSelector(L1Owners.InvalidProxyIdentity.selector, predicted));
        new L1Owners(IEEZProxyRegistry(address(l2)), remote);
        l2.corruptRegistration(predicted, false, remote, 0);
        vm.expectRevert(abi.encodeWithSelector(L1Owners.InvalidProxyIdentity.selector, predicted));
        new L1Owners(IEEZProxyRegistry(address(l2)), remote);
    }

    function testConstructorRejectsCodelessManagerL1ManagerAndZeroSafe() public {
        vm.expectRevert(L1Owners.InvalidManager.selector);
        new L1Owners(IEEZProxyRegistry(address(99)), address(safeL1));
        vm.expectRevert(L1Owners.InvalidManager.selector);
        new L1Owners(IEEZProxyRegistry(address(l1)), address(safeL1));
        vm.expectRevert(L1Owners.InvalidSafe.selector);
        new L1Owners(IEEZProxyRegistry(address(l2)), address(0));
    }

    function testFrontendVectorMatchesSafeHashAndContractSignature() public {
        string memory fixture = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/safe-signature.json"));
        address vectorSafe = vm.parseJsonAddress(fixture, ".safe");
        address vectorAdapter = vm.parseJsonAddress(fixture, ".adapter");
        address to = vm.parseJsonAddress(fixture, ".to");
        bytes memory data = vm.parseJsonBytes(fixture, ".data");
        uint256 nonce = vm.parseJsonUint(fixture, ".nonce");
        vm.chainId(vm.parseJsonUint(fixture, ".chainId"));
        // Install the real proxy runtime at the fixture's fixed address; slot zero is
        // SafeProxy's singleton pointer. No treasury deployment uses this test setup.
        vm.etch(vectorSafe, address(safeL2).code);
        vm.store(vectorSafe, bytes32(0), bytes32(uint256(uint160(singleton))));
        vm.etch(vectorAdapter, address(adapter).code);
        l1.getOrCreateCrossChainProxy(vectorAdapter, ROLLUP_ID);
        address[] memory owners = new address[](1);
        owners[0] = vectorAdapter;
        ISafe safe = ISafe(vectorSafe);
        safe.setup(owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)));
        bytes32 hash = safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), nonce);
        assertEq(hash, vm.parseJsonBytes32(fixture, ".hash"));
        bytes memory preimage = safe.encodeTransactionData(to, 0, data, 0, 0, 0, 0, address(0), address(0), nonce);
        safe.checkSignatures(hash, preimage, vm.parseJsonBytes(fixture, ".signatures"));
    }

    function testL1ContractOwnerReceivesFullPreimage() public {
        PreimageCheckingOwner contractOwner = new PreimageCheckingOwner(vm.addr(B));
        _adminL1(abi.encodeCall(ISafe.addOwnerWithThreshold, (address(contractOwner), 2)));
        _adminL1(abi.encodeCall(ISafe.removeOwner, (vm.addr(A), vm.addr(B), 2)));
        bytes memory data = abi.encodeCall(OwnerTestTarget.setValue, (10));
        bytes32 hash = keccak256(_preimage(safeL2, address(target), data, 0));
        bytes memory contractHeader =
            abi.encodePacked(bytes32(uint256(uint160(address(contractOwner)))), uint256(130), uint8(0));
        bytes memory eoa = _sign(A, hash);
        bytes memory heads =
            vm.addr(A) < address(contractOwner) ? bytes.concat(eoa, contractHeader) : bytes.concat(contractHeader, eoa);
        bytes memory inner = bytes.concat(heads, abi.encode(uint256(65)), _sign(B, hash));
        assertTrue(_execute(safeL2, address(target), data, 0, _outer(adapter, inner)));
        assertEq(target.value(), 10);
    }
}
