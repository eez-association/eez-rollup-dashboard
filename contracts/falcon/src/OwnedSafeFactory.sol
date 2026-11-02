// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {SafeProxy} from "../vendor/safe-1.4.1/contracts/proxies/SafeProxy.sol";

interface IOwnedSafe {
    function VERSION() external view returns (string memory);
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

/// @notice One standard Safe per caller. An EEZ L2 caller arrives as its authenticated L1 proxy.
/// @dev Creation and setup are atomic. The factory and gas wallet retain no ownership or module rights.
contract OwnedSafeFactory {
    address public immutable singleton;
    address public immutable fallbackHandler;
    mapping(address owner => address safe) public safes;

    error InvalidConfiguration();
    event SafeCreated(address indexed owner, address indexed safe);

    constructor(address singleton_, address fallbackHandler_) {
        if (singleton_.code.length == 0 || fallbackHandler_.code.length == 0) revert InvalidConfiguration();
        if (keccak256(bytes(IOwnedSafe(singleton_).VERSION())) != keccak256("1.4.1")) revert InvalidConfiguration();
        singleton = singleton_;
        fallbackHandler = fallbackHandler_;
    }

    function createSafe() external returns (address safe) {
        safe = safes[msg.sender];
        if (safe != address(0)) return safe;
        // CREATE2 is scoped to this factory; outsiders cannot predeploy the same proxy through another factory.
        safe = address(new SafeProxy{salt: bytes32(uint256(uint160(msg.sender)))}(singleton));
        address[] memory owners = new address[](1);
        owners[0] = msg.sender;
        IOwnedSafe(safe).setup(owners, 1, address(0), "", fallbackHandler, address(0), 0, payable(address(0)));
        safes[msg.sender] = safe;
        emit SafeCreated(msg.sender, safe);
    }
}
