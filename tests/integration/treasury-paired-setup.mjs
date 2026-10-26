// Genuine packaged contracts and planner batches on one EVM with read-through
// managers. L2 Safe executions are sent locally: this does not prove EEZ relay,
// Composer, canonical cross-chain settlement, or native rollback behavior.
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { encodeDeployData, encodeFunctionData, decodeEventLog, keccak256, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MainnetSetup } from '../../src/lib/treasury/mainnetSetup.ts';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { validatePairedPayments } from '../../src/lib/treasury/pairedPolicy.ts';
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals, packOwnerApprovals } from '../../src/lib/treasury/safeTransactions.ts';
const read = path => JSON.parse(readFileSync(path));
const release = read(`src/lib/treasury/builds/${read('src/lib/treasury/current-build.json').build}.json`), artifacts = release.contracts;
const [A, B] = [0xa11cen, 0xb0bn].map(n => privateKeyToAccount(toHex(n, { size: 32 })));
const pairedNetwork = read('src/lib/treasury/paired-testnet-network.json');
const ids = { l1: pairedNetwork.chains.l1.chainId, l2: pairedNetwork.chains.l2.chainId }, wait = ms => new Promise(r => setTimeout(r, ms));
mkdirSync('.runtime/paired-setup', { recursive: true }); const directory = mkdtempSync('.runtime/paired-setup/anvil-');
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(r => reservation.close(r));
const fd = openSync(`${directory}/anvil.log`, 'w'), process = spawn('anvil', ['--host','127.0.0.1','--port',String(port),'--chain-id',String(ids.l1),'--silent'], { stdio: ['ignore', fd, fd] }); closeSync(fd);
const url = `http://127.0.0.1:${port}`;
async function rpc(method, params = []) { const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result; }
const evidence = { build: release.build, scope: 'single EVM with real planner batches and Safe signatures; L2 calls executed locally, no native relay/proofs', passed: false, deployments: [], payments: [] };
async function send(chain, to, data) {
  await rpc('anvil_setChainId', [ids[chain]]);
  const hash = await rpc('eth_sendTransaction', [{ from: A.address, to, data, gas: '0x1c9c380' }]);
  let receipt; for (let i = 0; i < 100 && !receipt; i++) { receipt = await rpc('eth_getTransactionReceipt', [hash]); if (!receipt) await wait(20); }
  assert(receipt, 'receipt timeout'); assert.equal(receipt.status, '0x1', `${chain}: ${hash}`); return receipt;
}
async function deploy(chain, name, args = [], fixture) {
  const a = fixture ?? artifacts[name]; assert(a, `No released artifact ${name}`);
  const receipt = await send(chain, undefined, encodeDeployData({ abi: a.abi, bytecode: fixture ? a.bytecode.object : a.bytecode, args }));
  evidence.deployments.push({ chain, name, address: receipt.contractAddress, hash: receipt.transactionHash }); return receipt.contractAddress;
}
const call = (chain, to, name, method, args = []) => send(chain, to, encodeFunctionData({ abi: artifacts[name].abi, functionName: method, args }));
try {
  for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId'); break; } catch { await wait(50); } }
  await rpc('anvil_setBalance', [A.address, toHex(100n * 10n ** 18n)]); await rpc('anvil_impersonateAccount', [A.address]);
  const fixture = read('contracts/out/OwnerFixture.sol/ReadThroughManager.json');
  const registry = await deploy('l1', 'ReadThroughManager', [0n], fixture), manager = await deploy('l2', 'ReadThroughManager', [1n], fixture);
  for (const [chain, local, peer] of [['l1',registry,manager],['l2',manager,registry]]) await send(chain, local, encodeFunctionData({ abi: fixture.abi, functionName: 'setPeer', args: [peer] }));
  const bridgeL1 = await deploy('l1', 'Bridge'), bridgeL2 = await deploy('l2', 'Bridge');
  await call('l1', bridgeL1, 'Bridge', 'initialize', [registry,0n,A.address]); await call('l2', bridgeL2, 'Bridge', 'initialize', [manager,1n,A.address]);
  await call('l1', bridgeL1, 'Bridge', 'setCanonicalBridgeAddress', [bridgeL2]); await call('l2', bridgeL2, 'Bridge', 'setCanonicalBridgeAddress', [bridgeL1]);
  const tokenL1 = await deploy('l1', 'TestUSDC', [bridgeL1,1n]); await call('l1', tokenL1, 'TestUSDC', 'claimOnL2', [A.address]);
  const singleton = await deploy('l1', 'Safe'), factory = await deploy('l1', 'SafeProxyFactory');
  const initialize = encodeFunctionData({ abi: artifacts.Safe.abi, functionName: 'setup', args: [[A.address,B.address],2n,zeroAddress,'0x',zeroAddress,zeroAddress,0n,zeroAddress] });
  const created = await call('l1', factory, 'SafeProxyFactory', 'createProxyWithNonce', [singleton,initialize,1n]);
  const safeL1 = created.logs.flatMap(log => { try { const e = decodeEventLog({ abi: artifacts.SafeProxyFactory.abi, ...log }); return e.eventName === 'ProxyCreation' ? [e.args.proxy] : []; } catch { return []; } })[0]; assert(safeL1);
  const network = structuredClone(read('src/lib/treasury/mainnet-network.json'));
  Object.assign(network, { testnet: true, registry, manager });
  for (const chain of ['l1','l2']) Object.assign(network.chains[chain], { chainId: ids[chain], number: '0x0', hash: (await rpc('eth_getBlockByNumber',['0x0',false])).hash });
  network.contracts.bridgeL1.address = bridgeL1; network.contracts.bridgeL2.address = bridgeL2; network.contracts.usdcProxy.address = tokenL1;
  const target = { l1: { rpc:url,front:url,explorer:'https://example.com' }, l2: { rpc:url,front:url,explorer:'https://example.com' }, fees: {l1:'100000000000000000',l2:'100000000000000000'} };
  const engine = new MainnetSetup(target, release, network);
  // Only network pin/Composer checks are fixture-controlled. All contract reads,
  // bytecode checks, CREATE predictions, owner reviews and executions are real.
  engine.validate = async () => {};
  engine.io.rpc = async (chain, method, params = []) => method === 'eth_chainId' ? toHex(ids[chain]) : rpc(method, params);
  network.contracts.wrappedUSDC.address = await engine.io.read('l2',bridgeL2,'Bridge','getWrappedToken',[tokenL1,0n]);
  network.contracts.usdcImplementation.address = tokenL1;
  for (const entry of Object.values(network.contracts)) entry.hash = keccak256(await rpc('eth_getCode',[entry.address,'latest']));
  network.protocol = await Promise.all([['l1',registry],['l2',manager]].map(async ([chain,address]) => {
    const hash = keccak256(await rpc('eth_getCode',[address,'latest']));
    return {chain,proxy:address,implementation:address,proxyHash:hash,implementationHash:hash};
  }));
  let state;
  if (argv.includes('--browser')) {
    const { deploymentBrowser } = await import('./treasury-deployment-browser.mjs');
    state = await deploymentBrowser({network,target,engine,A,B,safeL1,rpc,send,evidence,directory,ids});
  } else {
  state = await engine.configure(A.address, safeL1);
  assert.equal(state.version,3); assert.equal(state.addresses.bridgeExecutorL1,undefined);
  for (let i = 0; i < 4; i++) {
    const chain = i === 1 || i === 2 ? 'l2' : 'l1', nonce = await rpc('eth_getTransactionCount',[A.address,'pending']);
    const batch = await engine.batch(state, nonce), receipt = await send(chain,batch.to,batch.data);
    const pending = { ...batch,id:String(i),chain,sender:A.address,nonce,hash:receipt.transactionHash };
    state = await engine.reconcile({ ...state,pending }); assert.equal(state.completed.length,i+1);
    for (const out of batch.outputs) assert(!out.artifact || artifacts[out.artifact], `Unreleased deployment ${out.artifact}`);
  }
  for (const chain of ['l1','l2']) {
    await rpc('anvil_setChainId',[ids[chain]]);
    const review = await engine.review(state), tx = engine.tx(state,review);
    assert.equal(review.chain,chain); assert.equal(tx.domain.verifyingContract.toLowerCase(),state.addresses[chain === 'l1' ? 'safeL1' : 'safeL2'].toLowerCase());
    const approvals = await Promise.all([A,B].map(async owner => ({ owner:owner.address,signature:await owner.signTypedData(tx) })));
    const signatures = chain === 'l1' ? await packEOAApprovals(tx,review.owners,2,approvals) : await packOwnerApprovals(tx,state.addresses.adapter,review.owners,2,approvals);
    const receipt = await send(chain,tx.domain.verifyingContract,encodeSafeExecution(tx,signatures));
    state = { ...state, completed:[...state.completed,{chain,hash:receipt.transactionHash,number:receipt.blockNumber,blockHash:receipt.blockHash}] };
  }
  }
  const a = state.addresses, tokenL2 = network.contracts.wrappedUSDC.address;
  for (const [chain,policy] of [['l1',a.policyL1],['l2',a.policy]]) assert.equal(await engine.io.read(chain,policy,'PairedTreasuryPolicy','active'),true);
  // Validate the generated manifest and real pair/module/proxy bindings. The
  // single-EVM fixture cannot stand in for production chain/implementation pins.
  const originalValidate = TreasuryClient.prototype.validate;
  try {
    TreasuryClient.prototype.validate = function() { return validatePairedPayments(this); };
    const manifest = await engine.manifest(state);
    assert.equal(manifest.environment,'dashboard-testnet'); assert.equal(manifest.payments.pair.policyL1,a.policyL1);
    assert.equal(manifest.payments.bridgeExecutorL1,undefined); assert(manifest.safeAppUrl.includes('safe=chiado:'));
    evidence.manifest = manifest;
  } finally { TreasuryClient.prototype.validate = originalValidate; }
  await call('l1',tokenL1,'TestUSDC','claim',[a.safeL1]); await call('l1',tokenL1,'TestUSDC','claimOnL2',[a.safeL2]);
  const recipient = '0x0000000000000000000000000000000000001234';
  for (const source of ['l1','l2']) for (const destination of ['l1','l2']) {
    const safe = source === 'l1' ? a.safeL1 : a.safeL2, policy = source === 'l1' ? a.policyL1 : a.policy;
    await rpc('anvil_setChainId',[ids[source]]);
    const epoch = BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp)/600n;
    const tx = buildSafeTransaction({chainId:BigInt(ids[source]),safe,to:policy,nonce:await engine.io.read(source,safe,'Safe','nonce'),
      data:encodeFunctionData({abi:artifacts.PairedTreasuryPolicy.abi,functionName:'paySplit',args:[recipient,20_000_000n,destination==='l1',epoch,10_000_000n]})});
    const approvals = await Promise.all([A,B].map(async owner => ({owner:owner.address,signature:await owner.signTypedData(tx)})));
    const sig = source==='l1' ? await packEOAApprovals(tx,[A.address,B.address],2,approvals) : await packOwnerApprovals(tx,a.adapter,[A.address,B.address],2,approvals);
    const receipt = await send(source,safe,encodeSafeExecution(tx,sig)); evidence.payments.push({source,destination,hash:receipt.transactionHash});
  }
  assert.equal(await engine.io.read('l1',tokenL1,'TestUSDC','balanceOf',[recipient]),40_000_000n);
  assert.equal(await engine.io.read('l2',tokenL2,'WrappedToken','balanceOf',[recipient]),40_000_000n);
  for (const [chain,safe,policy,module,token] of [['l1',a.safeL1,a.policyL1,a.moduleL1,tokenL1],['l2',a.safeL2,a.policy,a.moduleL2,tokenL2]]) {
    const allowance = await engine.io.read(chain,module,'AllowanceModule','getTokenAllowance',[safe,policy,token]);
    assert.equal(allowance[0],100_000_000n); assert.equal(allowance[1],40_000_000n);
    assert.equal(await engine.io.read(chain,token,'TestUSDC','balanceOf',[safe]),960_000_000n);
  }
  const epoch = BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp)/600n;
  assert.equal(await engine.io.read('l2',a.policy,'PairedTreasuryPolicy','spent',[epoch]),80_000_000n);
  evidence.passed = true; console.log('PASS current-only planner deployment, both Safe approval batches, activation, fixed faucet, all four payment routes and local/shared accounting');
} finally { writeFileSync(`${directory}/summary.json`,JSON.stringify(evidence,null,2)); process.kill('SIGTERM'); await once(process,'exit'); console.log(`Evidence: ${directory}`); }
