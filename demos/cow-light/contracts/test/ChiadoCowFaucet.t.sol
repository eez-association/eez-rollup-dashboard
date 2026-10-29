// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ChiadoCowFaucet} from "../src/ChiadoCowFaucet.sol";
import {ChiadoTestToken} from "../src/ChiadoLiquidity.sol";
interface VmFaucet {
    function chainId(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
}
contract FaucetBridge {
    uint64 public rollupId = 0;
    address public recipient;
    uint64 public destination;
    uint256 public gasSent;
    bool public fail;
    function setFail() external { fail = true; }
    function bridgeEther(uint64 id, address to) external payable { destination = id; recipient = to; gasSent += msg.value; }
    function bridgeTokens(address token, uint256 amount, uint64 id, address to) external {
        require(!fail, "bridge failed");
        require(id == destination && to == recipient, "recipient mismatch");
        ChiadoTestToken(token).transferFrom(msg.sender, to, amount);
    }
}
contract ChiadoCowFaucetTest {
    VmFaucet constant vm = VmFaucet(address(uint160(uint256(keccak256("hevm cheat code")))));
    ChiadoTestToken token;
    FaucetBridge bridge;
    ChiadoCowFaucet faucet;
    address user = address(0x1234);
    function setUp() public {
        vm.chainId(10200);
        token = new ChiadoTestToken("CoW Test WETH", "ctWETH", 1 ether);
        bridge = new FaucetBridge();
        faucet = new ChiadoCowFaucet(address(token), address(bridge), 4);
        token.transfer(address(faucet), 1 ether);
        vm.deal(address(faucet), 0.01 ether);
    }
    function testClaimBridgesExistingSupplyAndGasToCaller() public {
        vm.prank(user); faucet.claim();
        require(token.balanceOf(user) == 0.01 ether && token.totalSupply() == 1 ether, "supply");
        require(bridge.gasSent() == 0.0002 ether && bridge.recipient() == user && bridge.destination() == 4, "bridge");
        require(token.allowance(address(faucet), address(bridge)) == 0, "bounded approval");
    }
    function testCooldownAndRetryNextDay() public {
        vm.prank(user); faucet.claim();
        vm.expectRevert(bytes("claim cooldown")); vm.prank(user); faucet.claim();
        vm.warp(block.timestamp + 1 days); vm.prank(user); faucet.claim();
        require(token.balanceOf(user) == 0.02 ether, "second claim");
    }
    function testBridgeFailureRollsBackCooldownAndGas() public {
        bridge.setFail(); vm.expectRevert(bytes("bridge failed")); vm.prank(user); faucet.claim();
        require(faucet.nextClaimAt(user) == 0 && bridge.gasSent() == 0 && address(faucet).balance == 0.01 ether, "rollback");
    }
    function testEmptyFaucetAndMainnetRejected() public {
        vm.deal(address(faucet), 0); vm.expectRevert(bytes("faucet empty")); vm.prank(user); faucet.claim();
        vm.chainId(1); vm.expectRevert(bytes("Chiado only")); new ChiadoCowFaucet(address(token), address(bridge), 4);
    }
}
