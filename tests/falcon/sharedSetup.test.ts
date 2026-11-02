import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, toHex, zeroAddress, zeroHash, type Hex } from 'viem';
import { mainnetDeployment as d } from '../../src/lib/falcon/crossChainDeployment.ts';
import { falconDashboardConfig } from '../../src/lib/falcon/dashboardConfig.ts';
import { confirmSharedSetup, deploymentSetupPlan, inspectSharedSetup, setupAttemptContract } from '../../src/lib/falcon/sharedSetup.ts';
import { matchingDeployer } from '../../src/lib/treasury/matchingSafes.ts';
import { readRecovery, recoveryKey, scopedRecoveryKey, recordWalletHash, resolveRecovery, updateRecovery, type RecoveryAttempt } from '../../src/lib/falcon/recoveryJournal.ts';
import { deploymentCode } from './deploymentCode.ts';
import type { EezClient } from '../../src/lib/falcon/eez.ts';

const plan = deploymentSetupPlan(d), signal = new AbortController().signal;
const account = '0x1111111111111111111111111111111111111111', hash = toHex(7n, { size: 32 });
const attempt: RecoveryAttempt = { version: 1, id: 'setup', kind: 'infrastructure', chainId: d.l2.chainId,
  account, to: matchingDeployer, value: '0', nonce: '3', data: plan[0]!.data, publicKey: '0x', hash };
function fixture() {
  const codes = Object.fromEntries(Object.values(deploymentCode(d)).map(item => [item.address.toLowerCase(), item.code]));
  const state = { codes, wrongChain: false, wrongAnchor: false, reorg: false, rollup: 2n, useGas: false,
    tx: { hash, from: account, to: matchingDeployer, nonce: 3, value: 0n, input: attempt.data, chainId: d.l2.chainId, blockNumber: 100n, blockHash: zeroHash },
    receipt: { transactionHash: hash, from: account, to: matchingDeployer, blockNumber: 100n, blockHash: zeroHash, status: 'success' },
  };
  const client = (chain: 'l1' | 'l2') => ({
    getChainId: async () => state.wrongChain ? 999 : d[chain].chainId,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? 100n,
      hash: blockNumber === d[chain].anchor.blockNumber ? state.wrongAnchor ? zeroHash : d[chain].anchor.blockHash : state.reorg && blockNumber ? hash : zeroHash }),
    getCode: async ({ address }: { address: string }) => state.codes[address.toLowerCase()] ?? '0x',
    readContract: async ({ functionName }: { functionName: string }) => functionName === 'ROLLUP_ID' ? state.rollup : state.useGas,
    getTransaction: async () => state.tx, getTransactionReceipt: async () => state.receipt,
  }) as unknown as EezClient;
  return { state, clients: { l1: client('l1'), l2: client('l2') } };
}
test('mainnet accepts only the discovered Ethereum/RollupX route and retains ETH fee settings', () => {
  const host = { l1ChainId: '0x1', l2ChainId: toHex(d.l2.chainId), registry: d.l1.registry, manager: d.l2.manager,
    rollupId: '2', feesEnabled: true, quoteUrl: 'https://rollupx.eez.dev/composer/l2', maxTotalWei: '100000000000000000', nativeSymbol: 'ETH' };
  assert.equal(falconDashboardConfig(host).deployment, d);
  assert.equal(falconDashboardConfig(host).fees?.nativeSymbol, 'ETH');
  for (const patch of [{ l1ChainId: '0x27d8' }, { l2ChainId: '916969' }, { registry: zeroAddress }, { manager: zeroAddress }, { rollupId: '4' }]) {
    assert.equal(falconDashboardConfig({ ...host, ...patch }).deployment, null);
  }
});
test('shared plan is key/wallet independent and mismatched artifact bindings fail closed', () => {
  assert.equal(keccak256(plan[0]!.runtime), '0x28402fe675b2e0b8fdcb281c7b5bef4c441ba32adae6b68c30f9471d87af0e66');
  for (const patch of [{ l1: { ...d.l1, chainId: 10200 } }, { l2: { ...d.l2, manager: zeroAddress } },
    { l2: { ...d.l2, verifier: { ...d.l2.verifier, runtimeCodeHash: zeroHash } } }]) {
    assert.throws(() => deploymentSetupPlan({ ...d, ...patch }), /artifacts do not match/);
  }
});
test('absent, partial and completed setup are distinguished by exact deployed code', async () => {
  const { state, clients } = fixture();
  for (const step of plan) delete state.codes[step.address.toLowerCase()];
  assert.deepEqual((await inspectSharedSetup(clients, d, signal)).map(step => step.deployed), [false, false, false]);
  state.codes[plan[0]!.address.toLowerCase()] = plan[0]!.runtime;
  assert.deepEqual((await inspectSharedSetup(clients, d, signal)).map(step => step.deployed), [true, false, false]);
  for (const step of plan) state.codes[step.address.toLowerCase()] = step.runtime;
  assert((await inspectSharedSetup(clients, d, signal)).every(step => step.deployed));
});
for (const [label, mutate, message] of [
  ['wrong chain', s => { s.wrongChain = true; }, /Select/],
  ['wrong checkpoint', s => { s.wrongAnchor = true; }, /checkpoint/],
  ['reorg', s => { s.reorg = true; }, /block changed/],
  ['wrong rollup', s => { s.rollup = 4n; }, /routing/],
  ['gas-sensitive manager', s => { s.useGas = true; }, /routing/],
  ['missing deployer', s => { delete s.codes[matchingDeployer.toLowerCase()]; }, /deployer bytecode/],
  ['wrong singleton', s => { s.codes[d.l1.safe!.singleton.address.toLowerCase()] = '0x00'; }, /singleton bytecode/],
  ['missing handler', s => { delete s.codes[d.l1.safe!.fallbackHandler.address.toLowerCase()]; }, /handler bytecode/],
  ['missing registry', s => { delete s.codes[d.l1.registry.toLowerCase()]; }, /registry is absent/],
  ['occupied target', s => { s.codes[plan[0]!.address.toLowerCase()] = '0x00'; }, /incompatible bytecode/],
] as [string, (s: ReturnType<typeof fixture>['state']) => void, RegExp][]) test(`setup refuses ${label}`, async () => {
  const { state, clients } = fixture(); mutate(state);
  await assert.rejects(inspectSharedSetup(clients, d, signal), message);
});
test('setup recovery binds stored requests to exact initcode, chain and zero value', () => {
  assert.equal(setupAttemptContract(d, attempt).id, 'verifier');
  for (const patch of [{ chainId: 1 }, { to: zeroAddress }, { value: '1' }, { data: '0x' as Hex }, { publicKey: '0x1234' as Hex }]) {
    assert.throws(() => setupAttemptContract(d, { ...attempt, ...patch }), /does not match/);
  }
});
test('confirmation requires the matching transaction, canonical receipt and exact runtime', async () => {
  const { state, clients } = fixture();
  assert.equal(await confirmSharedSetup(clients.l2, d, attempt, hash, signal), 'deployed');
  state.tx.nonce = 2;
  await assert.rejects(confirmSharedSetup(clients.l2, d, attempt, hash, signal), /sender, nonce/);
  state.tx.nonce = 3; state.receipt.status = 'reverted';
  assert.equal(await confirmSharedSetup(clients.l2, d, attempt, hash, signal), 'reverted');
  state.receipt.status = 'invalid';
  await assert.rejects(confirmSharedSetup(clients.l2, d, attempt, hash, signal), /Unexpected shared deployment receipt/);
  state.receipt.status = 'success'; state.codes[plan[0]!.address.toLowerCase()] = '0x00';
  await assert.rejects(confirmSharedSetup(clients.l2, d, attempt, hash, signal), /bytecode/);
  state.codes[plan[0]!.address.toLowerCase()] = plan[0]!.runtime; state.reorg = true;
  await assert.rejects(confirmSharedSetup(clients.l2, d, attempt, hash, signal), /canonical/);
  state.reorg = false; state.tx.input = '0x';
  assert.equal(await confirmSharedSetup(clients.l2, d, attempt, hash, signal), 'replaced');
});
test('shared recovery survives reload, is scoped to gas wallet and retains late replies', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  const base = recoveryKey(d, 'infrastructure'), key = scopedRecoveryKey(base, attempt);
  const unsent = { ...attempt, hash: undefined };
  updateRecovery(storage, key, null, unsent);
  assert.deepEqual(readRecovery(storage.getItem(key)), JSON.parse(JSON.stringify(unsent)));
  assert.notEqual(key, scopedRecoveryKey(base, { ...attempt, account: zeroAddress }));
  assert.throws(() => updateRecovery(storage, key, null, unsent), /Another Falcon request/);
  recordWalletHash(storage, key, unsent, hash);
  assert.throws(() => resolveRecovery(storage, key, unsent, null), /Recovery changed/);
  resolveRecovery(storage, key, { ...unsent, hash }, null);
  assert.equal(recordWalletHash(storage, key, unsent, hash), null, 'late reply cannot recreate a resolved request');
  assert.equal(readRecovery(storage.getItem(key)), null);
});
test('a wallet hash waits for inclusion before querying a transaction the read RPC cannot see yet', async () => {
  const { state, clients } = fixture();
  let release!: () => void, started!: () => void, pending = true;
  const observing = new Promise<void>(resolve => { started = resolve; });
  const receipt = new Promise<void>(resolve => { release = resolve; });
  const delayed = { ...clients.l2,
    async getTransactionReceipt() { started(); await receipt; return state.receipt; },
    async getTransaction() { assert.equal(pending, false, 'do not query the unpropagated transaction'); return state.tx; },
  } as unknown as EezClient;
  const confirmed = confirmSharedSetup(delayed, d, attempt, hash, signal);
  await observing; pending = false; release();
  assert.equal(await confirmed, 'deployed');
});
