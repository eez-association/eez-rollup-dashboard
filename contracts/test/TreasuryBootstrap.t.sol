// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {Test} from "forge-std/Test.sol";
import {TreasuryBootstrap} from "../src/shared/TreasuryBootstrap.sol";

contract BootstrapTarget {
    uint256 public value;

    function set(uint256 next) external {
        value = next;
    }

    function fail() external pure {
        revert("late failure");
    }

    function falseResult() external pure returns (bool) {
        return false;
    }
}

contract TreasuryBootstrapTest is Test {
    BootstrapTarget target;

    function setUp() public {
        target = new BootstrapTarget();
    }

    function one(bytes memory data) private view returns (TreasuryBootstrap.Action[] memory actions) {
        actions = new TreasuryBootstrap.Action[](1);
        actions[0] = TreasuryBootstrap.Action(false, address(target), data, bytes32(0));
    }

    function testCreationAndLateFailureRollBackWholeBatch() public {
        TreasuryBootstrap batch = new TreasuryBootstrap(one(abi.encodeCall(target.set, (1))));
        address predicted = vm.computeCreateAddress(address(batch), 1);
        TreasuryBootstrap.Action[] memory actions = new TreasuryBootstrap.Action[](3);
        actions[0] = TreasuryBootstrap.Action(true, predicted, type(BootstrapTarget).creationCode, bytes32(0));
        actions[1] = TreasuryBootstrap.Action(false, address(target), abi.encodeCall(target.set, (2)), bytes32(0));
        actions[2] = TreasuryBootstrap.Action(false, address(target), abi.encodeCall(target.fail, ()), bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBootstrap.FailedAction.selector, 2, abi.encodeWithSignature("Error(string)", "late failure")
            )
        );
        batch.execute(1, actions, true);
        assertEq(predicted.code.length, 0);
        assertEq(target.value(), 1);
        assertEq(batch.sequence(), 1);
        assertEq(vm.getNonce(address(batch)), 1);
        assertFalse(batch.closed());
        actions[2].data = abi.encodeCall(target.set, (3));
        batch.execute(1, actions, true);
        assertGt(predicted.code.length, 0);
        assertEq(target.value(), 3);
        assertTrue(batch.closed());
        vm.expectRevert(TreasuryBootstrap.Unavailable.selector);
        batch.execute(2, actions, true);
    }

    function testOwnerAndSequenceCannotBeBypassed() public {
        TreasuryBootstrap batch = new TreasuryBootstrap(one(abi.encodeCall(target.set, (1))));
        vm.prank(address(0xbad));
        vm.expectRevert(TreasuryBootstrap.Unauthorized.selector);
        batch.execute(1, one(abi.encodeCall(target.set, (2))), false);
        vm.expectRevert(TreasuryBootstrap.InvalidSequence.selector);
        batch.execute(0, one(abi.encodeCall(target.set, (2))), false);
        assertEq(target.value(), 1);
        assertEq(batch.owner(), address(this));
        vm.prank(address(0xbad));
        TreasuryBootstrap other = new TreasuryBootstrap(one(abi.encodeCall(target.set, (2))));
        assertEq(other.owner(), address(0xbad));
        vm.expectRevert(TreasuryBootstrap.Unauthorized.selector);
        other.execute(1, one(abi.encodeCall(target.set, (3))), false);
        assertEq(target.value(), 2);
    }

    function testFalseTokenResultRejectsBatch() public {
        TreasuryBootstrap.Action[] memory actions = one(abi.encodeCall(target.falseResult, ()));
        actions[0].returnHash = keccak256(abi.encode(true));
        vm.expectRevert(abi.encodeWithSelector(TreasuryBootstrap.InvalidAction.selector, 0));
        new TreasuryBootstrap(actions);
    }

    TreasuryBootstrap private activeBatch;

    function reenter() external {
        activeBatch.execute(activeBatch.sequence(), one(abi.encodeCall(target.set, (99))), false);
    }

    function testOwnerCallbackCannotReenter() public {
        activeBatch = new TreasuryBootstrap(one(abi.encodeCall(target.set, (1))));
        TreasuryBootstrap.Action[] memory actions = one(abi.encodeCall(this.reenter, ()));
        actions[0].target = address(this);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryBootstrap.FailedAction.selector,
                0,
                abi.encodeWithSelector(TreasuryBootstrap.Unavailable.selector)
            )
        );
        activeBatch.execute(1, actions, false);
        assertEq(activeBatch.sequence(), 1);
        assertEq(target.value(), 1);
    }

    function testUnexpectedCreateAddressAndEmptyCodeRejected() public {
        TreasuryBootstrap.Action[] memory actions = one(type(BootstrapTarget).creationCode);
        actions[0].create = true;
        actions[0].target = address(0xbad);
        vm.expectRevert(abi.encodeWithSelector(TreasuryBootstrap.InvalidAction.selector, 0));
        new TreasuryBootstrap(actions);
        actions[0].create = false;
        actions[0].data = "";
        vm.expectRevert(abi.encodeWithSelector(TreasuryBootstrap.InvalidAction.selector, 0));
        new TreasuryBootstrap(actions);
    }
}
