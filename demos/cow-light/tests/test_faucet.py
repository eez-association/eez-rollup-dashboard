import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from web3 import Web3

ROOT=Path(__file__).resolve().parents[1]
A=Web3.to_checksum_address('0x'+'ab'*20)
B=Web3.to_checksum_address('0x'+'cd'*20)
class FaucetTests(unittest.TestCase):
    def fixture(self):
        values={'token':A,'bridge':B,'rollupId':4,'tokenAmount':10**16,'gasAmount':2*10**14,
                'cooldown':86400,'nextClaimAt':0,'balanceOf':10**18}
        class Functions:
            def __getattr__(self,name):
                def method(*args):
                    for arg in args:
                        if isinstance(arg,str): assert Web3.is_checksum_address(arg)
                    return SimpleNamespace(call=lambda:values[name])
                return method
        eth=SimpleNamespace(contract=lambda *a,**kw:SimpleNamespace(functions=Functions()),
                            get_balance=lambda _:10**18,get_block=lambda _: {'timestamp':100})
        ns={'CFG':{'NETWORK':'chiado','COW_FAUCET_L1':A,'BRIDGE_L1':B,'L2_ROLLUP_ID':4},
            'L1_CHAIN':10200,'WETH':A,'WETH_L2':A,'Web3':Web3,'l1':SimpleNamespace(eth=eth),'l2':SimpleNamespace(eth=eth)}
        tree=ast.parse((ROOT/'backend/server.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='faucet_status')
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'<faucet test>','exec'),ns)
        return ns,values

    def test_read_only_status_accepts_lowercase_owner_and_reports_cooldown(self):
        ns,values=self.fixture()
        result=ns['faucet_status'](B.lower())
        self.assertEqual(result['owner'],B)
        self.assertTrue(result['funded'] and result['eligible'])
        values['nextClaimAt']=101
        self.assertFalse(ns['faucet_status'](B)['eligible'])
        values['balanceOf']=0
        self.assertFalse(ns['faucet_status'](B)['funded'])

    def test_mainnet_unconfigured_and_wrong_bindings_rejected(self):
        for key,value in [('NETWORK','mainnet'),('COW_FAUCET_L1',None),('BRIDGE_L1',A),('L2_ROLLUP_ID',5)]:
            ns,_=self.fixture();ns['CFG'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):ns['faucet_status'](B)

if __name__=='__main__':unittest.main()
