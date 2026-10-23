// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IEEZProxyRegistry} from "../interfaces/IEEZProxyRegistry.sol";
import {IAllowanceModule} from "../interfaces/IAllowanceModule.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStandardBridge} from "../interfaces/IStandardBridge.sol";
import {ISafe} from "../interfaces/ISafe.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Shared authorization, accounting and payments for the two treasury bridge paths.
/// @dev Bridge adapters authenticate their remote spending delegate and execute
///      the L1 contribution. They inherit this code without another deployment.
///      Only official allowance modules have Safe module power. Remote view calls
///      require EEZ execution tables; owner administration remains unrestricted.
abstract contract TreasuryPolicyBase {
    address public immutable safeL1Proxy;
    event L1PaymentAuthorized(uint256 indexed safeNonce, bytes32 indexed callHash);
    uint256 public constant SPLIT_VERSION = 2;
    uint256 public constant PERIOD = 600;
    uint256 public constant GLOBAL_LIMIT = 150_000_000;
    address public immutable safeL1;
    address public immutable safeL2;
    address public immutable canonicalToken;
    address public immutable wrappedToken;
    IAllowanceModule public immutable allowanceL2;
    IAllowanceModule public immutable allowanceL1Proxy;
    IERC20 public immutable tokenL1Proxy;
    uint64 public immutable rollupId;
    IStandardBridge public immutable bridge;
    address public immutable bridgeL1;
    mapping(uint256 epoch => uint256 amount) public spent;
    bool private entered;

    error OnlySafe();
    error InvalidConfiguration();
    error InvalidRecipient();
    error InvalidAmount();
    error StaleEpoch();
    error GlobalLimit();
    error Capacity();
    error UnalignedAllowance();
    error ApprovalFailed();
    error Reentered();
    error ResidualBalance();
    event Paid(
        address indexed token,
        address indexed recipient,
        bool onL1,
        uint256 amount,
        uint256 fromL1,
        uint256 fromL2,
        uint256 epoch
    );

    modifier paymentExecution() {
        _authorizePayment();
        if (entered) revert Reentered();
        entered = true;
        _;
        entered = false;
    }

    function _authorizePayment() private {
        if (msg.sender == safeL2) return;
        if (msg.sender != safeL1Proxy) revert OnlySafe();
        emit L1PaymentAuthorized(ISafe(safeL1Proxy).nonce(), keccak256(msg.data));
    }

    constructor(
        address safeL1_,
        address safeL2_,
        IEEZProxyRegistry manager,
        address moduleL1,
        IAllowanceModule moduleL2,
        address token,
        IStandardBridge bridge_
    ) {
        if (
            safeL1_ == address(0) || safeL2_.code.length == 0 || address(moduleL2).code.length == 0
                || moduleL1 == address(0) || token == address(0) || manager.ROLLUP_ID() == 0
                || address(bridge_.manager()) != address(manager) || bridge_.rollupId() != manager.ROLLUP_ID()
                || bridge_.canonicalBridgeAddress() == address(0)
        ) revert InvalidConfiguration();
        address wrapped = bridge_.getWrappedToken(token, 0);
        (address original, uint64 origin) = bridge_.wrappedTokenInfo(wrapped);
        if (wrapped.code.length == 0 || original != token || origin != 0) revert InvalidConfiguration();
        address proxy = manager.getOrCreateCrossChainProxy(safeL1_, 0);
        (bool registered, address owner, uint64 chain) = manager.authorizedProxies(proxy);
        if (!registered || owner != safeL1_ || chain != 0 || proxy.code.length == 0) revert InvalidConfiguration();
        safeL1Proxy = proxy;
        safeL1 = safeL1_;
        safeL2 = safeL2_;
        canonicalToken = token;
        wrappedToken = wrapped;
        allowanceL2 = moduleL2;
        bridge = bridge_;
        bridgeL1 = bridge_.canonicalBridgeAddress();
        rollupId = manager.ROLLUP_ID();
        // Provision local proxies outside STATICCALL. The deployment must also
        // provision this policy's L1 alias before its first remote read.
        allowanceL1Proxy = IAllowanceModule(manager.getOrCreateCrossChainProxy(moduleL1, 0));
        tokenL1Proxy = IERC20(manager.getOrCreateCrossChainProxy(token, 0));
    }

    /// @notice Pay the configured asset with the exact contributions approved by the owners.
    /// @dev The remainder comes from SafeL2. Never rebalance a signed allocation
    ///      when capacity changes; fail before either transfer instead.
    function paySplit(
        address recipient,
        uint256 amount,
        bool onL1,
        uint256 expectedEpoch,
        uint256 fromL1
    )
        external
        paymentExecution
    {
        _pay(recipient, amount, onL1, expectedEpoch, fromL1);
    }

    function _pay(address recipient, uint256 amount, bool onL1, uint256 expectedEpoch, uint256 fromL1) internal {
        if (amount == 0 || amount > GLOBAL_LIMIT || amount > type(uint96).max || fromL1 > amount) {
            revert InvalidAmount();
        }
        uint256 epoch = block.timestamp / PERIOD;
        if (expectedEpoch != epoch) revert StaleEpoch();
        if (spent[epoch] + amount > GLOBAL_LIMIT) revert GlobalLimit();
        if (bridge.canonicalBridgeAddress() != bridgeL1) revert InvalidConfiguration();
        (address alias_, address delegate) = _paymentContext();
        if (
            recipient == address(0) || recipient == address(this) || recipient == alias_ || recipient == safeL1
                || recipient == safeL2 || recipient == address(bridge) || recipient == bridgeL1 || recipient == delegate
        ) revert InvalidRecipient();
        uint256 fromL2 = amount - fromL1;
        if (fromL1 > _capacity(true, delegate, epoch) || fromL2 > _capacity(false, delegate, epoch)) {
            revert Capacity();
        }
        spent[epoch] += amount;
        // Execute the L2 contribution first. Required failures propagate through
        // the Safe's zero-refund execution, including a later L1 lock failure.
        if (fromL2 > 0) {
            uint256 beforeBalance = IERC20(wrappedToken).balanceOf(address(this));
            allowanceL2.executeAllowanceTransfer(
                safeL2,
                wrappedToken,
                payable(onL1 ? address(this) : recipient),
                uint96(fromL2),
                address(0),
                0,
                address(this),
                ""
            );
            if (onL1) bridge.bridgeTokens(wrappedToken, fromL2, 0, recipient);
            if (IERC20(wrappedToken).balanceOf(address(this)) != beforeBalance) revert ResidualBalance();
        }
        if (fromL1 > 0) _payL1(alias_, recipient, fromL1, onL1);
        emit Paid(canonicalToken, recipient, onL1, amount, fromL1, fromL2, epoch);
    }

    function _capacity(bool onL1, address delegate, uint256 epoch) internal view returns (uint256) {
        uint256 remaining = _remaining(
            onL1 ? allowanceL1Proxy : allowanceL2,
            onL1 ? safeL1 : safeL2,
            onL1 ? delegate : address(this),
            onL1 ? canonicalToken : wrappedToken,
            epoch
        );
        uint256 balance = onL1 ? tokenL1Proxy.balanceOf(safeL1) : IERC20(wrappedToken).balanceOf(safeL2);
        return balance < remaining ? balance : remaining;
    }

    function _remaining(
        IAllowanceModule module,
        address safe,
        address delegate,
        address token,
        uint256 epoch
    )
        internal
        view
        returns (uint256)
    {
        uint256[5] memory a = module.getTokenAllowance(safe, delegate, token);
        // Refuse mismatched periods or L1/L2 timestamp epochs instead of combining
        // different windows. The owners sign expectedEpoch, so delayed approval
        // cannot silently spend against a later period's budget.
        if (a[2] != PERIOD / 60 || a[3] != epoch * (PERIOD / 60)) revert UnalignedAllowance();
        return a[1] < a[0] ? a[0] - a[1] : 0;
    }
    /// @dev Return this policy's authenticated alias and L1 allowance beneficiary.
    ///      Adapters must reject unbound delegates or a changed bridge peer.
    function _paymentContext() internal view virtual returns (address alias_, address delegate);

    /// @dev Execute the complete L1 contribution, including bridging when needed.
    ///      Any failed transfer, residual custody or approval must revert.
    function _payL1(address alias_, address recipient, uint256 amount, bool onL1) internal virtual;
}
