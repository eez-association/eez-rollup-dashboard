// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {FalconL1Controller} from "./FalconL1Controller.sol";

/// @notice Permissionless, deterministic discovery of one controller per Falcon key hash.
contract FalconL1ControllerFactory {
    address public immutable verifier;
    address public immutable eezL2;
    uint256 public immutable l1ChainId;
    mapping(bytes32 publicKeyHash => address controller) public controllers;

    event ControllerCreated(bytes32 indexed publicKeyHash, address indexed controller);

    constructor(address verifier_, address eezL2_, uint256 l1ChainId_) {
        if (verifier_.code.length == 0 || eezL2_.code.length == 0 || l1ChainId_ == 0) {
            revert FalconL1Controller.InvalidConfiguration();
        }
        verifier = verifier_;
        eezL2 = eezL2_;
        l1ChainId = l1ChainId_;
    }

    /// @notice Anyone may pay for creation; only the bound Falcon key gains authority.
    function createController(bytes32 publicKeyHash) external returns (address controller) {
        controller = controllers[publicKeyHash];
        if (controller != address(0)) return controller;
        controller = address(new FalconL1Controller{salt: publicKeyHash}(verifier, eezL2, l1ChainId, publicKeyHash));
        controllers[publicKeyHash] = controller;
        emit ControllerCreated(publicKeyHash, controller);
    }
}
