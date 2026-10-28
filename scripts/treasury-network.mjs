// Read-only target inspection before any shared-network treasury deployment.
// Uses the dashboard's own public proxy paths; never loads operator keys or .env.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decodeFunctionResult, encodeFunctionData, formatEther, getAddress, isAddress, keccak256, parseAbi, toHex } from 'viem';
import { probeComposer } from '../src/lib/composerDiscovery.ts';
import profile from '../src/lib/treasury/paired-testnet-network.json' with { type: 'json' };
const { values } = parseArgs({ options: { dashboard: { type: 'string', default: 'http://127.0.0.1:8080' }, owner: { type: 'string' }, output: { type: 'string' } } });
assert(values.owner && isAddress(values.owner) && BigInt(values.owner) > 1n, '--owner must be the initial owner public address');
const owner = getAddress(values.owner), base = new URL(values.dashboard);
assert(!base.username && !base.password && !base.search && !base.hash && (base.protocol === 'https:' || base.protocol === 'http:' && base.hostname === '127.0.0.1'), 'Use a public HTTPS dashboard or loopback HTTP URL');
const response = await fetch(new URL('/dashboard/config.json', base), { signal: AbortSignal.timeout(12_000) });
assert(response.ok, 'Dashboard configuration unavailable');
const payload = await response.json(), config = payload.browser ?? payload;
const endpoint = value => {
  const url = new URL(value, base);
  assert(url.origin === base.origin && !url.username && !url.password && !url.search && !url.hash, 'Expected the dashboard’s own RPC proxies');
  return url.href;
};
const rpc = async (url, method, params = []) => {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000) });
  assert(response.ok, `RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
};
const registry = getAddress(config.l1ContractAddress), manager = getAddress(config.l2ContractAddress);
const abi = parseAbi(['function ROLLUP_ID() view returns (uint64)', 'function MAINNET_ROLLUP_ID() view returns (uint64)']);
const report = { version: 1, checkedAt: new Date().toISOString(), environment: 'dashboard-testnet',
  initialOwners: [owner], initialThreshold: 1, addOwner: 'Use the connected wallet as B; current L1 owners approve the change',
  registry, manager, rollupId: config.rollupId, networks: {}, fees: {}, checks: [], blockers: [], deploymentVerified: false };
assert.equal(registry.toLowerCase(), profile.registry.toLowerCase(), 'Dashboard registry differs from the reviewed testnet profile');
assert.equal(manager.toLowerCase(), profile.manager.toLowerCase(), 'Dashboard manager differs from the reviewed testnet profile');
assert.equal(BigInt(config.rollupId), BigInt(profile.rollupId), 'Dashboard rollup differs from the reviewed testnet profile');
const expected = { l1ChainId: toHex(profile.chains.l1.chainId), l2ChainId: toHex(profile.chains.l2.chainId), registryAddress: registry, l2Address: manager };
const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
for (const [chain, id, address] of [['l1', profile.chains.l1.chainId, registry], ['l2', profile.chains.l2.chainId, manager]]) {
  const url = endpoint(config[`${chain}RpcUrl`]), front = endpoint(config[`${chain}FrontUrl`]);
  assert.equal(BigInt(await rpc(url, 'eth_chainId')), BigInt(id), 'Unexpected dashboard chain');
  const observed = await rpc(url, 'eth_getBlockByNumber', [chain === 'l1' ? 'finalized' : '0x0', false]);
  assert(observed?.hash && observed?.number, 'Chain reference unavailable');
  const proxyCode = await rpc(url, 'eth_getCode', [address, 'latest']);
  assert(proxyCode !== '0x', 'Missing protocol proxy');
  const implementation = getAddress('0x' + (await rpc(url, 'eth_getStorageAt', [address, implSlot, 'latest'])).slice(-40));
  const implementationCode = await rpc(url, 'eth_getCode', [implementation, 'latest']);
  assert(implementationCode !== '0x', 'Missing protocol implementation');
  const functionName = chain === 'l1' ? 'MAINNET_ROLLUP_ID' : 'ROLLUP_ID';
  const data = encodeFunctionData({ abi, functionName });
  const rollup = decodeFunctionResult({ abi, functionName, data: await rpc(url, 'eth_call', [{ to: address, data }, 'latest']) });
  assert.equal(rollup, chain === 'l1' ? 0n : BigInt(config.rollupId), 'Manager rollup identity mismatch');
  const discovery = await probeComposer({ request: ({ method, params }) => rpc(front, method, params ?? []) }, expected);
  assert.equal(discovery.status, 'detected', discovery.detail);
  const balance = await rpc(url, 'eth_getBalance', [owner, 'latest']);
  const code = await rpc(url, 'eth_getCode', [owner, 'latest']);
  assert.equal(code, '0x', 'This signing flow requires an EOA owner');
  report.networks[chain] = { chainId: id, rpc: url, front, checkpoint: { number: observed.number, hash: observed.hash },
    protocol: { proxy: address, proxyCodeHash: keccak256(proxyCode), implementation, implementationCodeHash: keccak256(implementationCode) },
    ownerGasBalanceWei: String(BigInt(balance)), ownerGasBalance: formatEther(BigInt(balance)) };
  assert.equal(config[`${chain}FeesEnabled`], true, 'Expected shared-network fee quoting');
  assert(/^[1-9]\d*$/.test(config[`${chain}FeeMaxTotalWei`]), 'Missing wallet fee reservation limit');
  report.fees[chain] = { enabled: true, maxTotalWei: config[`${chain}FeeMaxTotalWei`] };
  report.checks.push(`${chain}: chain reference, manager, implementation code and wallet-compatible Composer discovery`);
  if (BigInt(balance) === 0n) report.blockers.push(`Initial owner needs test gas on ${chain === 'l1' ? 'Chiado' : 'EEZ-X'}`);
}
report.blockers.push('No treasury application deployment manifest was supplied or verified');
report.scope = 'Read-only configuration and code observations; no payment, proof, replay or wallet-extension validation';
const text = JSON.stringify(report, null, 2) + '\n';
if (values.output) writeFileSync(values.output, text, { flag: 'wx', mode: 0o600 });
console.log(text);
