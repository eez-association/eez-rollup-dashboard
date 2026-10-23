// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {EEZBase} from "eez-core-protocol/src/base/EEZBase.sol";
import {ProxyInfo} from "eez-core-protocol/src/interfaces/IEEZ.sol";
import {ICrossChainProxy} from "eez-core-protocol/src/interfaces/ICrossChainProxy.sol";
import {L1Owners} from "../../src/l2/L1Owners.sol";
import {IEEZProxyRegistry} from "../../src/interfaces/IEEZProxyRegistry.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";

/// @dev Single-EVM fixture: real EEZ proxies, but direct cross-manager delivery in place
///      of authenticated execution tables. It exercises Safe signatures, not proof validation.
contract ReadThroughManager is EEZBase {
    uint64 public immutable ROLLUP_ID;
    address public constant RECOVERY_ADDRESS = address(0xdead);
    ReadThroughManager public peer;

    constructor(uint64 id) {
        ROLLUP_ID = id;
    }

    function MAINNET_ROLLUP_ID() external view returns (uint64) {
        require(ROLLUP_ID == 0, "only L1");
        return 0;
    }

    function setPeer(ReadThroughManager other) external {
        require(address(peer) == address(0));
        peer = other;
    }

    function _getRollupId() internal view override returns (uint64) {
        return ROLLUP_ID;
    }

    function executeCrossChainCall(address source, bytes calldata data) external payable returns (bytes memory) {
        ProxyInfo memory info = authorizedProxies[msg.sender];
        require(info.isProxy && info.originalRollupId == peer.ROLLUP_ID(), "unregistered proxy");
        return peer.deliver(source, info.originalAddress, data);
    }

    error EEZDestinationForbidden();

    function deliver(address source, address target, bytes calldata data) external returns (bytes memory result) {
        require(msg.sender == address(peer), "only peer");
        if (target == address(this)) revert EEZDestinationForbidden();
        address alias_ = getOrCreateCrossChainProxy(source, peer.ROLLUP_ID());
        bool ok;
        (ok, result) = alias_.call(abi.encodeCall(ICrossChainProxy.executeOnBehalf, (target, 0, data)));
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }

    function staticCrossChainCall(address source, bytes calldata data) external view returns (bytes memory) {
        ProxyInfo memory info = authorizedProxies[msg.sender];
        require(info.isProxy && info.originalRollupId == peer.ROLLUP_ID(), "unregistered proxy");
        return peer.deliverStatic(source, info.originalAddress, data);
    }

    function deliverStatic(
        address source,
        address target,
        bytes calldata data
    )
        external
        view
        returns (bytes memory result)
    {
        require(msg.sender == address(peer), "only peer");
        if (target == address(this)) revert EEZDestinationForbidden();
        address alias_ = computeCrossChainProxyAddress(source, peer.ROLLUP_ID());
        require(alias_.code.length > 0, "missing alias");
        bool ok;
        (ok, result) = alias_.staticcall(abi.encodeCall(ICrossChainProxy.executeOnBehalf, (target, 0, data)));
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }

    function corruptRegistration(address proxy, bool registered, address original, uint64 id) external {
        authorizedProxies[proxy] = ProxyInfo(registered, original, id);
    }
}

contract OwnerTestTarget {
    uint256 public value;

    function setValue(uint256 next) external {
        value = next;
    }

    function fail() external pure {
        revert("required step failed");
    }
}

abstract contract OwnerFixture is Test {
    uint256 internal constant A = 0xa11ce;
    uint256 internal constant B = 0xb0b;
    uint256 internal constant C = 0xc0c;
    uint256 internal constant L2_CHAIN_ID = 6114;
    uint64 internal constant ROLLUP_ID = 42;
    ISafe internal safeL1;
    ISafe internal safeL2;
    address internal singleton;
    ISafeProxyFactory internal factory;
    ReadThroughManager internal l1;
    ReadThroughManager internal l2;
    L1Owners internal adapter;
    OwnerTestTarget internal target;
    uint256 private salt;

    function setUp() public virtual {
        vm.chainId(L2_CHAIN_ID);
        vm.warp(1_800_000_000);
        singleton = _deployLegacy("Safe");
        factory = ISafeProxyFactory(_deployLegacy("SafeProxyFactory"));
        address[] memory owners = new address[](2);
        owners[0] = vm.addr(A);
        owners[1] = vm.addr(B);
        safeL1 = _newL1Safe(owners, 2);
        l1 = new ReadThroughManager(0);
        l2 = new ReadThroughManager(ROLLUP_ID);
        l1.setPeer(l2);
        l2.setPeer(l1);
        l2.getOrCreateCrossChainProxy(address(safeL1), 0);
        adapter = new L1Owners(IEEZProxyRegistry(address(l2)), address(safeL1));
        l1.getOrCreateCrossChainProxy(address(adapter), ROLLUP_ID);
        safeL2 = _safeForAdapter(adapter);
        target = new OwnerTestTarget();
    }

    function _deployLegacy(string memory name) internal returns (address) {
        return deployCode(string.concat(vm.projectRoot(), "/legacy/out/", name, ".sol/", name, ".json"));
    }

    function _newL1Safe(address[] memory owners, uint256 threshold) internal virtual returns (ISafe) {
        return _newSafe(owners, threshold);
    }

    function _newSafe(address[] memory owners, uint256 threshold) internal returns (ISafe) {
        return ISafe(
            factory.createProxyWithNonce(
                singleton,
                abi.encodeCall(
                    ISafe.setup,
                    (owners, threshold, address(0), bytes(""), address(0), address(0), 0, payable(address(0)))
                ),
                ++salt
            )
        );
    }

    function _safeForAdapter(L1Owners owner) internal returns (ISafe) {
        address[] memory owners = new address[](1);
        owners[0] = address(owner);
        return _newSafe(owners, 1);
    }

    function _preimage(
        ISafe safe,
        address to,
        bytes memory data,
        uint256 safeTxGas
    )
        internal
        view
        virtual
        returns (bytes memory)
    {
        return safe.encodeTransactionData(to, 0, data, 0, safeTxGas, 0, 0, address(0), address(0), safe.nonce());
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _signTwo(bytes32 hash, uint256 first, uint256 second) internal pure returns (bytes memory) {
        return vm.addr(first) < vm.addr(second)
            ? bytes.concat(_sign(first, hash), _sign(second, hash))
            : bytes.concat(_sign(second, hash), _sign(first, hash));
    }

    function _outer(L1Owners owner, bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes32(uint256(uint160(address(owner)))), uint256(65), uint8(0), uint256(inner.length), inner
        );
    }

    function _execute(
        ISafe safe,
        address to,
        bytes memory data,
        uint256 safeTxGas,
        bytes memory signatures
    )
        internal
        returns (bool)
    {
        return safe.execTransaction(to, 0, data, 0, safeTxGas, 0, 0, address(0), payable(address(0)), signatures);
    }

    function _adminL1(bytes memory data) internal {
        bytes32 hash = keccak256(_preimage(safeL1, address(safeL1), data, 0));
        assertTrue(_execute(safeL1, address(safeL1), data, 0, _signTwo(hash, A, B)));
    }

    function _callL2(address to, bytes memory data) internal {
        bytes32 hash = keccak256(_preimage(safeL2, to, data, 0));
        assertTrue(_execute(safeL2, to, data, 0, _outer(adapter, _signTwo(hash, A, B))));
    }
}
