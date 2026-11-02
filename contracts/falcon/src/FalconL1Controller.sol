// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IFalconVerifier} from "./IFalconVerifier.sol";

interface IEEZProxyManager {
    function getOrCreateCrossChainProxy(address originalAddress, uint64 originalRollupId) external returns (address);
}

/// @notice A Falcon key authorizes zero-value calls to arbitrary L1 contracts through EEZ.
/// @dev Destination selection is signed. There is no gas-wallet owner, admin or key replacement path.
contract FalconL1Controller {
    bytes32 public constant ACTION_TYPEHASH = keccak256(
        "FalconL1Call(uint256 sourceChainId,uint256 destinationChainId,address controller,address eezL2,address target,bytes32 dataHash,uint256 nonce,uint256 deadline)"
    );
    IFalconVerifier public immutable verifier;
    IEEZProxyManager public immutable eezL2;
    uint256 public immutable l1ChainId;
    bytes32 public immutable publicKeyHash;
    uint256 public nonce;
    bool private executing;

    error InvalidConfiguration();
    error InvalidTarget();
    error WrongPublicKey();
    error InvalidNonce(uint256 expected, uint256 supplied);
    error AuthorizationExpired();
    error InvalidSignature();
    error ReentrantExecution();

    event CallExecuted(
        bytes32 indexed digest,
        uint256 indexed nonce,
        address indexed target,
        address relayer,
        bytes32 signatureHash,
        bytes result
    );

    constructor(address verifier_, address eezL2_, uint256 l1ChainId_, bytes32 publicKeyHash_) {
        if (verifier_.code.length == 0 || eezL2_.code.length == 0 || l1ChainId_ == 0 || publicKeyHash_ == bytes32(0)) {
            revert InvalidConfiguration();
        }
        verifier = IFalconVerifier(verifier_);
        eezL2 = IEEZProxyManager(eezL2_);
        l1ChainId = l1ChainId_;
        publicKeyHash = publicKeyHash_;
    }

    /// @notice The raw 32-byte Falcon message. No personal_sign prefix or ECDSA framing.
    function actionDigest(address target, bytes calldata data, uint256 authorizationNonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                ACTION_TYPEHASH,
                block.chainid,
                l1ChainId,
                address(this),
                address(eezL2),
                target,
                keccak256(data),
                authorizationNonce,
                deadline
            )
        );
    }

    /// @notice Validate authorization without needing a cross-chain execution table.
    /// @dev This checks the signature, domain, nonce and deadline, not remote execution or settlement.
    function checkAuthorization(
        address target,
        bytes calldata data,
        uint256 authorizationNonce,
        uint256 deadline,
        bytes calldata signature,
        bytes calldata publicKey
    ) public view returns (bytes32 digest) {
        if (target == address(0)) revert InvalidTarget();
        if (keccak256(publicKey) != publicKeyHash) revert WrongPublicKey();
        if (authorizationNonce != nonce) revert InvalidNonce(nonce, authorizationNonce);
        if (block.timestamp > deadline) revert AuthorizationExpired();
        digest = actionDigest(target, data, authorizationNonce, deadline);
        if (!verifier.verify(abi.encodePacked(digest), signature, publicKey)) revert InvalidSignature();
    }

    /// @notice Execute one signed, zero-value L1 call and return its raw result.
    /// @dev Rollup routing ID 0 means L1; it is unrelated to its EVM chain ID. Bubble remote reverts
    /// so source execution also rolls back the nonce. L2 inclusion alone does not establish settlement.
    function execute(
        address target,
        bytes calldata data,
        uint256 authorizationNonce,
        uint256 deadline,
        bytes calldata signature,
        bytes calldata publicKey
    ) external returns (bytes memory result) {
        if (executing) revert ReentrantExecution();
        bytes32 digest = checkAuthorization(target, data, authorizationNonce, deadline, signature, publicKey);
        executing = true;
        nonce = authorizationNonce + 1;
        address proxy = eezL2.getOrCreateCrossChainProxy(target, 0);
        bool success;
        (success, result) = proxy.call(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        executing = false;
        emit CallExecuted(digest, authorizationNonce, target, msg.sender, keccak256(signature), result);
    }
}
