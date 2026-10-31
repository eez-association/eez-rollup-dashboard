// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply demo ERC20. The deploying wallet receives the entire supply.
contract BridgeTestToken is ERC20 {
    error InvalidToken();

    constructor(string memory name_, string memory symbol_, uint256 initialSupply) ERC20(name_, symbol_) {
        if (
            bytes(name_).length == 0 || bytes(name_).length > 48 || bytes(symbol_).length == 0
                || bytes(symbol_).length > 12 || initialSupply == 0
        ) revert InvalidToken();
        _mint(msg.sender, initialSupply);
    }
}
