// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Bridge} from "eez-core-protocol/src/periphery/Bridge.sol";
import {WrappedToken} from "eez-core-protocol/src/periphery/WrappedToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Devnet bridge extension for L2-origin lock-then-mint deposits.
/// @dev Inherits the pinned TEST-ONLY bridge and its deployment/admin assumptions.
///      Use a fresh, configured pair and its own wrapped asset. Not a production bridge.
contract TreasuryBridge is Bridge {
    using SafeERC20 for IERC20;

    address public immutable canonicalToken;
    uint64 public immutable treasuryRollupId;
    uint256 public nextDepositNonce;
    mapping(uint256 nonce => bool consumed) public lockedDeposits;
    bool private depositing;

    error InvalidRoute();
    error DepositAlreadyLocked();
    error InvalidLockReceipt();
    error InexactLock();
    error Reentered();
    event DepositLocked(uint256 indexed nonce, address indexed payerAlias, address indexed recipient, uint256 amount);
    event DepositMinted(uint256 indexed nonce, address indexed payer, address indexed recipient, uint256 amount);

    constructor(address token, uint64 destinationRollup) {
        if (token == address(0) || destinationRollup == 0) revert InvalidRoute();
        canonicalToken = token;
        treasuryRollupId = destinationRollup;
    }

    /// @notice Lock tokens from the caller's L1 alias and mint to an L2 recipient.
    /// @dev The caller must first fund its alias and approve this pair's L1 bridge.
    ///      Minting is only reachable after the authenticated lock returns inside
    ///      this EEZ entry; there is no separately redeemable mint receipt.
    function bridgeFromL1(uint256 amount, address recipient) external {
        if (rollupId != treasuryRollupId || canonicalBridgeAddress == address(0)) revert InvalidRoute();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (depositing) revert Reentered();
        depositing = true;
        address wrapped = wrappedTokens[_wrappedSalt(canonicalToken, 0)];
        if (wrapped == address(0)) revert InvalidRoute();
        uint256 nonce = nextDepositNonce++;
        address proxy = _getOrDeployProxy(canonicalBridgeAddress, 0);
        bytes32 receipt = TreasuryBridge(proxy).lockForL2(msg.sender, amount, recipient, nonce);
        if (receipt != _receipt(canonicalBridgeAddress, address(this), msg.sender, amount, recipient, nonce)) {
            revert InvalidLockReceipt();
        }
        WrappedToken(wrapped).mint(recipient, amount);
        emit DepositMinted(nonce, msg.sender, recipient, amount);
        depositing = false;
    }

    /// @notice Terminal L1 operation: lock an exact amount without an L2 callback.
    /// @dev Only this pair's L2 bridge alias can choose the payer. That bridge binds
    ///      payer to its actual local caller; callers cannot spend another alias's
    ///      approval. Nonces belong to the configured bridge pair, not the payer.
    function lockForL2(
        address payer,
        uint256 amount,
        address recipient,
        uint256 nonce
    )
        external
        onlyBridgeProxy(treasuryRollupId)
        returns (bytes32)
    {
        if (rollupId != 0 || canonicalBridgeAddress == address(0)) revert InvalidRoute();
        if (payer == address(0) || recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (lockedDeposits[nonce]) revert DepositAlreadyLocked();
        lockedDeposits[nonce] = true;
        address payerAlias = manager.computeCrossChainProxyAddress(payer, treasuryRollupId);
        IERC20 token = IERC20(canonicalToken);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(payerAlias, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert InexactLock();
        emit DepositLocked(nonce, payerAlias, recipient, amount);
        return _receipt(address(this), canonicalBridgeAddress, payer, amount, recipient, nonce);
    }

    function _receipt(
        address l1Bridge,
        address l2Bridge,
        address payer,
        uint256 amount,
        address recipient,
        uint256 nonce
    )
        private
        view
        returns (bytes32)
    {
        return
            keccak256(abi.encode(l1Bridge, l2Bridge, treasuryRollupId, canonicalToken, payer, recipient, amount, nonce));
    }
}
