"""GPv2 signed-order identity used to check fills before a fresh attempt."""
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak

ORDER_TYPES = {'Order': [{'name': name, 'type': typ} for name, typ in (
    ('sellToken', 'address'), ('buyToken', 'address'), ('receiver', 'address'),
    ('sellAmount', 'uint256'), ('buyAmount', 'uint256'), ('validTo', 'uint32'),
    ('appData', 'bytes32'), ('feeAmount', 'uint256'), ('kind', 'string'),
    ('partiallyFillable', 'bool'), ('sellTokenBalance', 'string'), ('buyTokenBalance', 'string'))]}


def signed_identity(order, signature, chain, settlement):
    message = encode_typed_data(domain_data={'name': 'Gnosis Protocol', 'version': 'v2',
        'chainId': chain, 'verifyingContract': settlement}, message_types=ORDER_TYPES, message_data=order)
    owner = Account.recover_message(message, signature=signature)
    digest = keccak(b'\x19' + message.version + message.header + message.body)
    return owner, digest + bytes.fromhex(owner[2:]) + int(order['validTo']).to_bytes(4, 'big')
