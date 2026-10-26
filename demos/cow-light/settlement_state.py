"""Durable submission state and read-only canonical settlement reconciliation."""
import fcntl
import json
import os
import time

ACTIVE = ('queued', 'submitting', 'submitted', 'awaiting_settlement')


def is_active(row):
    solver = row.get('solver') or {}
    return row.get('status') in ACTIVE or (
        row.get('status') == 'settled' and solver.get('settlement')
        and solver.get('canonicalVerified') is not True
    )


def update_order(queue, order_id, status, **fields):
    queue.parent.mkdir(parents=True, exist_ok=True)
    with queue.with_suffix(queue.suffix + '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rows = [json.loads(line) for line in queue.read_text().splitlines() if line.strip()]
        row = next(row for row in rows if row['id'] == order_id)
        row['status'] = status
        row['solver'] = {**row.get('solver', {}), **fields, 'checkedAt': int(time.time())}
        temp = queue.with_suffix(queue.suffix + '.tmp')
        with temp.open('w') as out:
            out.write(''.join(json.dumps(row) + '\n' for row in rows))
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, queue)
        directory = os.open(queue.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return row


def same(a, b):
    return bool(a and b and str(a).lower() == str(b).lower())


def number(value):
    return int(value, 16) if isinstance(value, str) and value.startswith('0x') else int(value)


def inspect_settlement(tx_hash, rpc, l1, l2, composer):
    """An execution receipt is not settlement. Never sends or signs a transaction.

    Require a successful source receipt, a matching canonical indexed L2 block,
    and a successful L1 posting receipt in the current L1 block. This establishes
    canonical inclusion, not consensus finality.
    """
    state = {'status': 'submitted', 'txHash': tx_hash, 'settlement': None,
             'canonicalVerified': False,
             'settlementBlock': None, 'l1Tx': None, 'l1Block': None,
             'error': None, 'message': 'Waiting for L2 execution.'}
    try:
        # Composer availability must not prevent checking stronger on-chain
        # evidence, but a rejection is only terminal when explicitly recorded.
        try:
            cross = rpc(composer, 'eez_getCrossChainTransaction', [tx_hash]) or {}
        except Exception:
            cross = {}
        ownership = cross.get('ownership') or {}
        rejection = ownership.get('rejection')
        receipt = rpc(l2, 'eth_getTransactionReceipt', [tx_hash])
        if not receipt:
            if cross.get('lifecycle') == 'terminal' and rejection and not ownership.get('canonical'):
                return {**state, 'status': 'failed', 'error': f'Composer rejected transaction: {rejection}',
                        'message': 'Composer recorded a terminal rejection.'}
            return state
        if not same(receipt.get('transactionHash'), tx_hash):
            raise ValueError('L2 receipt does not match the submitted transaction')
        block = rpc(l2, 'eth_getBlockByNumber', [receipt['blockNumber'], False]) or {}
        if not same(block.get('hash'), receipt.get('blockHash')):
            return {**state, 'message': 'L2 inclusion changed; waiting for canonical evidence.'}
        state.update(status='awaiting_settlement', message='Executed on L2; awaiting canonical L1 settlement.')
        record = rpc(composer, 'eez_getSettlementByL2Block', [receipt['blockHash']]) or {}
        if record.get('canonicalL2') is not True or not any(
            same(b.get('hash'), receipt['blockHash']) and number(b['number']) == number(receipt['blockNumber'])
            for b in record.get('l2Blocks', [])
        ):
            if cross.get('lifecycle') == 'terminal' and rejection and not ownership.get('canonical'):
                return {**state, 'status': 'failed', 'error': f'Composer rejected transaction: {rejection}'}
            return state
        post_hash = record.get('l1TransactionHash')
        post = rpc(l1, 'eth_getTransactionReceipt', [post_hash]) if post_hash else None
        if not post or number(post['status']) != 1 or not same(post.get('transactionHash'), post_hash):
            return {**state, 'message': 'Waiting for a successful L1 posting receipt.'}
        anchor = rpc(l1, 'eth_getBlockByNumber', [post['blockNumber'], False]) or {}
        if (not same(anchor.get('hash'), post.get('blockHash'))
                or not same(post.get('blockHash'), record.get('l1BlockHash'))
                or number(post['blockNumber']) != number(record['l1BlockNumber'])):
            return {**state, 'message': 'L1 posting changed; waiting for canonical evidence.'}
        if number(receipt['status']) != 1:
            return {**state, 'status': 'failed', 'error': 'L2 transaction reverted in the canonically settled block.',
                    'message': 'Transaction reverted.'}
        return {**state, 'status': 'settled', 'settlement': tx_hash, 'canonicalVerified': True,
                'settlementBlock': number(receipt['blockNumber']), 'l1Tx': post_hash,
                'l1Block': number(post['blockNumber']),
                'message': 'Canonical settlement confirmed. Consensus finality is not asserted.'}
    except Exception as exc:
        # Unavailable RPCs, malformed/partial index data and timeouts are never
        # interpreted as proof of failure or permission to resubmit.
        return {**state, 'message': f'Settlement evidence unavailable; will retry: {exc}'}


def reconcile(queue, item, rpc, l1, l2, composer):
    solver = item.get('solver') or {}
    tx_hash = solver.get('txHash') or solver.get('settlement')
    if not tx_hash:
        raise ValueError('Cannot reconcile a submission without its transaction hash')
    result = inspect_settlement(tx_hash, rpc, l1, l2, composer)
    status = result.pop('status')
    return update_order(queue, item['id'], status, **result)
