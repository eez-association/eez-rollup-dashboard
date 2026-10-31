"""An unconfigured CoW deployment must keep its local status API available."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


class Rpc(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        method = payload['method']
        if method == 'eth_chainId':
            result = hex(10200 if self.path == '/l1' else 699169)
        elif method == 'eth_blockNumber':
            result = '0x7'
        elif method == 'eth_getBlockByNumber':
            result = {'hash': '0x' + '11' * 32, 'number': '0x0'}
        else:
            raise AssertionError('Unexpected RPC: ' + method)
        body = json.dumps({'jsonrpc': '2.0', 'id': payload['id'], 'result': result}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class ApiStartupTests(unittest.TestCase):
    def test_missing_contracts_keep_health_live_and_reject_trading(self):
        rpc = ThreadingHTTPServer(('127.0.0.1', 0), Rpc)
        threading.Thread(target=rpc.serve_forever, daemon=True).start()
        self.addCleanup(rpc.server_close)
        self.addCleanup(rpc.shutdown)
        upstream = f'http://127.0.0.1:{rpc.server_port}'
        with tempfile.TemporaryDirectory() as directory:
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG')}
            env.update(COW_NETWORK='chiado', L1_RPC=upstream+'/l1',
                       L2_RPC=upstream+'/l2', L2_FRONT=upstream+'/l2',
                       L2_ROLLUP_ID='2', BRIDGE_L2='0x'+'12'*20,
                       BRIDGE_L1='0x'+'12'*20, EEZ_MANAGER_L2='0x'+'34'*20,
                       COW_MANIFEST=directory+'/cow.json', ROUTE_MANIFEST=directory+'/route.json',
                       ORDER_QUEUE=directory+'/orders.jsonl', HOST='127.0.0.1', PORT='0')
            with tempfile.TemporaryFile(mode='w+') as errors:
                proc = subprocess.Popen([sys.executable, 'backend/server.py'], cwd=ROOT, env=env,
                                        stdout=subprocess.PIPE, stderr=errors, text=True)
                try:
                    self.assertTrue(select.select([proc.stdout], [], [], 15)[0], 'API startup timed out')
                    port = proc.stdout.readline().strip().rsplit(':', 1)[-1]
                    errors.seek(0)
                    self.assertTrue(port.isdigit(), errors.read())
                    origin = 'http://127.0.0.1:' + port
                    with urlopen(origin+'/api/health', timeout=5) as response:
                        self.assertEqual(response.headers['cache-control'], 'no-store')
                        self.assertEqual(json.load(response)['l2Head'], 7)
                    for path in ('config', 'tokens', 'quote', 'wrapper', 'allowance', 'balances', 'faucet'):
                        with self.assertRaises(HTTPError) as caught:
                            urlopen(origin+'/api/'+path, timeout=5)
                        self.assertEqual(caught.exception.code, 503)
                        self.assertEqual(caught.exception.headers['cache-control'], 'no-store')
                        self.assertEqual(json.load(caught.exception)['status'], 'deployment_required')
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(Request(origin+'/api/orders', data=b'{}',
                                        headers={'Content-Type':'application/json'}), timeout=5)
                    self.assertEqual(caught.exception.code, 400)
                    self.assertFalse(Path(env['ORDER_QUEUE']).exists())
                finally:
                    proc.terminate()
                    proc.wait(timeout=5)
                    proc.stdout.close()


if __name__ == '__main__':
    unittest.main()
