// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IFalconVerifier {
    function verify(bytes calldata message, bytes calldata signature, bytes calldata publicKey)
        external
        view
        returns (bool);
}
