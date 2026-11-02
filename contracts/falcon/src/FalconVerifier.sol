// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {falcon_core} from "../vendor/ethfalcon/src/ZKNOX_falcon_core.sol";
import {hashToPointNIST} from "../vendor/ethfalcon/src/ZKNOX_HashToPoint.sol";
import {_ZKNOX_NTTFW_vectorized} from "../vendor/ethfalcon/src/ZKNOX_NTT_falcon.sol";
import {_ZKNOX_NTT_Compact, _ZKNOX_NTT_Decompress} from "../vendor/ethfalcon/src/ZKNOX_falcon_utils.sol";

/// @notice Verifies raw messages against Falcon-512 Round 3 SHAKE256 padded signatures.
/// @dev Stateless cryptographic verification only; a supplied key grants no authority.
contract FalconVerifier {
    error MessageTooLong();
    error InvalidPublicKey();
    error InvalidSignature();

    event SignatureVerified(
        address indexed submitter, bytes32 indexed publicKeyHash, bytes32 indexed messageHash, bytes32 signatureHash
    );

    /// @notice Transaction entry point: reverts unless verification passes, then records public-input hashes.
    /// @dev Anyone may submit or repeat a valid sample. This is not action authorization or replay protection.
    function verifyAndRecord(bytes calldata message, bytes calldata signature, bytes calldata publicKey) external {
        if (!verify(message, signature, publicKey)) revert InvalidSignature();
        emit SignatureVerified(msg.sender, keccak256(publicKey), keccak256(message), keccak256(signature));
    }

    /// @param message Exact signed bytes, up to 4096 bytes; no Ethereum prefix or extra hash.
    /// @param signature 666 bytes: 0x39, 40-byte salt, canonical compressed s2 and zero padding.
    /// @param publicKey 897 bytes: 0x09 followed by 512 big-endian 14-bit coefficients, each < 12289.
    /// @return True only if the pinned SHAKE256 hash-to-point and Falcon norm check accept.
    /// @dev Malformed encodings revert; well-formed signatures with an invalid relation return false.
    function verify(bytes calldata message, bytes calldata signature, bytes calldata publicKey)
        public
        pure
        returns (bool)
    {
        if (message.length > 4096) revert MessageTooLong();
        if (publicKey.length != 897 || publicKey[0] != 0x09) revert InvalidPublicKey();
        if (signature.length != 666 || signature[0] != 0x39) revert InvalidSignature();

        uint256[] memory s2 = _decodeSignature(signature);
        // Compute the transformed key here, so a caller cannot substitute an unbound NTT key.
        // The upstream decoder checks every coefficient against q after the exact length check above.
        uint256[] memory ntth = _ZKNOX_NTT_Compact(_ZKNOX_NTTFW_vectorized(_ZKNOX_NTT_Decompress(publicKey, 1)));
        return falcon_core(s2, ntth, hashToPointNIST(signature[1:41], message));
    }

    /// @dev Falcon specification §3.11.2. Bound all reads and unary runs before calling the core.
    /// Unlike the upstream KAT decoder, reject negative zero and all nonzero padding bits/bytes.
    function _decodeSignature(bytes calldata signature) private pure returns (uint256[] memory packed) {
        packed = new uint256[](32);
        uint256 cursor = 41;
        uint256 accumulator;
        uint256 remaining;
        for (uint256 i; i < 512; ++i) {
            if (cursor >= 666) revert InvalidSignature();
            accumulator = (accumulator << 8) | uint8(signature[cursor++]);
            uint256 first = (accumulator >> remaining) & 255;
            uint256 magnitude = first & 127;
            bool negative = (first & 128) != 0;
            while (true) {
                if (remaining == 0) {
                    if (cursor >= 666) revert InvalidSignature();
                    accumulator = (accumulator << 8) | uint8(signature[cursor++]);
                    remaining = 8;
                }
                --remaining;
                if (((accumulator >> remaining) & 1) != 0) break;
                magnitude += 128;
                if (magnitude > 2047) revert InvalidSignature();
            }
            if (negative && magnitude == 0) revert InvalidSignature();
            uint256 coefficient = negative ? 12289 - magnitude : magnitude;
            packed[i >> 4] |= coefficient << ((i & 15) * 16);
            accumulator &= (uint256(1) << remaining) - 1;
        }
        if (accumulator != 0) revert InvalidSignature();
        for (; cursor < 666; ++cursor) {
            if (signature[cursor] != 0) revert InvalidSignature();
        }
    }
}
