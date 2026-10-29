import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from eth_account import Account
from web3 import Web3

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deployment.signers import LedgerSigner, solver_address
from deployment.create_solver_wallet import create


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.account = Account.create()
        self.tx = dict(type=2, chainId=31337, nonce=0, gas=100000,
                       maxFeePerGas=100, maxPriorityFeePerGas=10,
                       value=0, data='0x1234')
        self.signer = LedgerSigner(self.account.address, 'http://localhost:8545', "m/44'/60'/0'/0/0")

    def result(self, tx=None, account=None):
        signed = (account or self.account).sign_transaction(tx or self.tx)
        return subprocess.CompletedProcess([], 0, Web3.to_hex(signed.raw_transaction))

    def test_creation_and_call_preserve_signed_fields(self):
        for to in (None, '0x' + '22' * 20):
            if to:
                self.tx['to'] = to
            with patch('deployment.signers.subprocess.run', return_value=self.result()) as run:
                signed = self.signer.sign_transaction(self.tx)
                self.assertEqual(Account.recover_transaction(signed.raw_transaction), self.account.address)
                args = run.call_args.args[0]
                self.assertEqual(args[:2], ['cast', 'mktx'])
                self.assertIn(to or '--create', args)

    def test_modified_fee_destination_data_and_chain_rejected(self):
        for field, value in [('maxFeePerGas', 101), ('chainId', 1),
                             ('to', '0x' + '33' * 20), ('data', '0xabcd')]:
            with self.subTest(field=field):
                with patch('deployment.signers.subprocess.run', return_value=self.result({**self.tx, field:value})):
                    with self.assertRaisesRegex(ValueError, 'unexpected'):
                        self.signer.sign_transaction(self.tx)

    def test_wrong_device_address_rejected(self):
        with patch('deployment.signers.subprocess.run', return_value=self.result(account=Account.create())):
            with self.assertRaisesRegex(ValueError, 'mismatch'):
                self.signer.sign_transaction(self.tx)

    def test_rejection_propagates_without_fallback(self):
        with patch('deployment.signers.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'cast')):
            with self.assertRaises(subprocess.CalledProcessError):
                self.signer.sign_transaction(self.tx)

    def test_ledger_requires_separate_explicit_solver(self):
        with patch.dict(os.environ, {'DEPLOYER_SIGNER':'ledger'}, clear=True):
            with self.assertRaises(ValueError):
                solver_address(self.account.address)
            os.environ['COW_SOLVER_ADDRESS'] = self.account.address
            with self.assertRaises(ValueError):
                solver_address(self.account.address)
            expected = Account.create().address
            os.environ['COW_SOLVER_ADDRESS'] = expected
            self.assertEqual(solver_address(self.account.address), expected)

    def test_solver_file_private_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'solver.key'
            address = create(path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(Account.from_key(path.read_text().strip().split('=',1)[1]).address, address)
            before = path.read_bytes()
            with self.assertRaises(FileExistsError):
                create(path)
            self.assertEqual(before, path.read_bytes())
