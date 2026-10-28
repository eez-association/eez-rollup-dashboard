// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Wallet-owned executor used only to create and finish a test treasury.
/// @dev No delegatecall, Safe ownership, or module authority. Constructor calls
///      are atomic with deployment. Later calls require the original wallet and
///      exact sequence; closing permanently disables this executor. Do not send
///      unrelated assets to it. A failed action restores the entire batch.
contract TreasuryBootstrap {
    struct Action {
        bool create;
        address target;
        bytes data;
        bytes32 returnHash;
    }

    address public immutable owner;
    uint256 public sequence;
    bool public closed;
    bool private executing;

    error Unauthorized();
    error InvalidSequence();
    error Unavailable();
    error InvalidAction(uint256 index);
    error FailedAction(uint256 index, bytes reason);
    event Created(uint256 indexed index, address indexed target, bytes32 initHash);
    event Executed(uint256 indexed sequence, bytes32 actionsHash, bool closed);

    constructor(Action[] memory actions) {
        owner = msg.sender;
        _execute(actions, false);
    }

    function execute(uint256 expectedSequence, Action[] calldata actions, bool finish) external {
        if (msg.sender != owner) revert Unauthorized();
        if (expectedSequence != sequence) revert InvalidSequence();
        _execute(actions, finish);
    }

    function _execute(Action[] memory actions, bool finish) private {
        if (closed || executing) revert Unavailable();
        if (actions.length == 0) revert InvalidAction(0);
        executing = true;
        uint256 current = sequence++;
        for (uint256 i; i < actions.length; ++i) {
            Action memory action = actions[i];
            if (action.target == address(0)) revert InvalidAction(i);
            if (action.create) {
                if (action.data.length == 0 || action.data.length > 49152 || action.returnHash != bytes32(0)) {
                    revert InvalidAction(i);
                }
                bytes memory initcode = action.data;
                address created;
                // CREATE reads the memory byte array. Its address is checked so
                // unexpected executor nonce changes cannot redirect later calls.
                assembly ("memory-safe") {
                    created := create(0, add(initcode, 32), mload(initcode))
                }
                if (created != action.target || created.code.length == 0) revert InvalidAction(i);
                emit Created(i, created, keccak256(initcode));
            } else {
                if (action.target.code.length == 0) revert InvalidAction(i);
                (bool success, bytes memory result) = action.target.call(action.data);
                if (!success) revert FailedAction(i, result);
                if (action.returnHash != bytes32(0) && keccak256(result) != action.returnHash) {
                    revert InvalidAction(i);
                }
            }
        }
        closed = finish;
        executing = false;
        emit Executed(current, keccak256(abi.encode(actions)), finish);
    }
}
