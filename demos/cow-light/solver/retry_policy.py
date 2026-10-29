"""Bounded pre-submission retries. A recorded transaction is never replaced."""
import json
import time

MAX_RETRIES = 8


def due(item, now=None):
    now = int(time.time()) if now is None else now
    solver = item.get('solver') or {}
    return (bool(solver.get('txHash') or solver.get('settlement'))
            or int(item.get('order', {}).get('validTo', 0)) <= now
            or int(solver.get('nextAttemptAt', 0)) <= now)


def price_failure(error, quoted, current):
    """Require both a lower observed output and a known payout/slippage error.

    A generic execution revert, invalid signature or unsupported transaction
    is not sufficient evidence of price movement.
    """
    if current >= quoted:
        return False
    text = json.dumps(error, sort_keys=True).lower()
    return any(marker in text for marker in (
        'erc20: transfer amount exceeds balance',
        'erc20insufficientbalance', '0xe450d38c',
        'slippage()', '0x7dd37f70',
    ))


def retry_fields(item, reason, now=None, waiting_price=False):
    now = int(time.time()) if now is None else now
    solver = item.get('solver') or {}
    if solver.get('txHash') or solver.get('settlement'):
        raise ValueError('Submitted transactions must be reconciled, never retried')
    deadline = int(item['order']['validTo'])
    count = int(solver.get('retryCount', 0))
    if now >= deadline:
        return 'expired', {'error': 'Order expired before settlement.', 'nextAttemptAt': None}
    if not waiting_price and count >= MAX_RETRIES:
        return 'failed', {'error': 'Pre-submission retry limit reached: ' + reason, 'nextAttemptAt': None}
    count += not waiting_price
    delay = 60 if waiting_price else min(60, 5 * 2 ** (count - 1))
    return 'queued', {'retryCount': count, 'nextAttemptAt': min(deadline, now + delay),
                      'error': None, 'message': reason, 'retryReason': reason}
