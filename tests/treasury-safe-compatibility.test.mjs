import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex } from 'viem';
import { matchesRuntime } from '../src/lib/treasury/runtimeCode.ts';
import { inspectSafe } from '../src/lib/treasury/safeSetup.ts';
import { decodeSafeExecution, safeExecutionTopics } from '../src/lib/treasury/safeEvents.ts';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/safe-130-runtime.json', import.meta.url)));
const safe150 = JSON.parse(readFileSync(new URL('../contracts/test/fixtures/safe-150.json', import.meta.url)));
const artifacts = JSON.parse(readFileSync(new URL('../src/lib/treasury/deployment-artifacts.json', import.meta.url)));
const address = n => getAddress(toHex(n, { size: 20 }));
const safe = address(100), singleton = address(101), owner = address(102);
const txHash = keccak256(toHex('reviewed Safe transaction'));

function inspection(contract, version = '1.3.0', proxy = artifacts.contracts.SafeProxy.runtime) {
  return {
    artifacts,
    runtimeMatches(code, name) { assert.equal(code, '0x'); assert.equal(name, 'L1Owners'); return false; },
    async rpc(_chain, method, params) {
      if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: txHash };
      if (method === 'eth_getStorageAt') return toHex(params[1] === '0x0' ? BigInt(singleton) : 0n, { size: 32 });
      assert.equal(method, 'eth_getCode');
      return params[0] === safe ? proxy : params[0] === singleton ? contract.runtime : '0x';
    },
    async read(_chain, _address, _artifact, method) {
      return { VERSION: version, getOwners: [owner], getThreshold: 1n, nonce: 12n, getModulesPaginated: [[], address(1)] }[method];
    },
  };
}

for (const [name, contract] of Object.entries(fixtures.contracts)) {
  test(`${name} imports the official runtime on either chain and rejects changed code or false version reports`, async () => {
    assert.equal(keccak256(contract.runtime), contract.codeHash);
    for (const chain of ['l1', 'l2']) {
      const imported = await inspectSafe(inspection(contract), chain, safe);
      assert.equal(imported.singletonHash, contract.codeHash);
      assert.deepEqual(imported.owners, [owner]); assert.equal(imported.threshold, 1); assert.equal(imported.nonce, '12');
      await assert.rejects(inspectSafe(inspection(contract, '1.4.1'), chain, safe), /version does not match/);
      await assert.rejects(inspectSafe(inspection(contract, '1.3.0+L2'), chain, safe), /version does not match/);
      await assert.rejects(inspectSafe(inspection({ ...contract, runtime: contract.runtime + '00' }), chain, safe), /Unsupported Safe implementation/);
    }
  });
}

for (const name of ['Safe', 'SafeL2']) {
  const contract = safe150.contracts[name], proxy = safe150.contracts.SafeProxy;
  test(`official 1.5.0 ${name} imports on L1 with its new proxy and preserves strict runtime checks`, async () => {
    assert.equal(keccak256(contract.runtime), contract.codeHash);
    assert.equal(keccak256(proxy.runtime), proxy.codeHash);
    const d = inspection(contract, '1.5.0', proxy.runtime);
    const imported = await inspectSafe(d, 'l1', safe);
    assert.equal(imported.singletonHash, contract.codeHash);
    assert.equal(imported.proxyHash, proxy.codeHash);
    assert.deepEqual(imported.owners, [owner]); assert.equal(imported.threshold, 1);
    // Supported singletons can also sit behind an older official proxy.
    await inspectSafe(inspection(contract, '1.5.0'), 'l1', safe);
    await assert.rejects(inspectSafe(inspection(contract, '1.4.1', proxy.runtime), 'l1', safe), /version does not match/);
    await assert.rejects(inspectSafe(inspection({ ...contract, runtime: contract.runtime + '00' }, '1.5.0', proxy.runtime), 'l1', safe), /Unsupported Safe implementation/);
    for (const changed of [proxy.runtime + '00', '0x00' + proxy.runtime.slice(4)]) {
      await assert.rejects(inspectSafe(inspection(contract, '1.5.0', changed), 'l1', safe), /not a supported Safe proxy/);
    }
    // A 1.5 mirror calls modern ERC-1271, which the current adapter does not implement.
    await assert.rejects(inspectSafe(d, 'l2', safe), /EEZ-X mirror.*1.3.0.*1.4.1/);
    const rpc = d.rpc;
    d.rpc = (chain, method, params) => method === 'eth_getStorageAt' && params[1] === '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947'
      ? toHex(BigInt(owner), { size: 32 }) : rpc(chain, method, params);
    await assert.rejects(inspectSafe(d, 'l1', safe), /module Guard/);
  });
}

test('Safe 1.5 state reads overlap its module Guard check but still reject that Guard', async () => {
  const d = inspection(safe150.contracts.Safe, '1.5.0', safe150.contracts.SafeProxy.runtime);
  let release, stateRead;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { stateRead = resolve; });
  const rpc = d.rpc, read = d.read;
  d.rpc = async (chain, method, params) => {
    if (method === 'eth_getStorageAt' && params[1] === '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947') {
      await gate;
      return toHex(BigInt(owner), { size: 32 });
    }
    return rpc(chain, method, params);
  };
  d.read = (...args) => { stateRead(); return read(...args); };
  let completed = false;
  const pending = inspectSafe(d, 'l1', safe).finally(() => { completed = true; });
  const rejected = assert.rejects(pending, /module Guard/);
  let timer;
  try {
    const overlapped = await Promise.race([reached.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
    assert(overlapped, 'Safe state reads must start while its module Guard check is pending');
    assert.equal(completed, false);
  } finally { clearTimeout(timer); release(); await rejected; }
});

for (const [version, abi] of [['1.3.0+L2', fixtures.contracts.Safe130L2.abi], ['1.4.1', artifacts.contracts.Safe.abi], ['1.5.0', safe150.contracts.Safe.abi], ['1.5.0+L2', safe150.contracts.SafeL2.abi]]) {
  for (const eventName of ['ExecutionSuccess', 'ExecutionFailure']) {
    test(`${version} ${eventName} requires its complete event layout`, () => {
      const topics = encodeEventTopics({ abi, eventName, args: { txHash } });
      const data = version !== '1.3.0+L2' ? encodeAbiParameters([{ type: 'uint256' }], [7n])
        : encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [txHash, 7n]);
      const event = decodeSafeExecution({ topics, data });
      assert.equal(event.eventName, eventName); assert.deepEqual(event.args, { txHash, payment: 7n });
      assert(safeExecutionTopics.includes(topics[0]));
      for (const log of [
        { topics: [], data }, { topics: [...topics, txHash], data },
        { topics: [txHash, ...topics.slice(1)], data }, { topics, data: data.slice(0, -2) },
        { topics, data: data + '00' }, { topics, data: data.slice(0, -2) + 'zz' },
        { topics: [topics[0], '0x01'], data },
      ]) assert.equal(decodeSafeExecution(log), undefined);
    });
  }
}


test('new releases can reuse a frozen owner adapter without accepting changed metadata or inconsistent immutables', async () => {
  const build = JSON.parse(readFileSync(new URL('../src/lib/treasury/current-build.json', import.meta.url))).build;
  const current = JSON.parse(readFileSync(new URL(`../src/lib/treasury/builds/${build}.json`, import.meta.url)));
  const merged = { ...current, contracts: { ...artifacts.contracts, ...current.contracts,
    LegacyL1Owners: artifacts.contracts.L1Owners } };
  const remoteSafe = address(103), manager = address(104), proxy = address(105);
  for (const adapter of [current.contracts.L1Owners, artifacts.contracts.L1Owners]) {
    let ownerCode = adapter.runtime;
    const d = inspection(current.contracts.Safe, '1.4.1');
    const rpc = d.rpc, read = d.read;
    d.artifacts = merged;
    d.runtimeMatches = (code, name) => matchesRuntime(code, merged.contracts[name]);
    d.rpc = async (chain, method, params) => method === 'eth_getCode' && params[0] === owner ? ownerCode
      : method === 'eth_getCode' && params[0] === proxy ? '0x6000' : rpc(chain, method, params);
    d.read = async (chain, target, artifact, method) => ({ safeL1: remoteSafe, manager, safeL1Proxy: proxy,
      computeCrossChainProxyAddress: proxy, authorizedProxies: [true, remoteSafe, 0n] }[method]
      ?? read(chain, target, artifact, method));
    assert.deepEqual((await inspectSafe(d, 'l2', safe)).adapter, { address: owner, safeL1: remoteSafe, manager });
    ownerCode = adapter.runtime.slice(0, -2) + (adapter.runtime.endsWith('ff') ? '00' : 'ff');
    await assert.rejects(inspectSafe(d, 'l2', safe), /contract-owner signatures/);
    const slot = adapter.immutableGroups.find(group => group.length > 1)[0];
    const start = 2 + slot.start * 2;
    ownerCode = adapter.runtime.slice(0, start) + 'ff'.repeat(slot.length) + adapter.runtime.slice(start + slot.length * 2);
    await assert.rejects(inspectSafe(d, 'l2', safe), /contract-owner signatures/);
  }
});
