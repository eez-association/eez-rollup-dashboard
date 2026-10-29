// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {L1UniversalV2BridgeHelper} from "../src/L1UniversalV2BridgeHelper.sol";
import {L2UniversalV2Route} from "../src/L2UniversalV2Route.sol";

interface VmSlippage {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
    function parseBytes(string calldata value) external pure returns (bytes memory);
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address sender) external;
    function expectRevert(bytes calldata data) external;
}

interface Settlement {
    struct Trade {
        uint256 sellTokenIndex;
        uint256 buyTokenIndex;
        address receiver;
        uint256 sellAmount;
        uint256 buyAmount;
        uint32 validTo;
        bytes32 appData;
        uint256 feeAmount;
        uint256 flags;
        uint256 executedAmount;
        bytes signature;
    }

    struct Interaction {
        address target;
        uint256 value;
        bytes callData;
    }
    function settle(address[] calldata, uint256[] calldata, Trade[] calldata, Interaction[][3] calldata) external;
    function vaultRelayer() external view returns (address);
    function domainSeparator() external view returns (bytes32);
    function filledAmount(bytes calldata uid) external view returns (uint256);
}

interface V2Factory {
    function createPair(address tokenA, address tokenB) external returns (address);
}

interface V2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function sync() external;
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @dev Minimal standard ERC20; explicit error identifies the failing payout.
contract SlippageToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    error InsufficientBalance(address account, uint256 balance, uint256 required);

    function mint(address account, uint256 value) external {
        balanceOf[account] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(allowance[from][msg.sender] >= value, "test: allowance");
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance(from, balance, value);
        balanceOf[from] = balance - value;
        balanceOf[to] += value;
    }
}

/// @dev Test boundary only: synchronous forwarding stands in for both bridge
/// legs, and uses the same ERC20 on L1/L2. No Composer/finality claim is made.
contract LocalBridge {
    function bridgeTokens(address token, uint256 amount, uint64, address destination) external {
        require(SlippageToken(token).transferFrom(msg.sender, destination, amount));
    }
}

contract SettlementSlippageTest {
    VmSlippage private constant vm = VmSlippage(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant SELL = 100;
    uint256 private constant MINIMUM = 97;
    bytes32 private constant ORDER_TYPE = keccak256(
        "Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)"
    );

    // Static ABI fields encode exactly as GPv2's EIP-712 Order struct.
    struct Order {
        address sellToken;
        address buyToken;
        address receiver;
        uint256 sellAmount;
        uint256 buyAmount;
        uint32 validTo;
        bytes32 appData;
        uint256 feeAmount;
        bytes32 kind;
        bool partiallyFillable;
        bytes32 sellTokenBalance;
        bytes32 buyTokenBalance;
    }

    SlippageToken private weth;
    SlippageToken private buy;
    Settlement private settlement;
    V2Pair private pair;
    L2UniversalV2Route private route;
    L1UniversalV2BridgeHelper private helper;
    address private owner;
    bytes private orderUid;
    bytes private signature;
    uint32 private validTo;

    // Real GPv2 calls this test authenticator. Only the test solver is allowed.
    function isSolver(address solver) external view returns (bool) {
        return solver == address(this);
    }

    function setUp() public {
        weth = new SlippageToken();
        buy = new SlippageToken();
        settlement = Settlement(
            _deploy(
                "node_modules/@cowprotocol/contracts/lib/contracts/GPv2Settlement.json",
                abi.encode(address(this), address(0))
            )
        );
        V2Factory factory =
            V2Factory(_deploy("node_modules/@uniswap/v2-core/build/UniswapV2Factory.json", abi.encode(address(this))));
        pair = V2Pair(factory.createPair(address(weth), address(buy)));
        weth.mint(address(pair), 99_700);
        buy.mint(address(pair), 101_000);
        pair.sync();

        LocalBridge bridge = new LocalBridge();
        route = new L2UniversalV2Route(address(bridge), address(weth), address(settlement));
        helper = new L1UniversalV2BridgeHelper(address(bridge), address(weth), address(settlement), 1, address(route));
        route.configure(address(helper), address(helper));

        owner = vm.addr(OWNER_KEY);
        weth.mint(owner, SELL);
        address relayer = settlement.vaultRelayer();
        vm.prank(owner);
        weth.approve(relayer, SELL);
        validTo = uint32(block.timestamp + 1 days);
        Order memory order = Order(
            address(weth),
            address(buy),
            owner,
            SELL,
            MINIMUM,
            validTo,
            bytes32(0),
            0,
            keccak256("sell"),
            false,
            keccak256("erc20"),
            keccak256("erc20")
        );
        bytes32 digest = keccak256(
            abi.encodePacked(hex"1901", settlement.domainSeparator(), keccak256(abi.encode(ORDER_TYPE, order)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        signature = abi.encodePacked(r, s, v);
        orderUid = abi.encodePacked(digest, owner, validTo);
        require(_quote(SELL) == 100, "initial solver quote must be 100");
        require(buy.balanceOf(address(settlement)) == 0, "no inventory subsidy");
    }

    function testUnchangedQuoteSettlesAt100() public {
        _settle(_quote(SELL));
        require(buy.balanceOf(owner) == 100, "full quoted output paid");
        require(weth.balanceOf(owner) == 0, "sell amount consumed");
        require(settlement.filledAmount(orderUid) == SELL, "order filled");
    }

    function test97Minimum100Quote99OutputRevertsAtGPv2Payout() public {
        uint256 solverQuote = _quote(SELL);
        _otherTraderSells(500); // Real V2 swap after the solver's quote.
        require(_quote(SELL) == 99 && _quote(SELL) > MINIMUM, "within signed slippage");
        (uint112 before0, uint112 before1,) = pair.getReserves();
        // The route delivers 99; GPv2 then tries to transfer 100 to the user.
        vm.expectRevert(
            abi.encodeWithSelector(SlippageToken.InsufficientBalance.selector, address(settlement), 99, 100)
        );
        this.settleWithQuote(solverQuote);
        require(weth.balanceOf(owner) == SELL && buy.balanceOf(owner) == 0, "user funds roll back");
        require(settlement.filledAmount(orderUid) == 0, "failed fill rolls back");
        require(
            buy.balanceOf(address(settlement)) == 0 && weth.balanceOf(address(route)) == 0,
            "no stranded route or settlement funds"
        );
        (uint112 after0, uint112 after1,) = pair.getReserves();
        require(before0 == after0 && before1 == after1, "AMM swap rolls back");
    }

    function testRouteAloneAccepts99With97Minimum() public {
        _otherTraderSells(500);
        require(_quote(SELL) == 99);
        weth.mint(address(route), SELL);
        vm.prank(address(settlement));
        route.startHeld(SELL, address(buy), address(pair), MINIMUM);
        require(buy.balanceOf(address(settlement)) == 99, "route minimum allows 99");
    }

    function testRequoteAfterPriceMovementSettlesAt99() public {
        _otherTraderSells(500);
        require(_quote(SELL) == 99);
        _settle(_quote(SELL)); // Existing pricing policy, using a fresh quote.
        require(buy.balanceOf(owner) == 99, "fresh quote fills above minimum");
        require(settlement.filledAmount(orderUid) == SELL);
    }

    function testBelow97MinimumRevertsInRoute() public {
        uint256 solverQuote = _quote(SELL);
        _otherTraderSells(2500);
        require(_quote(SELL) < MINIMUM);
        vm.expectRevert(abi.encodeWithSelector(L1UniversalV2BridgeHelper.Slippage.selector));
        this.settleWithQuote(solverQuote);
        require(weth.balanceOf(owner) == SELL && settlement.filledAmount(orderUid) == 0);
    }

    // External boundary lets expectRevert cover the complete settlement call.
    function settleWithQuote(uint256 quote) external {
        require(msg.sender == address(this));
        _settle(quote);
    }

    function _settle(uint256 solverQuote) private {
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(buy);
        uint256[] memory prices = new uint256[](2);
        // Deliberately reproduce settle_order.py's current pricing unchanged.
        prices[0] = (solverQuote > MINIMUM ? solverQuote : MINIMUM) * 1e18;
        prices[1] = SELL * 1e18;
        Settlement.Trade[] memory trades = new Settlement.Trade[](1);
        trades[0] = Settlement.Trade(0, 1, owner, SELL, MINIMUM, validTo, bytes32(0), 0, 0, SELL, signature);
        Settlement.Interaction[][3] memory interactions;
        interactions[0] = new Settlement.Interaction[](0);
        interactions[1] = new Settlement.Interaction[](2);
        interactions[2] = new Settlement.Interaction[](0);
        interactions[1][0] =
            Settlement.Interaction(address(weth), 0, abi.encodeCall(weth.transfer, (address(route), SELL)));
        interactions[1][1] = Settlement.Interaction(
            address(route), 0, abi.encodeCall(route.startHeld, (SELL, address(buy), address(pair), MINIMUM))
        );
        settlement.settle(tokens, prices, trades, interactions);
    }

    function _quote(uint256 amount) private view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rin, uint256 rout) = pair.token0() == address(weth) ? (r0, r1) : (r1, r0);
        return amount * 997 * rout / (rin * 1000 + amount * 997);
    }

    function _otherTraderSells(uint256 amount) private {
        uint256 out = _quote(amount);
        weth.mint(address(this), amount);
        weth.transfer(address(pair), amount);
        if (pair.token0() == address(weth)) pair.swap(0, out, address(this), "");
        else pair.swap(out, 0, address(this), "");
    }

    function _deploy(string memory artifact, bytes memory args) private returns (address deployed) {
        string memory hexCode = vm.parseJsonString(vm.readFile(artifact), ".bytecode");
        if (bytes(hexCode)[1] != bytes1("x")) hexCode = string.concat("0x", hexCode);
        bytes memory code = abi.encodePacked(vm.parseBytes(hexCode), args);
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "artifact deployment failed");
    }
}
