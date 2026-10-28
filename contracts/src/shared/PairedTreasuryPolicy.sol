// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAllowanceModule} from "../interfaces/IAllowanceModule.sol";
import {IStandardBridge} from "../interfaces/IStandardBridge.sol";
import {IEEZProxyRegistry} from "../interfaces/IEEZProxyRegistry.sol";

/// @notice Unaudited demo: one policy per chain, each spending only its local Safe's allowance.
/// @dev A Safe starts the payment locally. Its policy sends its contribution first,
/// then asks its authenticated peer to send the other contribution. The normal
/// bridges handle crossing chains. L2 counts the total once for both entry points.
contract PairedTreasuryPolicy {
    using SafeERC20 for IERC20;

    uint256 public constant PERIOD = 600;
    uint256 public constant GLOBAL_LIMIT = 150_000_000;
    uint256 public constant PAIR_VERSION = 2;

    address public immutable safe;
    IAllowanceModule public immutable allowanceModule;
    IERC20 public immutable token;
    IStandardBridge public immutable bridge;
    IEEZProxyRegistry public immutable manager;
    uint64 public immutable localRollupId;
    uint64 public immutable l2RollupId;
    address public immutable canonicalToken;
    address public immutable remoteBridge;

    address public peerPolicy; // Original address on the other chain.
    PairedTreasuryPolicy public peer; // Its authenticated proxy on this chain.
    bool public active;
    address public peerSafe;
    address public localAliasOnPeer;
    mapping(uint256 epoch => uint256 amount) private globalSpent; // Written on L2 only.
    bool private entered;

    struct Configuration {
        address safe;
        address canonicalToken;
        address bridge;
        address remoteBridge;
        uint64 localRollupId;
        uint64 l2RollupId;
        address peerPolicy;
        address peerProxy;
    }

    error OnlySafe();
    error OnlyPeer();
    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidRecipient();
    error PaymentExpired();
    error GlobalLimit();
    error Capacity();
    error UnalignedAllowance();
    error ResidualFunds();
    error Reentered();

    event PeerConnected(address indexed policy, address indexed proxy);
    event Activated();
    event Paid(
        address indexed token,
        address indexed recipient,
        bool onL1,
        uint256 amount,
        uint256 fromL1,
        uint256 fromL2,
        uint256 epoch
    );
    event ContributionPaid(address indexed recipient, uint64 indexed destinationRollup, uint256 amount, uint256 epoch);

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    modifier onlyPeer() {
        if (msg.sender != address(peer)) revert OnlyPeer();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentered();
        entered = true;
        _;
        entered = false;
    }

    constructor(address safe_, IAllowanceModule module_, IERC20 token_, IStandardBridge bridge_, uint64 l2RollupId_) {
        if (
            safe_.code.length == 0 || address(module_).code.length == 0 || address(token_).code.length == 0
                || address(bridge_).code.length == 0 || l2RollupId_ == 0
                || IERC20Metadata(address(token_)).decimals() != 6
        ) revert InvalidConfiguration();
        uint64 local = bridge_.rollupId();
        address registry = _bridgeManager(bridge_);
        address remote = _counterpart(bridge_);
        if ((local != 0 && local != l2RollupId_) || registry.code.length == 0) {
            revert InvalidConfiguration();
        }
        // Verify the local EEZ identity, not only the bridge's stored setting.
        // Missing or reverting getters fail closed; a failed L2 read never means L1.
        IEEZProxyRegistry eez = IEEZProxyRegistry(registry);
        if (local == 0) {
            if (eez.MAINNET_ROLLUP_ID() != 0) revert InvalidConfiguration();
        } else if (eez.ROLLUP_ID() != local) {
            revert InvalidConfiguration();
        }
        (address original, uint64 origin) = bridge_.wrappedTokenInfo(address(token_));
        if (local == 0) {
            if (original != address(0)) revert InvalidConfiguration();
            original = address(token_);
        } else if (original == address(0) || origin != 0 || bridge_.getWrappedToken(original, 0) != address(token_)) {
            revert InvalidConfiguration();
        }
        safe = safe_;
        allowanceModule = module_;
        token = token_;
        bridge = bridge_;
        manager = IEEZProxyRegistry(registry);
        localRollupId = local;
        l2RollupId = l2RollupId_;
        canonicalToken = original;
        remoteBridge = remote;
    }

    /// @notice Each Safe connects its policy to the other policy once, before granting its allowance.
    /// @dev Both connections provision the proxies needed by cross-chain view calls.
    function connectPeer(address otherPolicy) external onlySafe {
        if (peerPolicy != address(0) || otherPolicy == address(0)) revert InvalidConfiguration();
        uint64 otherRollup = localRollupId == 0 ? l2RollupId : 0;
        address proxy = manager.getOrCreateCrossChainProxy(otherPolicy, otherRollup);
        (bool registered, address original, uint64 origin) = manager.authorizedProxies(proxy);
        if (!registered || original != otherPolicy || origin != otherRollup || proxy.code.length == 0) {
            revert InvalidConfiguration();
        }
        peerPolicy = otherPolicy;
        peer = PairedTreasuryPolicy(proxy);
        emit PeerConnected(otherPolicy, proxy);
    }

    /// @notice Validate and activate both policies once, after both peers are connected.
    /// @dev Include this call in the final Safe setup batch. Its authenticated peer
    /// activates locally without forwarding again, so no extra Safe approval is needed.
    function activate() external {
        bool startedHere = msg.sender == safe;
        if (!startedHere && msg.sender != address(peer)) revert OnlyPeer();
        if (active || peerPolicy == address(0) || _counterpart(bridge) != remoteBridge) {
            revert InvalidConfiguration();
        }
        if (peer.PAIR_VERSION() != PAIR_VERSION) revert InvalidConfiguration();
        Configuration memory other = peer.configuration();
        if (
            other.peerPolicy != address(this) || other.canonicalToken != canonicalToken || other.bridge != remoteBridge
                || other.remoteBridge != address(bridge) || other.l2RollupId != l2RollupId
                || other.localRollupId != (localRollupId == 0 ? l2RollupId : 0)
        ) revert InvalidConfiguration();
        peerSafe = other.safe;
        localAliasOnPeer = other.peerProxy;
        active = true;
        if (startedHere) peer.activate();
        emit Activated();
    }

    /// @dev Current bridges expose EEZContract; older deployments expose manager.
    /// A valid zero or wrong identity must fail the constructor's binding checks.
    function _bridgeManager(IStandardBridge localBridge) private view returns (address) {
        (bool ok, bytes memory result) = address(localBridge).staticcall(abi.encodeWithSignature("EEZContract()"));
        if (ok && result.length == 32 && abi.decode(result, (uint256)) <= type(uint160).max) {
            return abi.decode(result, (address));
        }
        return localBridge.manager();
    }

    /// @dev Match the normal Bridge: an unset override means the same address on the peer chain.
    /// Only read during construction and activation; payments trust the validated pair.
    function _counterpart(IStandardBridge localBridge) private view returns (address) {
        address remote = localBridge.canonicalBridgeAddress();
        return remote == address(0) ? address(localBridge) : remote;
    }

    /// @notice Owners sign the total, destination, L1 contribution and optional expiry.
    /// @dev deadline == 0 never expires. Spending is charged to execution-time periods.
    function paySplit(
        address recipient,
        uint256 amount,
        bool onL1,
        uint256 deadline,
        uint256 fromL1
    )
        external
        onlySafe
        nonReentrant
    {
        _checkPayment(recipient, amount, deadline, fromL1);
        uint256 epoch = _countOnL2(amount);

        // 1. Transfer our tokens first.
        uint256 ours = localRollupId == 0 ? fromL1 : amount - fromL1;
        _transferTokens(recipient, ours, onL1 ? 0 : l2RollupId, epoch);

        // 2. Ask the other policy to transfer theirs. Always call, even for a
        // zero contribution: an L1-only payment must still be counted on L2.
        uint256 peerEpoch = peer.payFromPeer(recipient, amount, onL1, deadline, fromL1);
        emit Paid(
            canonicalToken, recipient, onL1, amount, fromL1, amount - fromL1, localRollupId == 0 ? peerEpoch : epoch
        );
    }

    /// @notice Finish a payment started by the other policy. Never calls it back to pay again.
    function payFromPeer(
        address recipient,
        uint256 amount,
        bool onL1,
        uint256 deadline,
        uint256 fromL1
    )
        external
        onlyPeer
        nonReentrant
        returns (uint256 epoch)
    {
        _checkPayment(recipient, amount, deadline, fromL1);
        epoch = _countOnL2(amount);
        uint256 ours = localRollupId == 0 ? fromL1 : amount - fromL1;
        _transferTokens(recipient, ours, onL1 ? 0 : l2RollupId, epoch);
    }

    /// @dev Same chain: Safe -> recipient. Other chain: Safe -> policy -> normal bridge.
    function _transferTokens(address recipient, uint256 amount, uint64 destinationRollup, uint256 epoch) internal {
        if (amount == 0) return;
        _checkCapacity(amount, epoch);

        if (destinationRollup == localRollupId) {
            _spendAllowance(recipient, amount);
        } else {
            uint256 beforeBalance = token.balanceOf(address(this));
            _spendAllowance(address(this), amount);
            if (token.balanceOf(address(this)) != beforeBalance + amount) revert ResidualFunds();
            // L1 locks canonical tokens via transferFrom; L2 burns its wrapped tokens.
            if (localRollupId == 0) token.forceApprove(address(bridge), amount);
            bridge.bridgeTokens(address(token), amount, destinationRollup, recipient);
            if (token.balanceOf(address(this)) != beforeBalance || token.allowance(address(this), address(bridge)) != 0)
            {
                revert ResidualFunds();
            }
        }
        emit ContributionPaid(recipient, destinationRollup, amount, epoch);
    }

    function _spendAllowance(address recipient, uint256 amount) private {
        allowanceModule.executeAllowanceTransfer(
            safe, address(token), payable(recipient), uint96(amount), address(0), 0, address(this), ""
        );
    }

    function _checkCapacity(uint256 amount, uint256 epoch) private view {
        uint256[5] memory a = allowanceModule.getTokenAllowance(safe, address(this), address(token));
        if (a[2] != PERIOD / 60 || a[3] != epoch * (PERIOD / 60)) revert UnalignedAllowance();
        uint256 remaining = a[0] > a[1] ? a[0] - a[1] : 0;
        if (amount > remaining || amount > token.balanceOf(safe)) revert Capacity();
    }

    function _checkPayment(address recipient, uint256 amount, uint256 deadline, uint256 fromL1) private view {
        if (amount == 0 || amount > GLOBAL_LIMIT || fromL1 > amount) revert InvalidAmount();
        if (deadline != 0 && block.timestamp > deadline) revert PaymentExpired();
        // Peer and bridge bindings were validated at activation. Payments trust
        // that the normal bridge's administrator keeps that pair unchanged.
        if (!active) revert InvalidConfiguration();
        if (
            recipient == address(0) || recipient == safe || recipient == peerSafe || recipient == address(this)
                || recipient == peerPolicy || recipient == address(peer) || recipient == localAliasOnPeer
                || recipient == address(bridge) || recipient == remoteBridge
        ) revert InvalidRecipient();
    }

    // Exactly one of the two policies is on L2, so every payment counts once.
    // If its budget check fails after an L1 transfer, the failure propagates and
    // the entire EEZ payment must revert, including the earlier contribution.
    function _countOnL2(uint256 amount) private returns (uint256 epoch) {
        epoch = block.timestamp / PERIOD;
        if (localRollupId == 0) return epoch;
        if (globalSpent[epoch] + amount > GLOBAL_LIMIT) revert GlobalLimit();
        globalSpent[epoch] += amount;
    }

    function spent(uint256 epoch) external view returns (uint256) {
        if (localRollupId != 0) return globalSpent[epoch];
        if (!active) revert InvalidConfiguration();
        return peer.spent(epoch);
    }

    function configuration() external view returns (Configuration memory) {
        return Configuration(
            safe, canonicalToken, address(bridge), remoteBridge, localRollupId, l2RollupId, peerPolicy, address(peer)
        );
    }
}
