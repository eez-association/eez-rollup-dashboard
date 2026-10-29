"""Create a solver key on its operating machine; print only its public address."""
import argparse
import os
from pathlib import Path
from eth_account import Account


def create(path):
    account = Account.create()
    # Exclusive creation: rerunning must never replace an operating signer.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write('SOLVER_PRIVATE_KEY=0x' + bytes(account.key).hex() + '\n')
        output.flush()
        os.fsync(output.fileno())
    return account.address


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(create(args.output))
