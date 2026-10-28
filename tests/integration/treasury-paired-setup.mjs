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
import { MainnetSetup, readMainnetSetup } from '../../src/lib/treasury/mainnetSetup.ts';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { validatePairedPayments } from '../../src/lib/treasury/pairedPolicy.ts';
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals, packOwnerApprovals } from '../../src/lib/treasury/safeTransactions.ts';
const read = path => JSON.parse(readFileSync(path));
const release = read(`src/lib/treasury/builds/${read('src/lib/treasury/current-build.json').build}.json`), artifacts = release.contracts;
const [A, B] = [0xa11cen, 0xb0bn].map(n => privateKeyToAccount(toHex(n, { size: 32 })));
const fresh = argv.includes('--create-both'), owners = fresh ? [A] : [A,B];
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
  if (fresh) {
    // Standard Safe infrastructure already present on a supported L1.
    const officialSafe = read('tests/fixtures/safe-130-runtime.json').contracts.Safe130L2;
    assert.equal(keccak256(officialSafe.runtime), officialSafe.codeHash);
    await rpc('anvil_setCode',[officialSafe.address,officialSafe.runtime]);
    for (const helper of Object.values(read('tests/fixtures/official-safe-runtime.json').contracts)) {
      assert.equal(keccak256(helper.runtime),helper.codeHash);
      await rpc('anvil_setCode',[helper.address,helper.runtime]);
    }
  }
  const network = structuredClone(read('src/lib/treasury/mainnet-network.json'));
  Object.assign(network, { testnet: true, registry, manager });
  for (const chain of ['l1','l2']) Object.assign(network.chains[chain], { chainId: ids[chain], number: '0x0', hash: (await rpc('eth_getBlockByNumber',['0x0',false])).hash });
  network.contracts.bridgeL1.address = bridgeL1; network.contracts.bridgeL2.address = bridgeL2; network.contracts.usdcProxy.address = tokenL1;
  const target = { l1: { rpc:url,front:url,explorer:'https://example.com' }, l2: { rpc:url,front:url,explorer:'https://example.com' }, fees: {l1:'100000000000000000',l2:'100000000000000000'} };
  const engine = new MainnetSetup(target, release, network);
  // Only network pin/Composer checks are fixture-controlled. All contract reads,
  // bytecode checks, CREATE predictions, owner reviews and executions are real.
  engine.validate = async () => {};
  engine.io.rpc = async (chain, method, params = []) => {
    if (method === 'eth_chainId') return toHex(ids[chain]);
    // These fixture managers are not upgradeable proxies. Model their pinned
    // implementation slots while retaining real setup block/hash observations.
    if (method === 'eth_getStorageAt' && params[1] === '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
      && [registry,manager].some(address => address.toLowerCase() === params[0].toLowerCase()))
      return toHex(BigInt(params[0]), { size: 32 });
    return rpc(method, params);
  };
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
  state = await engine.configure(A.address, fresh ? undefined : safeL1);
  assert.equal(state.creation, fresh ? "create-both" : undefined);
  assert.equal(state.version,3); assert.equal(state.addresses.bridgeExecutorL1,undefined);
  for (let i = 0; i < 4; i++) {
    const chain = i === 1 || i === 2 ? 'l2' : 'l1', nonce = await rpc('eth_getTransactionCount',[A.address,'pending']);
    const batch = await engine.batch(state, nonce), receipt = await send(chain,batch.to,batch.data);
    const pending = { ...batch,id:String(i),chain,sender:A.address,nonce,hash:receipt.transactionHash };
    state = await engine.reconcile({ ...state,pending }); assert.equal(state.completed.length,i+1);
    state = readMainnetSetup(JSON.stringify(state),network);
    for (const out of batch.outputs) assert(!out.artifact || artifacts[out.artifact], `Unreleased deployment ${out.artifact}`);
  }
  if (fresh) for (const chain of ['l1','l2']) {
    const safe = state.addresses[chain === 'l1' ? 'safeL1' : 'safeL2'];
    assert.deepEqual(await engine.io.read(chain,safe,'Safe','getOwners'),[A.address]);
    assert.equal(await engine.io.read(chain,safe,'Safe','getThreshold'),1n);
    assert.equal(await engine.io.read(chain,safe,'Safe','nonce'),0n);
  }
  if (fresh) {
    // Before L1 setup connects its policy, activation must fail atomically:
    // the attempted owner replacement cannot leave a half-configured Safe.
    await rpc('anvil_setChainId',[ids.l2]);
    const early={...state,completed:[...state.completed,{}]},review=await engine.review(early),tx=engine.tx(early,review);
    const signature=await packEOAApprovals(tx,[A.address],1,[{owner:A.address,signature:await A.signTypedData(tx)}]);
    const hash=await rpc('eth_sendTransaction',[{from:A.address,to:state.addresses.safeL2,data:encodeSafeExecution(tx,signature),gas:'0x1c9c380'}]);
    let receipt; for(let i=0;i<100&&!receipt;i++){receipt=await rpc('eth_getTransactionReceipt',[hash]);if(!receipt)await wait(20);}
    assert(receipt);assert.equal(receipt.status,'0x0');
    assert.deepEqual(await engine.io.read('l2',state.addresses.safeL2,'Safe','getOwners'),[A.address]);
    assert.equal(await engine.io.read('l2',state.addresses.safeL2,'Safe','nonce'),0n);
  }
  for (const chain of ['l1','l2']) {
    await rpc('anvil_setChainId',[ids[chain]]);
    if (fresh && chain === 'l2') {
      const snapshot=await rpc('evm_snapshot');
      const noop=buildSafeTransaction({chainId:BigInt(ids.l2),safe:state.addresses.safeL2,to:A.address,nonce:0n,data:'0x'});
      const approval={owner:A.address,signature:await A.signTypedData(noop)};
      await send('l2',state.addresses.safeL2,encodeSafeExecution(noop,await packEOAApprovals(noop,[A.address],1,[approval])));
      await assert.rejects(engine.review(state),/nonce 0 before handover/);
      await rpc('evm_revert',[snapshot]);
    }
    const review = await engine.review(state), tx = engine.tx(state,review);
    assert.equal(review.chain,chain); assert.equal(tx.domain.verifyingContract.toLowerCase(),state.addresses[chain === 'l1' ? 'safeL1' : 'safeL2'].toLowerCase());
    const approvals = await Promise.all(owners.map(async owner => ({ owner:owner.address,signature:await owner.signTypedData(tx) })));
    const signatures = chain === 'l1' || fresh ? await packEOAApprovals(tx,review.owners,owners.length,approvals) : await packOwnerApprovals(tx,state.addresses.adapter,review.owners,owners.length,approvals);
    const receipt = await send(chain,tx.domain.verifyingContract,encodeSafeExecution(tx,signatures));
    state = { ...state, completed:[...state.completed,{chain,hash:receipt.transactionHash,number:receipt.blockNumber,blockHash:receipt.blockHash}] };
  }
  }
  if (fresh) {
    assert.deepEqual(await engine.io.read('l2',state.addresses.safeL2,'Safe','getOwners'),[state.addresses.adapter]);
    assert.equal(await engine.io.read('l2',state.addresses.safeL2,'Safe','getThreshold'),1n);
    assert.equal(await engine.io.read('l2',state.addresses.safeL2,'Safe','nonce'),1n);
    assert.deepEqual(await engine.io.read('l1',state.addresses.safeL1,'Safe','getOwners'),[A.address]);
    const oldOwnerTx=buildSafeTransaction({chainId:BigInt(ids.l2),safe:state.addresses.safeL2,to:A.address,nonce:1n,data:'0x'});
    const oldSignature=await packEOAApprovals(oldOwnerTx,[A.address],1,[{owner:A.address,signature:await A.signTypedData(oldOwnerTx)}]);
    await assert.rejects(rpc('eth_call',[{from:A.address,to:state.addresses.safeL2,data:encodeSafeExecution(oldOwnerTx,oldSignature)},'latest']));

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
    const signingClient = new TreasuryClient(evidence.manifest);
    signingClient.rpc = async () => assert.fail('Payment signing must not repeat RPC reads');
    const snapshot = {source,owners:owners.map(o=>o.address),threshold:owners.length,nonce:tx.message.nonce};
    const approvals = await Promise.all(owners.map(owner => signingClient.approve({request:async({method,params})=>{
      if(method==='eth_accounts')return [owner.address];
      if(method==='eth_chainId')return toHex(ids[source]);
      assert.equal(method,'eth_signTypedData_v4');return owner.signTypedData(JSON.parse(params[1]));
    }},tx,snapshot,owner.address)));
    const sig = source==='l1' ? await packEOAApprovals(tx,owners.map(o=>o.address),owners.length,approvals) : await packOwnerApprovals(tx,a.adapter,owners.map(o=>o.address),owners.length,approvals);
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
