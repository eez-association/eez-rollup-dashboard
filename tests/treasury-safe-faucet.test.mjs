import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toHex } from 'viem';
import { verifiedSafeFaucet, readSafeFaucet, safeFaucetKey } from '../src/lib/treasury/safeFaucet.ts';
import { TestnetAsset } from '../src/lib/treasury/testnetAsset.ts';
const read = p => JSON.parse(readFileSync(p));
const release = read(`src/lib/treasury/builds/${read('src/lib/treasury/current-build.json').build}.json`);
const a = n => toHex(n, { size: 20 });
const config = () => ({ environment: 'dashboard-testnet', instance: toHex(1, { size: 32 }), safeL1: a(10), safeL2: a(11),
  l1: { rpc: 'http://localhost/l1', front: 'http://localhost/l1-front' }, l2: { rpc: 'http://localhost/l2', front: 'http://localhost/l2-front' },
  fees: { maxTotalWei: '100', l1MaxTotalWei: '100' },
  payments: { pair: { version: 1 }, bridgeKind: 'standard', tokenL1: a(30), tokenL2: a(31), bridgeL1: a(1), bridgeL2: a(2), assetLabel: 'Test USDC' } });

test('a faucet is exposed only for the verified test contract, never a label or mainnet flag', async t => {
  const c = config(); let code = release.contracts.TestUSDC.runtime, validated = 0, reads = 0;
  t.mock.method(TestnetAsset.prototype, 'rpc', async () => { reads++; return code; });
  t.mock.method(TestnetAsset.prototype, 'validate', async () => { validated++; });
  t.mock.method(TestnetAsset.prototype, 'validateToken', async token => { assert.equal(token, c.payments.tokenL1); validated++; });
  t.mock.method(TestnetAsset.prototype, 'read', async () => c.payments.tokenL2);
  assert(await verifiedSafeFaucet(c, release)); assert.equal(validated, 2);
  code = '0x6000'; assert.equal(await verifiedSafeFaucet(c, release), null); assert.equal(validated, 2);
  const before = reads;
  assert.equal(await verifiedSafeFaucet({ ...c, environment: 'ethereum-mainnet' }, release), null);
  assert.equal(await verifiedSafeFaucet({ ...c, payments: { ...c.payments, pair: undefined } }, release), null);
  assert.equal(reads, before);
});
test('verified test code still requires the network and wrapped token to match', async t => {
  const c = config();
  t.mock.method(TestnetAsset.prototype, 'rpc', async () => release.contracts.TestUSDC.runtime);
  t.mock.method(TestnetAsset.prototype, 'validate', async () => { throw new Error('Network changed'); });
  await assert.rejects(verifiedSafeFaucet(c, release), /Network changed/);
  t.mock.method(TestnetAsset.prototype, 'validate', async () => {});
  t.mock.method(TestnetAsset.prototype, 'validateToken', async () => {});
  t.mock.method(TestnetAsset.prototype, 'read', async () => a(99));
  await assert.rejects(verifiedSafeFaucet(c, release), /wrapped token/);
});
test('faucet recovery is bound to its token and the Safe for the selected destination', () => {
  const c = config(), d = new TestnetAsset({ ...c, fees: { l1: '100', l2: '100' } }, release, a(1), a(2));
  assert.equal(readSafeFaucet(c, null).token, c.payments.tokenL1);
  for (const kind of ['l1', 'l2']) {
    const recipient = kind === 'l1' ? c.safeL1 : c.safeL2;
    const pending = { id: kind, kind, chain: 'l1', sender: a(3), nonce: '0x0', data: d.data(kind, recipient), recipient,
      token: c.payments.tokenL1, to: c.payments.tokenL1, build: release.build, l2StartBlock: '0x1' };
    const s = { token: c.payments.tokenL1, pending };
    assert.deepEqual(readSafeFaucet(c, JSON.stringify(s)), s);
    assert.throws(() => readSafeFaucet(c, JSON.stringify({ ...s, pending: { ...pending, recipient: a(99) } })), /another token or Safe/);
    assert.throws(() => readSafeFaucet(c, JSON.stringify({ ...s, pending: { ...pending, kind: 'deploy', token: undefined, to: undefined, data: d.data('deploy', recipient) } })), /another token or Safe/);
  }
  assert.throws(() => readSafeFaucet(c, JSON.stringify({ token: a(99) })), /another token or Safe/);
  assert.notEqual(safeFaucetKey(c), safeFaucetKey({ ...c, instance: toHex(2, { size: 32 }) }));
  assert.notEqual(safeFaucetKey(c), safeFaucetKey({ ...c, payments: { ...c.payments, tokenL1: a(99) } }));
});
