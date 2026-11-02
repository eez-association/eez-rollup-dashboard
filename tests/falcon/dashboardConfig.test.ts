import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { keccak256, type Hex } from 'viem';
import { falconDashboardConfig } from '../../src/lib/falcon/dashboardConfig.ts';
import { crossChainDeployment as d, testnetDeployment } from '../../src/lib/falcon/crossChainDeployment.ts';

const host = { l1ChainId: '0x27d8', l2ChainId: '0xdfde9', registry: d.l1.registry,
  manager: d.l2.manager, rollupId: '4', feesEnabled: true, quoteUrl: 'https://dashboard.example/composer/l2',
  maxTotalWei: '100000000000000000', nativeSymbol: 'xDAI' };
test('only the discovered network and pinned routing enable contract actions', () => {
  assert.equal(falconDashboardConfig(host).deployment, d);
  for (const patch of [{ l1ChainId: null }, { l2ChainId: null }, { l1ChainId: '0x1' }, { l2ChainId: '0xdd6d9' },
    { l2ChainId: 'bad' }, { registry: d.l2.manager }, { manager: d.l1.registry }, { rollupId: '3' }, { rollupId: '' }]) {
    assert.equal(falconDashboardConfig({ ...host, ...patch }).deployment, null);
  }
});
test('fees reuse the host endpoint and native ceiling without enabling an unquoted Safe path', () => {
  assert.deepEqual(falconDashboardConfig(host).fees, { url: host.quoteUrl, maxTotalFee: 100000000000000000n, nativeSymbol: 'xDAI' });
  assert.equal(falconDashboardConfig({ ...host, feesEnabled: false }).fees, null);
  assert.equal(falconDashboardConfig({ ...host, quoteUrl: '' }).fees, null);
  for (const maxTotalWei of ['', '0', '-1', '1.1', '01', ' 1', '1e18', String(2n ** 256n)]) {
    assert.equal(falconDashboardConfig({ ...host, maxTotalWei }).fees, null);
  }
  assert.equal(falconDashboardConfig({ ...host, maxTotalWei: '1' }).fees?.maxTotalFee, 1n);
});
test('eez.dev uses its verified contracts and rejects mixed devnet routing', () => {
  const testnet = { ...host, l2ChainId: '0xaab21', registry: testnetDeployment.l1.registry, rollupId: '2', quoteUrl: 'https://eez.dev/composer/l2' };
  assert.equal(falconDashboardConfig(testnet).deployment, testnetDeployment);
  assert.equal(falconDashboardConfig(testnet).fees?.url, testnet.quoteUrl);
  for (const patch of [{ registry: d.l1.registry }, { rollupId: '4' }, { l2ChainId: host.l2ChainId }, { l2ChainId: null }]) {
    assert.equal(falconDashboardConfig({ ...testnet, ...patch }).deployment, null);
  }
});
test('public wallet-test bytecode matches the deployment identities, independently of RPC mocks', () => {
  const code = JSON.parse(readFileSync(new URL('./fixtures/deployed-code.json', import.meta.url), 'utf8'));
  const bindings = { verifier: d.l2.verifier, controllerFactory: d.l2.factory, safeFactory: d.l1.safe!.factory,
    singleton: d.l1.safe!.singleton, fallbackHandler: d.l1.safe!.fallbackHandler };
  for (const [name, binding] of Object.entries(bindings)) {
    assert.equal(code[name].address, binding.address);
    assert.equal(keccak256(code[name].code as Hex), binding.runtimeCodeHash);
  }
});
test('eez.dev wallet fixture bytecode matches its verified deployment', () => {
  const code = JSON.parse(readFileSync(new URL('./fixtures/testnet-deployed-code.json', import.meta.url), 'utf8'));
  for (const [name, binding] of Object.entries({ verifier: testnetDeployment.l2.verifier, controllerFactory: testnetDeployment.l2.factory })) {
    assert.equal(code[name].address, binding.address);
    assert.equal(keccak256(code[name].code as Hex), binding.runtimeCodeHash);
  }
});
