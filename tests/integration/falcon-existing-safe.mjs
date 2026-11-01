// Execute the reviewed Safe runtimes locally. Registry routing is a test double;
// this does not emulate Falcon verification, EEZ settlement or a mainnet deployment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, encodeFunctionData, pad, toHex, zeroAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { crossChainDeployment } from '../../src/lib/falcon/crossChainDeployment.ts';
import { ownerTransaction, prepareOwnerAddition, verifyOwnerAddition } from '../../src/lib/falcon/existingSafe.ts';
import { safeCallData, prepareSafeTransfer, hasSafeExecution } from '../../src/lib/falcon/safe.ts';
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals } from '../../src/lib/treasury/safeTransactions.ts';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const snapshots = read('tests/falcon/fixtures/existing-safes.json');
const safe150 = read('contracts/test/fixtures/safe-150.json').contracts.Safe;
const safe141 = read('tests/falcon/fixtures/deployed-code.json').singleton;
const abi141 = read('src/lib/treasury/deployment-artifacts.json').contracts.Safe.abi;
const address = n => toHex(n, { size: 20 });
const A = privateKeyToAccount(toHex(12345, { size: 32 })), B = privateKeyToAccount(toHex(12346, { size: 32 }));
const owner = address(900), controller = address(901), registry = address(902), recipient = address(903), handler = address(904);
const fallbackSlot = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
const signal = new AbortController().signal;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync('.runtime/falcon-existing-safe', { recursive: true });
const directory = mkdtempSync('.runtime/falcon-existing-safe/anvil-');
const reservation = createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const log = openSync(`${directory}/anvil.log`, 'w');
const node = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--hardfork', 'prague', '--silent'], { stdio: ['ignore', log, log] });
closeSync(log);
// Anvil mines consecutive fixture transactions faster than viem's default head cache.
const client = createPublicClient({ cacheTime: 0, transport: http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 5000 }) });
const rpc = (method, params = []) => client.request({ method, params });
const evidence = { passed: false, scope: 'Isolated Safe EVM execution with local fixture owners and stubbed registry; no public RPC or native EEZ execution', cases: [] };
async function send(from, to, data) {
  const hash = await rpc('eth_sendTransaction', [{ from, to, data, gas: '0x1e8480' }]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return receipt;
}
try {
  for (let i = 0; i < 100; i++) {
    try { assert.equal(await client.getChainId(), 1); break; } catch (error) { if (i === 99) throw error; await wait(50); }
  }
  const anchor = await client.getBlock({ blockNumber: 0n });
  const d = { ...crossChainDeployment, l1: { ...crossChainDeployment.l1, chainId: 1, chainName: 'Local fixture', registry, anchor: { blockNumber: 0n, blockHash: anchor.hash } } };
  // The application still performs real Safe reads, chain checks and receipt verification.
  const routed = { ...client, readContract: params => params.address.toLowerCase() === registry.toLowerCase()
    ? Promise.resolve(params.functionName === 'computeCrossChainProxyAddress' ? owner : [true, controller, d.l2.rollupId])
    : client.readContract(params) };
  for (const account of [A.address, B.address, owner]) {
    await rpc('anvil_setBalance', [account, toHex(10n ** 20n)]);
    await rpc('anvil_impersonateAccount', [account]);
  }
  // A delegated EOA still approves Safe transactions with its ECDSA key.
  await rpc('anvil_setCode', [handler, '0x00']);
  await rpc('anvil_setCode', [A.address, `0xef0100${handler.slice(2)}`]);
  for (const [name, snapshot, runtime, abi] of [
    ['Safe 1.5.0 / mainnet proxy', snapshots.mainnet, safe150.runtime, safe150.abi],
    ['SafeL2 1.4.1 / Falcon proxy', snapshots.chiado, safe141.code, abi141],
  ]) {
    const safe = snapshot.address, singleton = snapshot.singleton.address, module = snapshots.mainnet.modules[0];
    assert.equal(keccak256(runtime), snapshot.singleton.codeHash);
    assert.equal(keccak256(snapshot.proxy.runtime), snapshot.proxy.codeHash);
    await rpc('anvil_setCode', [singleton, runtime]);
    await rpc('anvil_setCode', [safe, snapshot.proxy.runtime]);
    await rpc('anvil_setStorageAt', [safe, '0x0', pad(singleton)]);
    await send(A.address, safe, encodeFunctionData({ abi, functionName: 'setup', args: [[A.address, B.address], 1n, zeroAddress, '0x', handler, zeroAddress, 0n, zeroAddress] }));
    const readSafe = (functionName, args = []) => client.readContract({ address: safe, abi, functionName, args });
    const enable = buildSafeTransaction({ chainId: 1n, safe, to: safe, nonce: 0n, data: encodeFunctionData({ abi, functionName: 'enableModule', args: [module] }) });
    await send(A.address, safe, encodeSafeExecution(enable, await A.signTypedData(enable)));
    const before = { owners: await readSafe('getOwners'), modules: await readSafe('getModulesPaginated', [address(1), 50n]), handler: await client.getStorageAt({ address: safe, slot: fallbackSlot }) };
    const review = await prepareOwnerAddition(routed, d, controller, safe, A.address, signal);
    assert.equal(review.transaction.message.data, ownerTransaction(d, safe, owner, 1n).message.data);
    const signature = await packEOAApprovals(review.transaction, before.owners, 1, [{ owner: A.address, signature: await A.signTypedData(review.transaction) }]);
    const data = encodeSafeExecution(review.transaction, signature);
    const nonce = await client.getTransactionCount({ address: A.address });
    const receipt = await send(A.address, safe, data);
    const attachment = await verifyOwnerAddition(routed, d, { version: 1, id: name, kind: 'owner', chainId: 1, account: A.address, to: safe,
      nonce: String(nonce), value: '0', data, publicKey: `0x${'11'.repeat(897)}`, controller, safeNonce: '1', hash: receipt.transactionHash }, signal);
    assert.deepEqual((await readSafe('getOwners')).map(a => a.toLowerCase()), [owner, ...before.owners].map(a => a.toLowerCase()));
    assert.equal(await readSafe('getThreshold'), 1n);
    assert.deepEqual(await readSafe('getModulesPaginated', [address(1), 50n]), before.modules);
    assert.equal(await client.getStorageAt({ address: safe, slot: fallbackSlot }), before.handler);
    await rpc('anvil_setBalance', [safe, '0x1']);
    // Impersonation supplies the cross-chain caller only; it does not prove its routing.
    await rpc('anvil_setCode', [owner, '0x00']);
    const operation = await prepareSafeTransfer(routed, d, controller, recipient, 1n, signal, '0x', attachment);
    const call = safeCallData(owner, recipient, 1n);
    await assert.rejects(client.call({ account: B.address, to: safe, data: call }), /GS025/);
    const balance = await client.getBalance({ address: recipient });
    const executed = await send(owner, safe, call);
    assert(hasSafeExecution(executed, operation));
    assert.equal(await readSafe('nonce'), operation.safeNonce + 1n);
    assert.equal(await client.getBalance({ address: recipient }), balance + 1n);
    assert.deepEqual(await readSafe('getModulesPaginated', [address(1), 50n]), before.modules);
    evidence.cases.push({ name, proxyHash: snapshot.proxy.codeHash, singletonHash: snapshot.singleton.codeHash,
      ownerAddition: receipt.transactionHash, controllerCall: executed.transactionHash, threshold: 1, owners: await readSafe('getOwners'), modules: before.modules[0] });
  }
  evidence.passed = true;
  console.log('PASS: Safe 1.5.0 and Falcon 1.4.1 proxies, EIP-7702 typed approvals, 1-of-2 to 1-of-3 owner addition, canonical recovery, preserved modules/handler, authenticated controller calls');
} finally {
  writeFileSync(`${directory}/summary.json`, JSON.stringify(evidence, null, 2) + '\n');
  if (node.exitCode === null) { node.kill('SIGTERM'); await once(node, 'exit'); }
  console.log(`Evidence: ${directory}`);
}
