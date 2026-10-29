// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ITestV2Factory {
    function createPair(address, address) external returns (address);
}

interface ITestV2Pair {
    function mint(address) external returns (uint256);
}

interface ITestBridge {
    function bridgeTokens(address, uint256, uint64, address) external;
}

/// @notice Fixed-supply, valueless test asset. Not a native-currency wrapper.
contract ChiadoTestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint256 supply) {
        require(block.chainid == 10200, "Chiado only");
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(to != address(0), "zero recipient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Atomic test asset/pool setup. Liquidity is seeded once, in creation.
contract ChiadoLiquidity {
    address public immutable owner;
    address public immutable bridge;
    uint64 public immutable rollupId;
    ChiadoTestToken public immutable weth;
    ChiadoTestToken public immutable token;
    address public immutable pair;
    mapping(address => bool) public initialized;

    constructor(address factory, address bridge_, uint64 rollup, address recipient) {
        require(block.chainid == 10200, "Chiado only");
        require(
            factory.code.length > 0 && bridge_.code.length > 0 && rollup > 0 && recipient != address(0), "configuration"
        );
        owner = recipient;
        bridge = bridge_;
        rollupId = rollup;
        weth = new ChiadoTestToken("CoW Test WETH", "ctWETH", 2001 ether);
        token = new ChiadoTestToken("CoW Test USD", "ctUSD", 200001 ether);
        pair = ITestV2Factory(factory).createPair(address(weth), address(token));
        weth.transfer(pair, 1000 ether);
        token.transfer(pair, 100000 ether);
        ITestV2Pair(pair).mint(recipient);
        weth.transfer(recipient, 1000 ether);
        token.transfer(recipient, 100000 ether);
        // Retain one token of each asset to initialize its canonical wrapper.
    }

    function initializeWrapper(address asset) external {
        require(msg.sender == owner, "owner");
        require(asset == address(weth) || asset == address(token), "asset");
        require(!initialized[asset], "initialized");
        initialized[asset] = true;
        ChiadoTestToken(asset).approve(bridge, 1 ether);
        ITestBridge(bridge).bridgeTokens(asset, 1 ether, rollupId, owner);
    }
}
