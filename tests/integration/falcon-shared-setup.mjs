// Real CREATE2 and Falcon/Safe EVM execution on two private Anvil nodes.
// Only EEZ routing/dependencies are stubbed; this does not prove native settlement.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, encodeFunctionData, keccak256, toHex, zeroAddress } from 'viem';
import { falcon512padded } from '@noble/post-quantum/falcon.js';
import { mainnetDeployment } from '../../src/lib/falcon/crossChainDeployment.ts';
import { confirmSharedSetup, deploymentSetupPlan, inspectSharedSetup } from '../../src/lib/falcon/sharedSetup.ts';
import { matchingDeployer, matchingDeployerRuntime } from '../../src/lib/treasury/matchingSafes.ts';
import { l1ActionDigest, l1ControllerAbi, l1ControllerFactoryAbi } from '../../src/lib/falcon/l1Action.ts';
import { verifierAbi } from '../../src/lib/falcon/verifierAbi.ts';
import { safeFactoryAbi, safeAbi } from '../../src/lib/falcon/safe.ts';

mkdirSync('.runtime/falcon-shared-setup', { recursive: true });
const directory = mkdtempSync('.runtime/falcon-shared-setup/anvil-');
const nodes = [], clients = {}, signal = new AbortController().signal;
const d = { ...mainnetDeployment, l1: { ...mainnetDeployment.l1 }, l2: { ...mainnetDeployment.l2 } };
const plan = deploymentSetupPlan(d);
const snapshots = JSON.parse(readFileSync('tests/falcon/fixtures/deployed-code.json'));
const evidence = { scope: 'Isolated CREATE2/EVM; stubbed EEZ routing; no live broadcast or native settlement', deployments: [], checks: [] };
const rpc = (chain, method, params = []) => clients[chain].request({ method, params });
async function send(chain, from, to, data) {
  const gas = await clients[chain].estimateGas({ account: from, to, data });
  const hash = await rpc(chain, 'eth_sendTransaction', [{ from, to, data, gas: toHex(gas) }]);
  const receipt = await clients[chain].waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success'); return receipt;
}
try {
  for (const chain of ['l1', 'l2']) {
    const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const log = openSync(`${directory}/${chain}.log`, 'w');
    nodes.push(spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(d[chain].chainId), '--hardfork', 'prague', '--silent'], { stdio: ['ignore', log, log] }));
    closeSync(log);
    clients[chain] = createPublicClient({ cacheTime: 0, transport: http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 10000 }) });
    for (let i = 0; i < 100; i++) {
      try { assert.equal(await clients[chain].getChainId(), d[chain].chainId); break; }
      catch (error) { if (i === 99) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const anchor = await clients[chain].getBlock({ blockNumber: 0n });
    d[chain].anchor = { blockNumber: 0n, blockHash: anchor.hash };
    await rpc(chain, 'anvil_setCode', [matchingDeployer, matchingDeployerRuntime]);
    await rpc(chain, 'anvil_setCode', [chain === 'l1' ? d.l1.registry : d.l2.manager, '0x00']);
  }
  await rpc('l1', 'anvil_setCode', [d.l1.safe.singleton.address, snapshots.singleton.code]);
  await rpc('l1', 'anvil_setCode', [d.l1.safe.fallbackHandler.address, snapshots.fallbackHandler.code]);
  const readClients = { ...clients, l2: { ...clients.l2, readContract: args => args.address.toLowerCase() === d.l2.manager.toLowerCase()
    ? Promise.resolve(args.functionName === 'ROLLUP_ID' ? 2n : false) : clients.l2.readContract(args) } };
  assert.deepEqual((await inspectSharedSetup(readClients, d, signal)).map(s => s.deployed), [false, false, false]);
  for (const step of plan) {
    const [from] = await rpc(step.chain, 'eth_accounts');
    const nonce = await clients[step.chain].getTransactionCount({ address: from });
    const receipt = await send(step.chain, from, matchingDeployer, step.data);
    const attempt = { version: 1, id: step.id, kind: 'infrastructure', chainId: d[step.chain].chainId,
      account: from, to: matchingDeployer, nonce: String(nonce), value: '0', data: step.data, publicKey: '0x', hash: receipt.transactionHash };
    assert.equal(await confirmSharedSetup(clients[step.chain], d, attempt, receipt.transactionHash, signal), 'deployed');
    assert.equal(await clients[step.chain].getCode({ address: step.address }), step.runtime);
    evidence.deployments.push({ name: step.id, chain: d[step.chain].chainId, address: step.address, gas: String(receipt.gasUsed), runtimeCodeHash: step.runtimeCodeHash });
  }
  assert((await inspectSharedSetup(readClients, d, signal)).every(s => s.deployed));
  const [from] = await rpc('l2', 'eth_accounts');
  await assert.rejects(clients.l2.estimateGas({ account: from, to: matchingDeployer, data: plan[0].data }), /revert/);
  evidence.checks.push('absent, partial and complete infrastructure; duplicate CREATE2 rejected');

  const browser = JSON.parse(readFileSync('tests/falcon/fixtures/browser.json'));
  const sample = Object.fromEntries(Object.entries(browser).map(([k,v]) => [k, v.startsWith('0x') ? v : '0x'+v]));
  assert.equal(await clients.l2.readContract({ address: d.l2.verifier.address, abi: verifierAbi, functionName: 'verify', args: [sample.message, sample.signature, sample.publicKey] }), true);
  assert.equal(await clients.l2.readContract({ address: d.l2.verifier.address, abi: verifierAbi, functionName: 'verify', args: ['0x00', sample.signature, sample.publicKey] }), false);
  const keys = falcon512padded.keygen(), key = toHex(keys.publicKey), keyHash = keccak256(key);
  await send('l2', from, d.l2.factory.address, encodeFunctionData({ abi: l1ControllerFactoryAbi, functionName: 'createController', args: [keyHash] }));
  const controller = await clients.l2.readContract({ address: d.l2.factory.address, abi: l1ControllerFactoryAbi, functionName: 'controllers', args: [keyHash] });
  const readController = (functionName, args = []) => clients.l2.readContract({ address: controller, abi: l1ControllerAbi, functionName, args });
  assert.equal(await readController('l1ChainId'), 1n);
  assert.equal(await readController('publicKeyHash'), keyHash);
  const action = { sourceChainId: BigInt(d.l2.chainId), destinationChainId: 1n, controller, eezL2: d.l2.manager,
    target: d.l1.safe.factory.address, data: encodeFunctionData({ abi: safeFactoryAbi, functionName: 'createSafe' }), nonce: 0n,
    deadline: (await clients.l2.getBlock()).timestamp + 3600n };
  const sign = value => toHex(falcon512padded.sign(Buffer.from(l1ActionDigest(value).slice(2), 'hex'), keys.secretKey));
  const args = [action.target, action.data, action.nonce, action.deadline];
  assert.equal(await readController('checkAuthorization', [...args, sign(action), key]), l1ActionDigest(action));
  await assert.rejects(readController('checkAuthorization', [...args, sign({ ...action, destinationChainId: 10200n }), key]), /InvalidSignature/);
  await assert.rejects(readController('checkAuthorization', [action.target, action.data, 1n, action.deadline, sign(action), key]), /InvalidNonce/);
  keys.secretKey.fill(0);
  evidence.checks.push('frozen browser signature accepted; mutated message rejected; fresh Falcon authorization bound to Ethereum chain 1 and nonce');

  const owner = toHex(987654n, { size: 20 }); // Represents the authenticated L1 proxy in this isolated contract test.
  await rpc('l1', 'anvil_impersonateAccount', [owner]); await rpc('l1', 'anvil_setBalance', [owner, toHex(10n ** 18n)]);
  await send('l1', owner, d.l1.safe.factory.address, action.data);
  const safe = await clients.l1.readContract({ address: d.l1.safe.factory.address, abi: safeFactoryAbi, functionName: 'safes', args: [owner] });
  assert.notEqual(safe, zeroAddress);
  assert.deepEqual(await clients.l1.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }), [owner]);
  assert.equal(await clients.l1.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }), 1n);
  assert.equal(keccak256(await clients.l1.getCode({ address: safe })), d.l1.safe.proxyRuntimeCodeHash);
  evidence.checks.push('Safe initialized atomically for caller, threshold 1, expected proxy runtime');
  console.log('Falcon shared CREATE2 deployments, real signature verification, mainnet authorization domain and Safe creation passed.');
} finally {
  writeFileSync(`${directory}/evidence.json`, JSON.stringify(evidence, null, 2)+'\n');
  for (const node of nodes) node.kill('SIGTERM');
}
