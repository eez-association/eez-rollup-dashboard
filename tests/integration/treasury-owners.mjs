// Invoked only by the owned native harness. No deployed dashboard/operator inputs.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { concatHex, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSafeTransaction, packOwnerApprovals, encodeSafeExecution, safeTransactionHash } from '../../src/lib/treasury/safeTransactions.ts';

export async function runFixture(networkFile, evidenceFile, { setupOnly = false } = {}) {
assert(networkFile && evidenceFile, 'native harness arguments required');
const network = JSON.parse(readFileSync(networkFile));
assert.equal(network.fixture, 'eez-testkit native process devnet');
const safeVersion = process.env.EEZ_TEST_SAFE_VERSION || '1.4.1';
assert(['1.3.0', '1.4.1'].includes(safeVersion));
const evidence = { verified: false, safeVersion, network, cases: [], deployments: {}, lastSuccessfulL2Block: 0 };
const checkpoint = () => writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
const artifact = (folder, contract) => JSON.parse(readFileSync(resolve('contracts', folder, `${contract}.sol/${contract}.json`)));
const safe130 = JSON.parse(readFileSync('tests/fixtures/safe-130-runtime.json')).contracts.Safe130L2;
assert.equal(keccak256(safe130.runtime), safe130.codeHash);
const safeArtifact = safeVersion === '1.3.0'
  ? { abi: safe130.abi, bytecode: { object: safe130.bytecode } } : artifact('legacy/out', 'Safe');
const factoryArtifact = artifact('legacy/out', 'SafeProxyFactory');
const adapterArtifact = artifact('out', 'L1Owners');
const actionArtifact = artifact('out', 'TreasuryOwnerAction');
const eeZAbi = artifact('out', 'EEZL2').abi;
// Public fixture keys. Owner approvals are distinct from transaction submission and attestation.
const [A, B, C] = [0xa11cen, 0xb0bn, 0xc0cn].map(key => privateKeyToAccount(toHex(key, { size: 32 })));
const submitter = privateKeyToAccount('0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e');
let id = 0;
async function rpc(url, method, params = []) {
  const endpoint = new URL(url);
  assert.equal(endpoint.hostname, '127.0.0.1', 'owned loopback devnet only');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
  assert(response.ok, `${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) { const error = new Error(`${method}: ${JSON.stringify(body.error)}`); error.rpcError = body.error; throw error; }
  return body.result;
}
async function until(label, check, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out: ${label}`);
}
async function read(url, address, abi, functionName, args = [], tag = 'latest') {
  const result = await rpc(url, 'eth_call', [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, tag]);
  return decodeFunctionResult({ abi, functionName, data: result });
}
async function submit(chain, to, data, value = 0n, sender = submitter) {
  const nonce = Number(BigInt(await rpc(chain.rpc, 'eth_getTransactionCount', [sender.address, 'pending'])));
  const block = await rpc(chain.rpc, 'eth_getBlockByNumber', ['latest', false]);
  const raw = await sender.signTransaction({ chainId: chain.chainId, nonce, to, data, value,
    gas: 8_000_000n, type: 'eip1559', maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 2n * BigInt(block.baseFeePerGas) + 1_000_000_000n });
  const hash = await rpc(chain.front, 'eth_sendRawTransaction', [raw]);
  console.log(`Submitted ${chain === network.l1 ? 'L1' : 'L2'} ${hash}`);
  return hash;
}
async function send(chain, to, data, value = 0n) {
  const hash = await submit(chain, to, data, value);
  const receipt = await until(`receipt ${hash}`, () => rpc(chain.rpc, 'eth_getTransactionReceipt', [hash]));
  assert.equal(receipt.status, '0x1', `transaction reverted: ${hash}`);
  return receipt;
}
async function deploy(chain, contract, args = []) {
  const constructor = contract.abi.find(item => item.type === 'constructor');
  const data = contract.bytecode.object + (constructor?.inputs.length ? encodeAbiParameters(constructor.inputs, args).slice(2) : '');
  const receipt = await send(chain, undefined, data);
  assert(receipt.contractAddress);
  const code = await rpc(chain.rpc, 'eth_getCode', [receipt.contractAddress, 'latest']);
  assert.notEqual(code, '0x');
  evidence.deployments[`${chain === network.l1 ? 'l1' : 'l2'}:${receipt.contractAddress}`] = { transaction: receipt.transactionHash, codeHash: keccak256(code) };
  checkpoint();
  return receipt.contractAddress;
}
async function createSafe(chain, singleton, factory, owners, threshold, salt) {
  const initializer = encodeFunctionData({ abi: safeArtifact.abi, functionName: 'setup', args: [owners, threshold, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] });
  const receipt = await send(chain, factory, encodeFunctionData({ abi: factoryArtifact.abi, functionName: 'createProxyWithNonce', args: [singleton, initializer, salt] }));
  const event = receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase()).map(log => decodeEventLog({ abi: factoryArtifact.abi, ...log })).find(event => event.eventName === 'ProxyCreation');
  assert(event, 'Safe proxy deployed by official factory');
  return event.args.proxy;
}
async function safeAdmin(safe, functionName, args) {
  const data = encodeFunctionData({ abi: safeArtifact.abi, functionName, args });
  const nonce = await read(network.l1.rpc, safe, safeArtifact.abi, 'nonce');
  const fields = [safe, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress];
  const hash = await read(network.l1.rpc, safe, safeArtifact.abi, 'getTransactionHash', [...fields, nonce]);
  const signatures = await Promise.all([A, B].sort((a, b) => BigInt(a.address) < BigInt(b.address) ? -1 : 1).map(owner => owner.sign({ hash })));
  return send(network.l1, safe, encodeFunctionData({ abi: safeArtifact.abi, functionName: 'execTransaction', args: [...fields, concatHex(signatures)] }));
}
let safeL1, safeL2, adapter, adapterAlias, action;
async function approval(signers, value) {
  const nonce = await read(network.l2.rpc, safeL2, safeArtifact.abi, 'nonce');
  const tx = buildSafeTransaction({ chainId: BigInt(network.l2.chainId), safe: safeL2, to: action,
    data: encodeFunctionData({ abi: actionArtifact.abi, functionName: 'setValue', args: [value] }), nonce });
  const approvals = await Promise.all(signers.map(async owner => ({ owner: owner.address, signature: await owner.signTypedData(tx) })));
  // Deliberately retain the old/anticipated snapshot for negative runtime checks:
  // the actual L1 Safe, rather than the frontend snapshot, must reject them.
  const signature = await packOwnerApprovals(tx, adapter, [A.address, B.address, C.address], 2, approvals);
  return { tx, calldata: encodeSafeExecution(tx, signature), hash: safeTransactionHash(tx), innerSignatures: `0x${signature.slice(196)}` };
}
async function reject(label, approved, expectedNonce, expectedValue) {
  // The public queue status exposes disposition, not revert bytes. Check the
  // precise Safe error separately, using the same preimage, sender and owners.
  // On replay Safe constructs the preimage using its current, incremented nonce.
  const t = approved.tx.message;
  const preimage = await read(network.l2.rpc, safeL2, safeArtifact.abi, 'encodeTransactionData',
    [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, expectedNonce]);
  let rejection;
  try {
    await rpc(network.l1.rpc, 'eth_call', [{ from: adapterAlias, to: safeL1,
      data: encodeFunctionData({ abi: safeArtifact.abi, functionName: 'checkSignatures',
        args: [keccak256(preimage), preimage, approved.innerSignatures] }) }, 'latest']);
  } catch (error) { rejection = error.rpcError; }
  assert(rejection, `${label}: L1 Safe must reject invalid owner signatures`);
  const text = JSON.stringify(rejection);
  assert(text.includes('GS026') || text.toLowerCase().includes(Buffer.from('GS026').toString('hex')), `unexpected rejection: ${text}`);
  const submitterNonce = await rpc(network.l2.rpc, 'eth_getTransactionCount', [submitter.address, 'latest']);
  const hash = await submit(network.l2, safeL2, approved.calldata);
  const status = await until(`${label}: terminal Composer disposition`, async () => {
    const status = await rpc(network.l2.rpc, 'eez_getCrossChainTransaction', [hash]);
    assert.equal(await rpc(network.l2.rpc, 'eth_getTransactionReceipt', [hash]), null, 'rejected source must not be included');
    return status?.lifecycle === 'terminal' ? status : false;
  });
  assert.equal(status.ownership.reason, 'PoolDiscarded', 'deterministic composition failure');
  // Existing opt-in diagnostics establish that this actual Composer simulation
  // reached and reverted inside the L1 Safe, rather than failing at an earlier hop.
  const traceFile = await until('completed Composer owner-verification trace', async () => {
    for (const name of readdirSync(network.traceDirectory)) {
      if (!name.startsWith(`${hash}-admission_execution-`)) continue;
      const rows = readFileSync(resolve(network.traceDirectory, name), 'utf8').trim().split('\n');
      if (!rows.at(-1)?.startsWith('{')) continue;
      let trace;
      try { trace = rows.map(row => JSON.parse(row)); } catch { continue; }
      if (trace.at(-1).kind !== 'end') continue;
      assert.equal(trace.at(-1).truncated, false);
      assert(trace.some(row => row.kind === 'step' && row.chain_id === network.l1.chainId &&
        row.address?.toLowerCase() === safeL1.toLowerCase() && row.op === 253), 'Composer must execute REVERT inside the L1 Safe');
      return name;
    }
  });
  assert.equal(await rpc(network.l2.rpc, 'eth_getTransactionCount', [submitter.address, 'latest']), submitterNonce);
  assert.equal(await read(network.l2.rpc, safeL2, safeArtifact.abi, 'nonce'), expectedNonce);
  assert.equal(await read(network.l2.rpc, action, actionArtifact.abi, 'value'), expectedValue);
  evidence.cases.push({ label, stage: 'composition rejection', transaction: hash,
    disposition: status.ownership.reason, l1SignatureError: rejection, compositionTrace: traceFile,
    safeNonce: String(expectedNonce), actionValue: String(expectedValue) });
  checkpoint();
  console.log(`${label}: Composer rejected; L1 Safe reverted; nonce and action unchanged`);
}
async function ownerVerificationOnL1(approved, fromBlock) {
  const selector = encodeFunctionData({ abi: safeArtifact.abi, functionName: 'checkSignatures', args: [approved.hash, '0x', '0x'] }).slice(0, 10);
  const logs = await rpc(network.l1.rpc, 'eth_getLogs', [{ address: network.registry, fromBlock, toBlock: 'latest',
    topics: [keccak256(new TextEncoder().encode('BatchPosted(bytes32,uint64[])'))] }]);
  function findCall(frame, staticContext = false) {
    if (frame.error) return undefined;
    staticContext ||= frame.type === 'STATICCALL';
    if (staticContext && frame.to?.toLowerCase() === safeL1.toLowerCase() &&
        frame.input?.toLowerCase().startsWith((selector + approved.hash.slice(2)).toLowerCase())) return frame;
    for (const child of frame.calls || []) {
      const found = findCall(child, staticContext);
      if (found) return found;
    }
  }
  for (const hash of new Set(logs.map(log => log.transactionHash))) {
    const trace = await rpc(network.l1.rpc, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
    const call = findCall(trace);
    if (call) {
      const receipt = await rpc(network.l1.rpc, 'eth_getTransactionReceipt', [hash]);
      assert.equal(receipt.status, '0x1');
      const canonical = await rpc(network.l1.rpc, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
      assert.equal(canonical.hash, receipt.blockHash);
      return { transaction: hash, blockNumber: Number(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash,
        callerAlias: call.from, safe: call.to, safeTransactionHash: approved.hash, calldataHash: keccak256(call.input) };
    }
  }
  throw new Error('No canonical L1 batch trace executed this exact Safe signature check');
}
async function settle(label, approved, expectedValue, expectedNonce) {
  const fromBlock = await rpc(network.l1.rpc, 'eth_blockNumber');
  let receipt = await send(network.l2, safeL2, approved.calldata);
  let height = Number(BigInt(receipt.blockNumber));
  await until(`canonical and independently replayed ${label}`, async () => {
    const current = await rpc(network.l2.rpc, 'eth_getTransactionReceipt', [receipt.transactionHash]);
    if (!current) return false;
    receipt = current;
    height = Number(BigInt(receipt.blockNumber));
    for (const url of [network.l2.rpc, network.follower]) {
      const safeBlock = await rpc(url, 'eth_getBlockByNumber', ['safe', false]);
      if (!safeBlock || BigInt(safeBlock.number) < BigInt(height)) return false;
      const block = await rpc(url, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
      if (block?.hash !== receipt.blockHash) return false;
      assert.equal(receipt.status, '0x1', 'canonical Safe transaction succeeded');
      assert.equal(await read(url, action, actionArtifact.abi, 'value', [], receipt.blockNumber), expectedValue);
      assert.equal((await read(url, action, actionArtifact.abi, 'lastCaller', [], receipt.blockNumber)).toLowerCase(), safeL2.toLowerCase());
      assert.equal(await read(url, safeL2, safeArtifact.abi, 'nonce', [], receipt.blockNumber), expectedNonce);
    }
    return true;
  });
  const l1Verification = await ownerVerificationOnL1(approved, fromBlock);
  evidence.lastSuccessfulL2Block = height;
  evidence.cases.push({ label, stage: 'settled and independently replayed', safeHash: approved.hash, transaction: receipt.transactionHash,
    blockNumber: height, blockHash: receipt.blockHash, l1Verification, actionValue: String(expectedValue), safeNonce: String(expectedNonce) });
  checkpoint();
  console.log(`${label}: canonical at L2 block ${height}; independent follower matches`);
}

try {
  for (const chain of [network.l1, network.l2]) {
    for (const url of [chain.rpc, chain.front]) assert.equal(Number(BigInt(await rpc(url, 'eth_chainId'))), chain.chainId);
    assert(BigInt(await rpc(chain.rpc, 'eth_getBalance', [submitter.address, 'latest'])) > 10n ** 18n, 'fixture submitter funded');
  }
  const info = await rpc(network.l2.front, 'eez_composerInfo');
  assert.equal(info.eezContracts.eezRegistryAddress.toLowerCase(), network.registry.toLowerCase());
  const manager = info.eezContracts.eezL2Address;
  assert.equal(Number(await read(network.l2.rpc, manager, eeZAbi, 'ROLLUP_ID')), network.rollupId);
  evidence.owners = { A: A.address, B: B.address, C: C.address, threshold: 2 };
  const singletonL1 = await deploy(network.l1, safeArtifact);
  const factoryL1 = await deploy(network.l1, factoryArtifact);
  safeL1 = await createSafe(network.l1, singletonL1, factoryL1, [A.address, B.address], 2n, 1n);
  await send(network.l2, manager, encodeFunctionData({ abi: eeZAbi, functionName: 'getOrCreateCrossChainProxy', args: [safeL1, 0n] }));
  adapter = await deploy(network.l2, adapterArtifact, [manager, safeL1]);
  // Static verification cannot deploy its L1 caller proxy during STATICCALL.
  await send(network.l1, network.registry, encodeFunctionData({ abi: eeZAbi, functionName: 'getOrCreateCrossChainProxy', args: [adapter, BigInt(network.rollupId)] }));
  adapterAlias = await read(network.l1.rpc, network.registry, eeZAbi, 'computeCrossChainProxyAddress', [adapter, BigInt(network.rollupId)]);
  const singletonL2 = await deploy(network.l2, safeArtifact);
  const factoryL2 = await deploy(network.l2, factoryArtifact);
  safeL2 = await createSafe(network.l2, singletonL2, factoryL2, [adapter], 1n, 2n);
  action = await deploy(network.l2, actionArtifact, [safeL2]);
  evidence.contracts = { safeL1, safeL2, adapter, adapterAlias, action, manager };
  checkpoint();
  assert.equal(await read(network.l1.rpc, safeL1, safeArtifact.abi, 'VERSION'), safeVersion);
  assert.equal(await read(network.l2.rpc, safeL2, safeArtifact.abi, 'VERSION'), safeVersion);
  // Ensure setup is canonical before measuring the cross-chain authorization.
  const setupHeight = Number(BigInt(await rpc(network.l2.rpc, 'eth_blockNumber')));
  await until('setup settlement', async () => {
    const safe = await rpc(network.l2.rpc, 'eth_getBlockByNumber', ['safe', false]);
    return safe && Number(BigInt(safe.number)) >= setupHeight;
  });
  if (setupOnly) return { A, B, C, submitter, network, evidence, checkpoint, rpc, read, send, until, safeAdmin,
    artifact, deploy, submit, eeZAbi, safeArtifact, actionArtifact, safeL1, safeL2, adapter, adapterAlias, action, manager, singletonL1, singletonL2,
    ownerVerificationOnL1 };
  const bc = await approval([B, C], 42n);
  await reject('C is not yet an L1 owner', bc, 0n, 0n);
  const addition = await safeAdmin(safeL1, 'addOwnerWithThreshold', [C.address, 2n]);
  evidence.ownerAddition = addition.transactionHash;
  assert.equal(await read(network.l1.rpc, safeL1, safeArtifact.abi, 'isOwner', [C.address]), true);
  await settle('B+C after adding C on L1', bc, 42n, 1n);
  await reject('Replayed Safe approval', bc, 1n, 42n);
  const stale = await approval([B, C], 99n);
  const removal = await safeAdmin(safeL1, 'removeOwner', ['0x0000000000000000000000000000000000000001', C.address, 2n]);
  evidence.ownerRemoval = removal.transactionHash;
  assert.equal(await read(network.l1.rpc, safeL1, safeArtifact.abi, 'isOwner', [C.address]), false);
  await reject('C removed before verification', stale, 1n, 42n);
  await settle('A+B remain authorized after removing C', await approval([A, B], 43n), 43n, 2n);
  assert.deepEqual((await read(network.l2.rpc, safeL2, safeArtifact.abi, 'getOwners')).map(x => x.toLowerCase()), [adapter.toLowerCase()]);
  assert.equal(await read(network.l2.rpc, safeL2, safeArtifact.abi, 'getThreshold'), 1n);
  const { runPairedPayments } = await import('./treasury-standard-bridge.mjs');
  await runPairedPayments({ A, B, C, submitter, network, evidence, checkpoint, rpc, read, send, until, safeAdmin,
    artifact, deploy, submit, eeZAbi, safeArtifact, actionArtifact, safeL1, safeL2, adapter, adapterAlias, action, manager, singletonL1, singletonL2 }, evidenceFile);
  evidence.scenarioComplete = true;
  checkpoint();
} catch (error) {
  evidence.failure = String(error.stack || error);
  checkpoint();
  throw error;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const task = process.env.TREASURY_STANDARD_BRIDGE_SNAPSHOT ? import('./treasury-standard-bridge.mjs').then(m => m.runStandardBridge(...process.argv.slice(2))) : process.env.TREASURY_UI_MODE ? import('../../scripts/treasury-devnet.mjs') : runFixture(...process.argv.slice(2));
  task.catch(error => { console.error(error); process.exitCode = 1; });
}
