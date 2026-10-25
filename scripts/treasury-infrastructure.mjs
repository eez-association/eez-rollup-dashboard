// One-time Chiado/EEZ-X infrastructure deployment. Never reads operator .env files.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getAddress, isAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TreasuryNetworkDeployment, readNetworkDeployment } from '../src/lib/treasury/networkDeployment.ts';
const { values } = parseArgs({ options: {
  dashboard: { type: 'string', default: 'http://127.0.0.1:8080' },
  address: { type: 'string' }, 'key-file': { type: 'string' }, broadcast: { type: 'boolean', default: false },
  state: { type: 'string', default: '.runtime/treasury-network-predeployment/state.json' },
} });
const base = new URL(values.dashboard);
assert(!base.username && !base.password && !base.search && !base.hash && (base.protocol === 'https:' || base.protocol === 'http:' && base.hostname === '127.0.0.1'), 'Use HTTPS or loopback HTTP');
let account;
if (values['key-file']) {
  const path = resolve(values['key-file']), info = statSync(path);
  assert(info.isFile() && (info.mode & 0o077) === 0 && info.size <= 128, 'Use a private key file readable only by its owner (chmod 600)');
  const key = readFileSync(path, 'utf8').trim();
  assert(/^0x[\da-fA-F]{64}$/.test(key), 'Key file must contain one 0x-prefixed private key');
  account = privateKeyToAccount(key);
}
assert(account || values.address && isAddress(values.address), 'Supply --address for read-only preparation, or --key-file for signing');
if (values.broadcast) assert(account, '--broadcast requires --key-file');
const owner = account?.address ?? getAddress(values.address);
assert(!values.address || getAddress(values.address) === owner, 'Key and requested deployment address differ');
const response = await fetch(new URL('/dashboard/config.json', base), { signal: AbortSignal.timeout(12_000) });
assert(response.ok, 'Dashboard configuration unavailable');
const payload = await response.json(), config = payload.browser ?? payload;
const endpoint = path => { const url = new URL(path, base); assert(url.origin === base.origin && !url.username && !url.password && !url.search && !url.hash, 'Use the dashboard RPC proxies'); return url.href; };
const target = Object.fromEntries(['l1', 'l2'].map(chain => [chain, { rpc: endpoint(config[`${chain}RpcUrl`]), front: endpoint(config[`${chain}FrontUrl`]) }]));
target.fees = { l1: config.l1FeeMaxTotalWei, l2: config.l2FeeMaxTotalWei };
assert(config.l1FeesEnabled && config.l2FeesEnabled, 'Both network fee settings must be enabled');
const savedBuild = existsSync(values.state) ? JSON.parse(readFileSync(values.state)).build : JSON.parse(readFileSync('src/lib/treasury/shared-build.json')).build;
const legacy = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const release = savedBuild ? JSON.parse(readFileSync(`src/lib/treasury/builds/${savedBuild}.json`)) : legacy;
const artifacts = { ...release, contracts: { ...legacy.contracts, ...release.contracts } };
const d = new TreasuryNetworkDeployment(target, artifacts);
await d.validate();
const balances = Object.fromEntries(await Promise.all(['l1', 'l2'].map(async chain => [chain, String(BigInt(await d.rpc(chain, 'eth_getBalance', [owner, 'latest'])))])));
console.log(JSON.stringify({ deployer: owner, gasBalancesWei: balances, broadcast: values.broadcast }));
const path = resolve(values.state);
let state = existsSync(path) ? readNetworkDeployment(readFileSync(path, 'utf8')) : null;
if (state) assert(state.deployer === owner, 'This journal belongs to a different dedicated deployment account');
const existing = await d.findSharedInfrastructure();
if (existing && !state) { console.log(JSON.stringify({ ready: true, reused: true, infrastructure: existing }, null, 2)); process.exit(0); }
if (!values.broadcast) {
  const plan = state ?? await d.start(owner);
  console.log(JSON.stringify({ ready: !!existing, confirmed: plan.completed.length, pending: plan.pending?.hash,
    remaining: d.steps(plan).slice(plan.completed.length).map(step => ({ chain: step.chain, label: step.label, actions: step.group.actions.map(action => action.label) })) }, null, 2));
  process.exit(0);
}
assert(Object.values(balances).every(value => BigInt(value) > 0n), 'Fund the dedicated deployer with test xDAI on both chains');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const lock = path + '.lock';
const descriptor = openSync(lock, 'wx', 0o600); writeFileSync(descriptor, String(process.pid)); closeSync(descriptor);
const save = next => { const temp = path + `.tmp-${process.pid}`; writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, path); state = next; };
async function deliverVerification() {
  for (const request of state.sourceRequests ?? []) {
    const response = await fetch(new URL('/treasury-verification/jobs', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(10000) });
    assert(response.ok, 'Verification delivery failed. The confirmed transaction and request are saved; rerun to retry without deploying again.');
  }
}
try {
  // Re-read under the single-process lock before authorizing any transaction.
  state = existsSync(path) ? readNetworkDeployment(readFileSync(path, 'utf8')) : await d.start(owner);
  assert(state.deployer === owner); save(state); await deliverVerification();
  const started = Date.now(); let reported = 0;
  while (state.completed.length < d.steps(state).length) {
    if (Date.now() - started > 15 * 60_000) throw new Error('Confirmation timeout. The journal is saved; rerun the same command to track it.');
    if (state.pending) {
      const tracked = await d.trackPending(state); if (tracked !== state) save(tracked);
      const next = state.pending.hash ? await d.reconcile(state) : state;
      if (next !== state) { save(next); await deliverVerification(); console.log(`Confirmed ${state.completed.length} / ${d.steps(state).length}`); continue; }
      if (Date.now() - reported > 15_000) { console.log(`Waiting for canonical confirmation: ${state.pending.hash ?? state.pending.id}`); reported = Date.now(); }
      await new Promise(resolve => setTimeout(resolve, 4000)); continue;
    }
    const step = d.steps(state)[state.completed.length];
    const provider = { request: ({ method, params = [] }) => method === 'eth_accounts' ? Promise.resolve([owner]) : d.rpc(step.chain, method, params, true) };
    const prepared = await d.prepare(state, provider), tx = prepared.request;
    if (prepared.expiresAt) assert(BigInt(prepared.expiresAt) * 1000n > BigInt(Date.now()), 'Fee quote expired; retry preparation');
    const common = { chainId: Number(BigInt(tx.chainId)), nonce: Number(BigInt(tx.nonce)), gas: BigInt(tx.gas), to: tx.to, data: tx.data, value: BigInt(tx.value) };
    const price = tx.gasPrice ? BigInt(tx.gasPrice) : tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : BigInt(await d.rpc(step.chain, 'eth_gasPrice', [], true));
    assert(common.gas * price + common.value <= BigInt(target.fees[step.chain]), 'Transaction exceeds the configured wallet fee cap');
    const signed = await account.signTransaction(tx.maxFeePerGas && !tx.gasPrice ? { ...common, type: 'eip1559', maxFeePerGas: price, maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas ?? '0x0') } : { ...common, type: 'legacy', gasPrice: price });
    const hash = keccak256(signed);
    save({ ...state, pending: { ...prepared.pending, hash } });
    console.log(`Submitting ${step.label}: ${hash}`);
    // Preserve the expected hash before broadcast; an uncertain response never
    // authorizes another nonce or a second deployment.
    assert.equal(await d.rpc(step.chain, 'eth_sendRawTransaction', [signed], true), hash);
  }
  const binding = await d.binding(state);
  writeFileSync(path + '.binding.json', JSON.stringify(binding, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, infrastructure: binding }, null, 2));
} finally { unlinkSync(lock); }
