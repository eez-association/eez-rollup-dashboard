import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { keccak256, pad, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { crossChainDeployments, mainnetDeployment, type CrossChainDeployment } from '../../src/lib/falcon/crossChainDeployment.ts';
import type { EezClient } from '../../src/lib/falcon/eez.ts';
import { loadSafeAccount } from '../../src/lib/falcon/safeDiscovery.ts';
import { deploymentCode } from './deploymentCode.ts';

const testnet = JSON.parse(readFileSync(new URL('./fixtures/testnet-deployed-code.json', import.meta.url), 'utf8'));
const publicKey: Hex = '0x1234';
const controller: Address = '0x1111111111111111111111111111111111111111';
const owner: Address = '0x2222222222222222222222222222222222222222';
const safe: Address = '0x3333333333333333333333333333333333333333';
const sentinel: Address = '0x0000000000000000000000000000000000000001';
type Call = { chain: 'l1' | 'l2'; method: string; address?: Address; functionName?: string; blockNumber?: bigint };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(d = crossChainDeployments[0]) {
  const records = deploymentCode(d);
  const codes: Record<string, Hex> = Object.fromEntries(Object.values(records).map(item => {
    const { address, code } = item as { address: Address; code: Hex };
    return [address.toLowerCase(), code];
  }));
  codes[safe] = testnet.safeProxy.code;
  const state = {
    controller: controller as Address, safe: safe as Address, owners: [owner] as Address[],
    values: {} as Record<string, unknown>, codes,
    chains: { l1: d.l1.chainId, l2: d.l2.chainId },
    anchors: { l1: d.l1.anchor.blockHash, l2: d.l2.anchor.blockHash },
    before: async (_call: Call) => {},
  };
  const calls: Call[] = [];
  const blockNumbers = { l1: d.l1.anchor.blockNumber + 100n, l2: 100n };
  const client = (chain: 'l1' | 'l2') => {
    const run = async (method: string, args: Omit<Call, 'chain' | 'method'> = {}) => {
      const call = { chain, method, ...args }; calls.push(call); await state.before(call);
    };
    return {
      async getChainId() { await run('getChainId'); return state.chains[chain]; },
      async getBlock(args: { blockNumber?: bigint } = {}) {
        await run('getBlock', args);
        return { number: args.blockNumber ?? blockNumbers[chain], timestamp: 123n,
          hash: args.blockNumber === d[chain].anchor.blockNumber ? state.anchors[chain] : zeroHash };
      },
      async getBlockNumber() { await run('getBlockNumber'); return blockNumbers[chain]; },
      async getCode(args: { address: Address; blockNumber: bigint }) { await run('getCode', args); return state.codes[args.address.toLowerCase()] ?? '0x'; },
      async getBalance(args: { address: Address; blockNumber: bigint }) { await run('getBalance', args); return 99n; },
      async getStorageAt(args: { address: Address; slot: Hex; blockNumber: bigint }) {
        await run('getStorageAt', args);
        return args.slot.startsWith('0x4a204f') ? zeroHash : pad(d.l1.safe!.fallbackHandler.address, { size: 32 });
      },
      async readContract(args: { address: Address; functionName: string; blockNumber: bigint }) {
        await run('readContract', args);
        const values: Record<string, unknown> = {
          verifier: d.l2.verifier.address, eezL2: d.l2.manager, l1ChainId: BigInt(d.l1.chainId),
          ROLLUP_ID: d.l2.rollupId, USE_GAS_LEFT: false, controllers: state.controller,
          publicKeyHash: keccak256(publicKey), nonce: chain === 'l1' ? 7n : 3n,
          singleton: d.l1.safe!.singleton.address, fallbackHandler: d.l1.safe!.fallbackHandler.address,
          computeCrossChainProxyAddress: owner, safes: state.safe, masterCopy: d.l1.safe!.singleton.address,
          VERSION: d.l1.safe!.version, getOwners: state.owners, getThreshold: 1n,
          getModulesPaginated: [[], sentinel], authorizedProxies: [true, controller, d.l2.rollupId],
        };
        const key = `${chain}.${args.functionName}`;
        const result = key in state.values ? state.values[key] : values[args.functionName];
        assert.notEqual(result, undefined, `unexpected read ${key}`);
        return result;
      },
    } as unknown as EezClient;
  };
  const l1 = client('l1'), l2 = client('l2');
  const load = (signal = new AbortController().signal) => loadSafeAccount(l2, l1, d, publicKey, signal);
  return { state, calls, load, blockNumbers };
}

for (const d of crossChainDeployments) test(`discover a fully checked Safe on ${d.l2.chainId} with one source snapshot`, async () => {
  const f = fixture(d);
  assert.deepEqual(await f.load(), {
    controller: { controller, nonce: 3n, timestamp: 123n },
    remote: { owner, target: safe, nonce: 7n, balance: 99n },
  });
  assert.equal(f.calls.filter(c => c.chain === 'l2' && c.method === 'getBlock' && c.blockNumber === undefined).length, 1);
  assert.equal(f.calls.filter(c => c.chain === 'l2' && c.method === 'getBlockNumber').length, 0);
  assert(f.calls.length <= 37, `discovery grew to ${f.calls.length} RPCs`);
  for (const call of f.calls.filter(c => c.address)) assert.equal(call.blockNumber, f.blockNumbers[call.chain]);
});

for (const held of ['deployment', 'authority']) test(`L1 lookup overlaps ${held} checks but cannot bypass them`, async () => {
  const f = fixture(), gate = deferred(), balanceRead = deferred();
  f.state.before = async call => {
    if (held === 'deployment' && call.chain === 'l2' && call.method === 'getCode') await gate.promise;
    if (held === 'authority' && call.chain === 'l2' && call.functionName === 'publicKeyHash') await gate.promise;
    if (call.chain === 'l1' && call.method === 'getBalance') balanceRead.resolve();
  };
  let completed = false;
  const result = f.load().then(value => { completed = true; return value; });
  try {
    await balanceRead.promise;
    assert.equal(completed, false, 'independent reads may finish without publishing an account');
  } finally { gate.resolve(); }
  assert.equal((await result).remote?.target, safe);
});

test('no controller skips L1 reads; no Safe still returns its checked controller and owner', async () => {
  const absentController = fixture(); absentController.state.controller = zeroAddress;
  assert.deepEqual(await absentController.load(), { controller: null, remote: null });
  assert(!absentController.calls.some(c => c.chain === 'l1'));
  const absentSafe = fixture(); absentSafe.state.safe = zeroAddress;
  assert.deepEqual((await absentSafe.load()).remote, { owner, target: null, nonce: null, balance: null });
});

test('mainnet discovery offers Safe choices without the optional creation factory or its dependencies', async () => {
  const d = mainnetDeployment, f = fixture(d);
  for (const binding of [d.l1.safe!.factory, d.l1.safe!.singleton, d.l1.safe!.fallbackHandler]) {
    delete f.state.codes[binding.address.toLowerCase()];
  }
  assert.deepEqual(await f.load(), {
    controller: { controller, nonce: 3n, timestamp: 123n },
    remote: { owner, target: null, nonce: null, balance: null, factoryMissing: true },
  });
  assert(!f.calls.some(c => ['singleton', 'fallbackHandler', 'safes'].includes(c.functionName ?? '')));
  assert(!f.calls.some(c => [d.l1.safe!.singleton.address, d.l1.safe!.fallbackHandler.address].some(a => a.toLowerCase() === c.address?.toLowerCase())));
});

test('mainnet discovery still rejects conflicting factory bytecode', async () => {
  const d = mainnetDeployment, f = fixture(d);
  f.state.codes[d.l1.safe!.factory.address.toLowerCase()] = '0x6000';
  await assert.rejects(f.load(), /Safe factory bytecode/);
});

for (const d of crossChainDeployments.filter(d => !d.walletSetup)) test(`missing predeployed Safe factory still fails on ${d.l2.chainId}`, async () => {
  const f = fixture(d);
  delete f.state.codes[d.l1.safe!.factory.address.toLowerCase()];
  await assert.rejects(f.load(), /Safe factory bytecode/);
});

type Mutation = (f: ReturnType<typeof fixture>, d: CrossChainDeployment) => void;
const invalid: [string, Mutation, RegExp][] = [
  ['L2 chain', f => { f.state.chains.l2 = 1; }, /Select/],
  ['L1 checkpoint', f => { f.state.anchors.l1 = zeroHash; }, /checkpoint/],
  ['verifier code', (f, d) => { f.state.codes[d.l2.verifier.address.toLowerCase()] = '0x6000'; }, /Falcon verifier bytecode/],
  ['controller factory', (f, d) => { f.state.codes[d.l2.factory.address.toLowerCase()] = '0x6000'; }, /controller factory bytecode/],
  ['routing', f => { f.state.values['l2.ROLLUP_ID'] = 99n; }, /routing/],
  ['key binding', f => { f.state.values['l2.publicKeyHash'] = zeroHash; }, /authority/],
  ['Safe factory', (f, d) => { f.state.codes[d.l1.safe!.factory.address.toLowerCase()] = '0x6000'; }, /Safe factory bytecode/],
  ['Safe singleton', f => { f.state.values['l1.masterCopy'] = zeroAddress; }, /authority or configuration/],
  ['owner proxy', f => { f.state.values['l1.authorizedProxies'] = [true, zeroAddress, 4n]; }, /authority or configuration/],
  ['Safe owners', f => { f.state.owners = [controller]; }, /authority or configuration/],
];
for (const [name, mutate, error] of invalid) test(`parallel discovery rejects an invalid ${name}`, async () => {
  const d = crossChainDeployments[0], f = fixture(d); mutate(f, d);
  await assert.rejects(f.load(), error);
});

test('a missing controller cannot bypass failed deployment checks', async () => {
  const f = fixture(); f.state.controller = zeroAddress; f.state.values['l2.USE_GAS_LEFT'] = true;
  await assert.rejects(f.load(), /routing/);
});

test('another lookup checks current authority instead of reusing a successful inspection', async () => {
  const f = fixture(); await f.load(); f.state.owners = [controller];
  await assert.rejects(f.load(), /authority or configuration/);
});

test('cancellation refuses a late discovery result and a pre-aborted lookup makes no reads', async () => {
  const f = fixture(), gate = deferred(), reached = deferred(), abort = new AbortController();
  f.state.before = async call => {
    if (call.functionName === 'publicKeyHash') { reached.resolve(); await gate.promise; }
  };
  const result = f.load(abort.signal);
  const rejected = assert.rejects(result, /key changed/);
  await reached.promise; abort.abort(new Error('key changed')); gate.resolve();
  await rejected;
  const other = fixture(); await assert.rejects(other.load(abort.signal), /key changed/);
  assert.equal(other.calls.length, 0);
});
