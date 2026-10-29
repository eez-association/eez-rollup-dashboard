// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IFaucetToken {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}
interface IFaucetBridge {
    function rollupId() external view returns (uint64);
    function bridgeTokens(address, uint256, uint64, address) external;
    function bridgeEther(uint64, address) external payable;
}

/// @notice Finite test-token inventory; never mints or uses a server signing key.
contract ChiadoCowFaucet {
    address public immutable token;
    address public immutable bridge;
    uint64 public immutable rollupId;
    uint256 public constant tokenAmount = 0.01 ether;
    uint256 public constant gasAmount = 0.0002 ether;
    uint256 public constant cooldown = 1 days;
    mapping(address => uint256) public nextClaimAt;
    bool private entered;
    event Claimed(address indexed recipient, uint256 tokenAmount, uint256 gasAmount);

    constructor(address token_, address bridge_, uint64 rollupId_) {
        require(block.chainid == 10200, "Chiado only");
        require(token_.code.length > 0 && bridge_.code.length > 0 && rollupId_ > 0, "invalid configuration");
        require(IFaucetBridge(bridge_).rollupId() == 0, "L1 bridge required");
        token = token_; bridge = bridge_; rollupId = rollupId_;
    }
    receive() external payable {}

    function claim() external {
        require(!entered, "reentrant claim");
        require(block.timestamp >= nextClaimAt[msg.sender], "claim cooldown");
        require(address(this).balance >= gasAmount && IFaucetToken(token).balanceOf(address(this)) >= tokenAmount, "faucet empty");
        entered = true;
        nextClaimAt[msg.sender] = block.timestamp + cooldown;
        require(IFaucetToken(token).approve(bridge, tokenAmount), "approval failed");
        IFaucetBridge(bridge).bridgeEther{value: gasAmount}(rollupId, msg.sender);
        IFaucetBridge(bridge).bridgeTokens(token, tokenAmount, rollupId, msg.sender);
        emit Claimed(msg.sender, tokenAmount, gasAmount);
        entered = false;
    }
}
