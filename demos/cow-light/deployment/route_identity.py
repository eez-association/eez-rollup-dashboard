"""Resolve the L1 caller EEZ uses when executing an L2 route's call."""

from web3.exceptions import BadFunctionCallOutput, ContractLogicError

MANAGER_ABI = [{'type': 'function', 'name': name, 'stateMutability': 'view',
    'inputs': [], 'outputs': [{'type': 'address'}]} for name in ('EEZContract', 'manager')]
PROXY_ABI = [{'type': 'function', 'name': 'computeCrossChainProxyAddress',
    'stateMutability': 'view', 'inputs': [{'type': 'address'}, {'type': 'uint64'}],
    'outputs': [{'type': 'address'}]}]


def bridge_manager(l1, bridge):
    contract = l1.eth.contract(bridge, abi=MANAGER_ABI)
    try:
        manager = contract.functions.EEZContract().call()
    except (ContractLogicError, BadFunctionCallOutput):
        manager = contract.functions.manager().call()
    if not l1.eth.get_code(manager):
        raise ValueError('L1 bridge manager has no deployed code')
    return manager


def authorized_l1_caller(l1, bridge, route, rollup_id):
    manager = bridge_manager(l1, bridge)
    # On L1 msg.sender is the L1 manager's proxy for the source route, not
    # the route's own L2 address or the L2 proxy for the destination helper.
    return l1.eth.contract(manager, abi=PROXY_ABI).functions.computeCrossChainProxyAddress(route, rollup_id).call()
