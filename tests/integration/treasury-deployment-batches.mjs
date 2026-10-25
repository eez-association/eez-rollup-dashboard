// Real Safe contracts on one owned Anvil with separate logical chain phases. Only protocol discovery/checkpoints
// are fixture substitutes: this does not claim EEZ settlement or signer coverage.
import assert from 'node:assert/strict';
// Retained Chiado planner and shared-build.json compatibility rehearsal.
// Paired-policy bytecode reproduction is covered by treasury-source-verification.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { concatHex, decodeEventLog, decodeFunctionData, encodeDeployData, encodeFunctionData, encodeFunctionResult, getAddress, getContractAddress, keccak256, parseAbi, size, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TreasuryDeployment, readDeployment, deploymentIdentity } from '../../src/lib/treasury/deployment.ts';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { TreasuryNetworkDeployment, TreasuryFaucetDeployment, readNetworkDeployment } from '../../src/lib/treasury/networkDeployment.ts';
import { verifyAssetInfrastructure } from '../../src/lib/treasury/assetInfrastructure.ts';
import { discoverSharedInfrastructure, verifySharedInfrastructure } from '../../src/lib/treasury/sharedInfrastructure.ts';
import { packOwnerApprovals } from '../../src/lib/treasury/safeTransactions.ts';
import { adoptL1Owners, inspectSafe, SAFE_GUARD_SLOT } from '../../src/lib/treasury/safeSetup.ts';
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals, safeTransactionHash } from '../../src/lib/treasury/safeTransactions.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_MARKER } from '../../src/lib/composerDiscovery.ts';
const legacy = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const release = JSON.parse(readFileSync(`src/lib/treasury/builds/${JSON.parse(readFileSync('src/lib/treasury/shared-build.json')).build}.json`));
const artifacts = { ...release, contracts: { ...legacy.contracts, ...release.contracts } };
const officialRuntime = JSON.parse(readFileSync('tests/fixtures/official-safe-runtime.json'));
const profile = JSON.parse(readFileSync('src/lib/treasury/shared-network.json'));
const [A, B, C] = [0xa11cen, 0xb0bn, 0xc0cn].map(key => privateKeyToAccount(toHex(key, { size: 32 })));
const sentinel = getAddress(toHex(1, { size: 20 }));
const handlerSlot = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const names = ['l1', 'l2'], processes = [], chains = {}, calls = [];
mkdirSync('.runtime/treasury-deployment-batches', { recursive: true });
const directory = mkdtempSync('.runtime/treasury-deployment-batches/anvil-');
const evidence = { verified: false, scope: 'single owned EVM with real contracts and read-through EEZ managers; chain IDs switched per phase; fee responses are fixtures with real EVM gas estimates, no Composer/proofs', anvil: execFileSync('anvil', ['--version'], { encoding: 'utf8' }).trim(), cases: [], transactions: [], feeQuotes: [] };
const record = name => { evidence.cases.push(name); console.log(`PASS ${name}`); };
let d;
let advanceSafeHead = true;
async function rpc(chain, method, params = []) {
  const response = await fetch(chains[chain].rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const result = await response.json(); if (result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`); if (['anvil_setStorageAt', 'anvil_setCode'].includes(method)) await rpc(chain, 'anvil_mine', ['0x40']);
  return result.result;
}
async function start(chain) {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const log = openSync(`${directory}/${chain}.log`, 'w');
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(profile.chains[chain].chainId), '--silent'], { stdio: ['ignore', log, log] });
  closeSync(log); processes.push(child); chains[chain] = { rpc: `http://127.0.0.1:${port}`, front: `http://127.0.0.1:${port}` };
  for (let i = 0; i < 100; i++) {
    try { assert.equal(Number(BigInt(await rpc(chain, 'eth_chainId'))), profile.chains[chain].chainId); return; } catch (error) { if (child.exitCode !== null) throw error; }
    await sleep(50);
  }
  throw new Error(`Anvil ${chain} did not start`);
}
function provider(chain, account) {
  return { isRabby: account.address === B.address, request: async ({ method, params = [] }) => {
    calls.push(method);
    if (method === 'eth_accounts') return [account.address];
    if (method === 'eth_chainId') return toHex(profile.chains[chain].chainId);
    if (chain === 'l2' && method === 'eth_getLogs' && params[0].topics?.[0] === keccak256(toHex('Created(uint256,address,bytes32)'))) {
      const logs = await rawRpc(chain, method, params, front);
      return logs.filter(log => evidence.transactions.some(tx => tx.chain === 'l2' && tx.hash === log.transactionHash));
    }
    if (method === 'eth_signTypedData_v4') { assert.equal(params[0], account.address); return account.signTypedData(JSON.parse(params[1])); }
    if (method === 'eth_call') {
      const [nonce] = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data: params[0].data }).args;
      return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [COMPOSER_DISCOVERY_MARKER, 1n, nonce, BigInt(profile.chains[chain].chainId), toHex(JSON.stringify({ version: 'owned-anvil-setup-fixture', supportedNetworks: { eezL1: 10200, eezL2: 906969 }, eezContracts: { eezRegistryAddress: profile.registry, eezL2Address: profile.manager } }))] });
    }
    throw new Error(`Unexpected wallet method ${method}`);
  } };
}
async function send(chain, account, to, data, value = 0n, success = true, preparedRequest) {
  await rpc(chain, 'anvil_setChainId', [profile.chains[chain].chainId]);
  const nonce = Number(BigInt(await rpc(chain, 'eth_getTransactionCount', [account.address, 'pending'])));
  const quoted = preparedRequest?.type !== undefined;
  if (quoted) {
    assert.equal(preparedRequest.to.toLowerCase(), to.toLowerCase()); assert.equal(preparedRequest.data.toLowerCase(), data.toLowerCase(), 'quoted calldata bytes');
    assert.equal(BigInt(preparedRequest.nonce), BigInt(nonce)); assert.equal(BigInt(preparedRequest.value), value);
  }
  const fees = quoted ? preparedRequest.type === '0x0'
    ? { type: 'legacy', gasPrice: BigInt(preparedRequest.gasPrice) }
    : { type: 'eip1559', maxFeePerGas: BigInt(preparedRequest.maxFeePerGas), maxPriorityFeePerGas: BigInt(preparedRequest.maxPriorityFeePerGas) }
    : { gasPrice: 2_000_000_000n };
  const raw = await account.signTransaction({ chainId: profile.chains[chain].chainId, nonce, ...(to ? { to } : {}), data, value,
    gas: quoted ? BigInt(preparedRequest.gas) : 15_000_000n, ...fees });
  const hash = await rpc(chain, 'eth_sendRawTransaction', [raw]);
  let receipt;
  for (let i = 0; i < 100 && !receipt; i++) { receipt = await rpc(chain, 'eth_getTransactionReceipt', [hash]); if (!receipt) await sleep(50); }
  assert(receipt, 'Anvil transaction receipt');
  assert.equal(receipt.status, success ? '0x1' : '0x0');
  if (advanceSafeHead) await rpc(chain, 'anvil_mine', ['0x40']);
  evidence.transactions.push({ chain, hash, success }); return receipt;
}
async function deploy(chain, name, args = [], fixture = false) {
  const contract = fixture ? JSON.parse(readFileSync(`contracts/out/OwnerFixture.sol/${name}.json`)) : artifacts.contracts[name];
  return (await send(chain, A, undefined, encodeDeployData({ abi: contract.abi, bytecode: fixture ? contract.bytecode.object : contract.bytecode, args }))).contractAddress;
}
const read = (chain, safe, name, args = []) => d.read(chain, safe, 'Safe', name, args);
async function newSafe(chain, singleton, factory, owners, threshold, salt) {
  const initializer = encodeFunctionData({ abi: d.abi('Safe'), functionName: 'setup', args: [owners, BigInt(threshold), zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] });
  const receipt = await send(chain, A, factory, encodeFunctionData({ abi: d.abi('SafeProxyFactory'), functionName: 'createProxyWithNonce', args: [singleton, initializer, BigInt(salt)] }));
  return receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase()).map(log => decodeEventLog({ abi: factory.toLowerCase() === officialRuntime.contracts.factory.address.toLowerCase() ? parseAbi(['event ProxyCreation(address proxy,address singleton)']) : d.abi('SafeProxyFactory'), ...log, strict: false })).find(log => log.eventName === 'ProxyCreation').args.proxy;
}
async function execution(chain, safe, to, data, signers = [A, B], operation = 0) {
  const tx = buildSafeTransaction({ chainId: BigInt(profile.chains[chain].chainId), safe, to, data, operation, nonce: await read(chain, safe, 'nonce') });
  const owners = await read(chain, safe, 'getOwners'), threshold = Number(await read(chain, safe, 'getThreshold'));
  const approvals = await Promise.all(signers.map(async a => ({ owner: a.address, signature: await a.signTypedData(tx) })));
  return encodeSafeExecution(tx, await packEOAApprovals(tx, owners, threshold, approvals));
}
async function admin(chain, safe, method, args, signers) {
  return send(chain, C, safe, await execution(chain, safe, safe, encodeFunctionData({ abi: d.abi('Safe'), functionName: method, args }), signers));
}
try {
  await start('l1'); chains.l2 = chains.l1;
  d = new TreasuryDeployment({ ...chains, fees: { l1: '100000000000000000', l2: '100000000000000000' } }, artifacts);
  d.validate = async () => {};
  for (const owner of [A, B, C]) await rpc('l1', 'anvil_setBalance', [owner.address, toHex(100n * 10n ** 18n)]);
  const managers = [['l1', profile.registry, 0n], ['l2', profile.manager, BigInt(profile.rollupId)]];
  const fixture = JSON.parse(readFileSync('contracts/out/OwnerFixture.sol/ReadThroughManager.json'));
  for (const [chain, address, id] of managers) {
    const deployed = await deploy(chain, 'ReadThroughManager', [id], true);
    await rpc(chain, 'anvil_setCode', [address, await rpc(chain, 'eth_getCode', [deployed, 'latest'])]);
  }
  for (const [chain, address] of managers) await send(chain, A, address, encodeFunctionData({ abi: fixture.abi, functionName: 'setPeer', args: [chain === 'l1' ? profile.manager : profile.registry] }));
  for (const item of Object.values(officialRuntime.contracts)) await rpc('l1', 'anvil_setCode', [item.address, item.runtime]);
  const rawRpc = d.rpc.bind(d);
  d.rpc = async (chain, method, params = [], front = false) => {
    // This fixture models both logical chains on one EVM; their network IDs are
    // supplied per read, while signed transactions still select the Anvil ID.
    if (method === 'eth_chainId') return toHex(profile.chains[chain].chainId);
    if (chain === 'l2' && method === 'eth_getLogs' && params[0].topics?.[0] === keccak256(toHex('Created(uint256,address,bytes32)'))) {
      const logs = await rawRpc(chain, method, params, front);
      return logs.filter(log => evidence.transactions.some(tx => tx.chain === 'l2' && tx.hash === log.transactionHash));
    }
    if (method === 'eez_quoteFee') {
      // Exercise the production request validation and exact quote binding. This
      // response fixture supplies pricing only; Anvil executes the actual batch.
      assert(front); const [request, options] = params;
      assert(size(request.data) <= 65_536, 'quote fixture follows the deployed 64 KiB profile');
      const estimated = BigInt(await rpc(chain, 'eth_estimateGas', [request]));
      const gas = request.gas ?? toHex(estimated * 120n / 100n);
      const nonce = request.nonce ?? await rpc(chain, 'eth_getTransactionCount', [request.from, 'pending']);
      const quotes = options.transactionTypes.map(type => {
        const tx = { type, chainId: request.chainId, from: request.from.toLowerCase(), to: request.to.toLowerCase(),
          nonce, gas, value: request.value ?? '0x0', data: request.data.toLowerCase() };
        const requestHash = keccak256(toHex(JSON.stringify(Object.fromEntries(Object.keys(tx).sort().map(key => [key, tx[key]])))));
        evidence.feeQuotes.push({ chain, type, inputBytes: size(request.data), requestHash });
        return { type, gas, requestHash, estimatedFee: toHex(estimated * 2_000_000_000n),
          ...(type === '0x0' ? { gasPrice: toHex(2_000_000_000n) } : { maxFeePerGas: toHex(2_000_000_000n), maxPriorityFeePerGas: toHex(1_000_000_000n) }) };
      });
      return { version: 1, chainId: request.chainId, nonce, expiresAt: toHex(Math.floor(Date.now() / 1000) + 30), options: quotes };
    }
    if (chain === 'l2' && method === 'eth_getCode' && Object.values(officialRuntime.contracts).some(item => item.address.toLowerCase() === params[0].toLowerCase())) return '0x';
    return rawRpc(chain, method, params, front);
  };
  // The operator installs network infrastructure before any treasury is created.
  // This owned fixture scans from its genesis instead of the Chiado checkpoint.
  const network = new TreasuryNetworkDeployment(d.target, artifacts);
  network.validate = async () => {};
  network.findSharedInfrastructure = () => discoverSharedInfrastructure(network, 0n);
  const networkSteps = network.steps.bind(network);
  network.steps = state => networkSteps(state).map(step => ({ ...step, quoted: false }));
  let infrastructure = await network.start(C.address);
  while (infrastructure.completed.length < network.steps(infrastructure).length) {
    const step = network.steps(infrastructure)[infrastructure.completed.length];
    await rpc(step.chain, 'anvil_setChainId', [profile.chains[step.chain].chainId]);
    const prepared = await network.prepare(infrastructure, provider(step.chain, C));
    const receipt = await send(step.chain, C, prepared.pending.to, prepared.pending.data, 0n, true, prepared.request);
    infrastructure = await network.reconcile(readNetworkDeployment(JSON.stringify({ ...infrastructure, pending: { ...prepared.pending, hash: receipt.transactionHash } })));
    assert(!infrastructure.pending, 'operator step settles');
  }
  const binding = await network.binding(infrastructure);
  await verifySharedInfrastructure(d, binding);
  const asset = { tokenL1: binding.tokenL1, tokenL2: binding.tokenL2, bridgeL1: binding.bridgeL1, bridgeL2: binding.bridgeL2,
    tokenCodeHash: keccak256(await rpc('l1', 'eth_getCode', [binding.tokenL1, 'safe'])) };
  await verifyAssetInfrastructure(d, asset);
  record('dedicated operator predeploys, seeds, seals and registers both bridges before treasury creation');
  d.findSharedInfrastructure = () => discoverSharedInfrastructure(d, 0n);
  d.findAssetInfrastructure = async () => { await verifyAssetInfrastructure(d, asset); return asset; };
  await rpc('l1', 'anvil_setChainId', [profile.chains.l1.chainId]);
  const singletonL1 = await deploy('l1', 'Safe');
  const existingSafe = await newSafe('l1', singletonL1, officialRuntime.contracts.factory.address, [C.address], 1, 915);
  let state = await d.configure(C.address, getAddress(existingSafe));
  assert.equal(state.version, 11); assert.equal(d.steps(state).length, 5);
  assert(!state.grouping && !state.asset && !state.fundingSkipped);
  record('new setup starts directly with an existing L1 Safe and five transaction phases');
  evidence.phases = [];
  while (state.completed.length < d.steps(state).length) {
    const step = d.steps(state)[state.completed.length];
    await rpc(step.chain, 'anvil_setChainId', [profile.chains[step.chain].chainId]);
    if (step.safe) {
      state.review = await d.reviewStep(state);
      state.review.approvals.push(await d.approve(state, provider(step.chain, C)));
    }
    const prepared = await d.prepare(state, provider(step.chain, C));
    if (prepared.pending.group?.create) assert(size(prepared.pending.data) <= 49152);
    state = readDeployment(JSON.stringify({ ...state, pending: prepared.pending }));
    await assert.rejects(d.prepare(state, provider(step.chain, C)), /pending deployment/);
    const receipt = await send(step.chain, C, prepared.pending.to, prepared.pending.data, 0n, true, prepared.request);
    writeFileSync(directory + '/' + step.id + '.json', JSON.stringify({ pending: prepared.pending, receipt }, null, 2) + '\n');
    if (prepared.pending.group) {
      const broken = readDeployment(JSON.stringify({ ...state, pending: { ...state.pending, hash: receipt.transactionHash } }));
      broken.pending.group.actionsHash = keccak256(toHex('wrong action commitment'));
      await assert.rejects(d.reconcile(broken), /Missing matching deployment batch/);
      if (prepared.pending.group.outputs.length) {
        broken.pending.group.actionsHash = prepared.pending.group.actionsHash;
        broken.pending.group.outputs.pop();
        await assert.rejects(d.reconcile(broken), /Missing or duplicate batch outputs/);
      }
    }
    state = await d.reconcile(readDeployment(JSON.stringify({ ...state, pending: { ...state.pending, hash: receipt.transactionHash } })));
    assert(!state.pending, step.id + ' confirmed');
    evidence.phases.push({ id: step.id, chain: step.chain, inputBytes: size(prepared.pending.data), gasUsed: String(BigInt(receipt.gasUsed)), hash: receipt.transactionHash, outputs: prepared.pending.group?.outputs.map(o => o.key) ?? [] });
    writeFileSync(directory + '/state.json', JSON.stringify(state, null, 2) + '\n');
    if (step.id === 'contractsBatchL2') assert.equal(await d.read('l2', state.addresses.factoryL2, 'SafeProxyFactory', 'proxyCreationCode'), artifacts.contracts.SafeProxyFactory.proxyCreationCode);
    record(step.id + ' exact canonical receipt and outputs recovered after reload');
  }
  const a = { ...state.addresses, factoryL1: officialRuntime.contracts.factory.address };
  assert.deepEqual(await read('l1', a.safeL1, 'getOwners'), [C.address]);
  assert.deepEqual(await read('l2', a.safeL2, 'getOwners'), [a.adapter]);
  for (const chain of names) {
    const suffix = chain === 'l1' ? 'L1' : 'L2';
    assert.equal(await d.read(chain, a['bootstrap' + suffix], 'TreasuryBootstrap', 'closed'), true);
    assert.equal(await d.read(chain, a['bridge' + suffix], 'SharedTreasuryBridge', 'admin'), zeroAddress);
    assert.equal(await d.read(chain, a['token' + suffix], 'DevnetUSDC', 'balanceOf', [a['safe' + suffix]]), 0n);
    const allowance = await d.read(chain, a['module' + suffix], 'AllowanceModule', 'getTokenAllowance', [a['safe' + suffix], chain === 'l1' ? a.alias : a.policy, a['token' + suffix]]);
    assert.deepEqual(allowance.slice(0, 3), [100_000_000n, 0n, 10n]);
    assert.equal(await read(chain, a['safe' + suffix], 'isModuleEnabled', [a['bootstrap' + suffix]]), false);
  }
  assert.equal(await d.read('l1', a.tokenL1, 'DevnetUSDC', 'balanceOf', [a.bootstrapL1]), 0n);
  assert.equal(await d.read('l1', a.tokenL1, 'DevnetUSDC', 'allowance', [a.bootstrapL1, a.bridgeL1]), 0n);
  await admin('l1', a.safeL1, 'addOwnerWithThreshold', [B.address, 2n], [C]);
  const existingL2 = await newSafe('l2', a.singletonL2, a.factoryL2, [A.address, B.address], 2, 926);
  await admin('l2', existingL2, 'enableModule', [a.moduleL2], [A, B]);
  let reused = await d.configure(C.address, a.safeL1, existingL2);
  assert.equal(reused.addresses.adapter, a.adapter, 'reuse the verified adapter for the same original Safe');
  assert(!d.steps(reused).flatMap(s => s.group?.actions ?? [s]).some(s => s.output === 'adapter'));
  assert.equal(reused.addresses.moduleL2, a.moduleL2, 'reuse the already-enabled shared module');
  assert(!d.steps(reused).flatMap(s => s.group?.actions ?? [s]).some(s => s.output === 'moduleL2'));
  assert.equal(d.steps(reused).length, 6);
  evidence.existingSafePhases = [];
  while (reused.completed.length < d.steps(reused).length) {
    const step = d.steps(reused)[reused.completed.length];
    await rpc(step.chain, 'anvil_setChainId', [profile.chains[step.chain].chainId]);
    if (step.safe) {
      reused.review = await d.reviewStep(reused);
      assert.equal(reused.review.threshold, 2);
      for (const owner of [A, B, C].filter(account => reused.review.owners.some(address => address.toLowerCase() === account.address.toLowerCase())).slice(0, 2)) {
        reused.review.approvals.push(await d.approve(reused, provider(step.chain, owner)));
      }
    }
    const prepared = await d.prepare(reused, provider(step.chain, C));
    const receipt = await send(step.chain, C, prepared.pending.to, prepared.pending.data, 0n, true, prepared.request);
    reused = await d.reconcile(readDeployment(JSON.stringify({ ...reused, pending: { ...prepared.pending, hash: receipt.transactionHash } })));
    assert(!reused.pending);
    evidence.existingSafePhases.push({ id: step.id, hash: receipt.transactionHash });

  }
  assert.equal(reused.addresses.safeL1, a.safeL1);
  assert.equal(reused.addresses.safeL2, getAddress(existingL2));
  assert.equal(await read('l1', a.safeL1, 'getThreshold'), 2n);
  assert.deepEqual(await read('l2', existingL2, 'getOwners'), [reused.addresses.adapter]);
  record('existing 2-of-2 Safes retain addresses and L1 owners; old EEZ-X quorum approves adoption; L1 quorum approves both new allowance batches');
  let includedBeforeSafe = 0;
  advanceSafeHead = false;
  async function sharedSetup(account, withoutFunding = false) {
    await rpc('l1', 'anvil_setChainId', [profile.chains.l1.chainId]);
    const existingL1 = await newSafe('l1', a.singletonL1, a.factoryL1, [account.address], 1, BigInt(account.address) + (withoutFunding ? 1n : 0n));
    let next = await d.configure(account.address, existingL1);
    assert.equal(next.version, 11);
    const plan = d.steps(next), actions = plan.flatMap(s => s.group?.actions ?? [s]);
    for (const key of ['singletonL2', 'factoryL2', 'multiSendL2', 'moduleL2']) {
      assert.equal(next.addresses[key], a[key], `reuse shared ${key} across wallets`);
      assert(!actions.some(action => action.output === key), `no duplicate ${key} deployment`);
    }
    assert(!actions.some(s => ['tokenL1', 'bridgeL1', 'bridgeL2'].includes(s.output)));
    assert(!actions.some(s => s.method === 'claim' || s.method === 'registerBridges'));
    const supplyBeforeFunding = await d.read('l1', binding.tokenL1, 'SharedTestUSDC', 'totalSupply');
    const walletBeforeFunding = await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [account.address]);
    assert.equal(walletBeforeFunding, 0n, 'setup starts with no tokens in the wallet');
    next = readDeployment(JSON.stringify(next));
    assert(!d.steps(next).some(call => call.id === 'approveFunding'));
    while (next.completed.length < d.steps(next).length) {
      const step = d.steps(next)[next.completed.length];
      await rpc(step.chain, 'anvil_setChainId', [profile.chains[step.chain].chainId]);
      if (step.safe) {
        next.review = await d.reviewStep(next);
        next.review.approvals.push(await d.approve(next, provider(step.chain, account)));
      }
      const saved = JSON.stringify(next), signatures = calls.filter(method => method === 'eth_signTypedData_v4').length;
      next = readDeployment(saved);
      const prepared = await d.prepare(next, provider(step.chain, account));
      assert.equal(JSON.stringify(next), saved, 'preparing a quote preserves the saved setup and approvals');
      assert.equal(calls.filter(method => method === 'eth_signTypedData_v4').length, signatures, 'submission reuses the approved Safe step');
      if (step.id === 'budgetBatchL2') {
        assert(size(prepared.request.data) <= 65_536, 'budget batch fits the quote profile');
        assert(prepared.request.data.includes(artifacts.contracts.TreasuryPolicy.bytecode.slice(2)), 'quote includes the complete policy deployment');
        assert.equal(prepared.pending.safeHash, next.review.safeHash);
      }
      const receipt = await send(step.chain, account, prepared.pending.to, prepared.pending.data, 0n, true, prepared.request);
      next = await d.reconcile(readDeployment(JSON.stringify({ ...next, pending: { ...prepared.pending, hash: receipt.transactionHash } })));
      assert(!next.pending, step.id + ' wallet-funded step settled');
      const safeHead = await rpc(step.chain, 'eth_getBlockByNumber', ['safe', false]);
      if (BigInt(safeHead.number) < BigInt(receipt.blockNumber)) includedBeforeSafe++;
      assert.deepEqual(next.inclusions[receipt.transactionHash], { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
      if (step.id === 'fundingBatchL1') {
        assert.equal(await d.read('l1', binding.tokenL1, 'SharedTestUSDC', 'totalSupply'), supplyBeforeFunding, 'funding never mints');
        assert.equal(await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [account.address]), walletBeforeFunding);
        assert.equal(await d.read('l1', binding.tokenL1, 'ERC20', 'allowance', [account.address, next.addresses.bootstrapL1]), 0n);
        assert.equal(await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [next.addresses.bootstrapL1]), 0n);
      }
    }
    if (!withoutFunding) {
      // Explicit ordinary funding is outside the setup plan and its journal.
      await rpc('l1', 'anvil_setChainId', [profile.chains.l1.chainId]);
      await send('l1', account, binding.tokenL1, encodeFunctionData({ abi: d.abi('SharedTestUSDC'), functionName: 'claim', args: [] }));
      await send('l1', account, binding.tokenL1, encodeFunctionData({ abi: d.abi('ERC20'), functionName: 'transfer', args: [next.addresses.safeL1, 300_000_000n] }));
      await send('l1', account, binding.tokenL1, encodeFunctionData({ abi: d.abi('ERC20'), functionName: 'approve', args: [binding.bridgeL1, 150_000_000n] }));
      await send('l1', account, binding.bridgeL1, encodeFunctionData({ abi: d.abi('SharedTreasuryBridge'), functionName: 'bridgeTokens', args: [binding.tokenL1, 150_000_000n, BigInt(profile.rollupId), next.addresses.safeL2] }));
    }
    return next;
  }
  const firstShared = await sharedSetup(A), secondShared = await sharedSetup(B);
  const unfunded = await sharedSetup(A, true);
  for (const chain of names) {
    const suffix = chain === 'l1' ? 'L1' : 'L2', x = unfunded.addresses;
    assert.equal(await d.read(chain, x['token' + suffix], 'ERC20', 'balanceOf', [x['safe' + suffix]]), 0n);
    assert.equal(await d.read(chain, x['bootstrap' + suffix], 'TreasuryBootstrap', 'closed'), true);
    const allowance = await d.read(chain, x['module' + suffix], 'AllowanceModule', 'getTokenAllowance', [x['safe' + suffix], chain === 'l1' ? x.alias : x.policy, x['token' + suffix]]);
    assert.equal(allowance[0], 100_000_000n); assert.equal(allowance[1], 0n);
  }
  // This fixture shares one EVM across the two chain IDs. Only the client's
  // network identity check is replaced; manifest, owners, balances and allowance
  // reads below still execute against the real deployed contracts.
  const validateClient = TreasuryClient.prototype.validate;
  TreasuryClient.prototype.validate = async () => {};
  try {
    const manifest = await d.manifest(unfunded);
    assert.equal(manifest.safeL1, unfunded.addresses.safeL1);
    assert.equal(manifest.safeL2, unfunded.addresses.safeL2);
    await send('l1', C, binding.tokenL1, encodeFunctionData({ abi: d.abi('ERC20'), functionName: 'transfer', args: [unfunded.addresses.safeL1, 7_000_000n] }));
    await send('l1', C, binding.tokenL1, encodeFunctionData({ abi: d.abi('ERC20'), functionName: 'approve', args: [binding.bridgeL1, 3_000_000n] }));
    await send('l1', C, binding.bridgeL1, encodeFunctionData({ abi: d.abi('SharedTreasuryBridge'), functionName: 'bridgeTokens', args: [binding.tokenL1, 3_000_000n, 1n, unfunded.addresses.safeL2] }));
    assert.equal((await d.manifest(unfunded)).safeL1, manifest.safeL1, 'ordinary later funding does not invalidate setup');
  } finally { TreasuryClient.prototype.validate = validateClient; }
  record('setup without funding completes with an empty wallet and Safes, preserves progress, closes both executors and accepts later ordinary funding');
  advanceSafeHead = true;
  assert(includedBeforeSafe >= 7, 'setup must advance for real receipts while the safe head is behind');
  evidence.includedBeforeSafe = includedBeforeSafe;
  record('both direct setups complete with current-state Safe reviews before the safe checkpoint');
  for (const type of ['0x0', '0x2']) assert(evidence.feeQuotes.some(q => q.chain === 'l2' && q.type === type && q.inputBytes >= size(artifacts.contracts.TreasuryPolicy.bytecode)));
  record('legacy and type-2 budget batches retain approvals across reload and pass the real fee helper without truncating calldata');
  assert.deepEqual(secondShared.assetBinding, asset);
  record('both treasuries complete setup without token approvals or transfers; explicit funding stays separate');
  for (const key of ['tokenL1', 'tokenL2', 'bridgeL1', 'bridgeL2']) assert.equal(firstShared.addresses[key], secondShared.addresses[key]);
  for (const treasury of [firstShared, secondShared]) {
    const x = treasury.addresses;
    for (const chain of names) {
      const suffix = chain === 'l1' ? 'L1' : 'L2';
      assert.equal(await d.read(chain, x['bridge' + suffix], 'SharedTreasuryBridge', 'admin'), zeroAddress);
      assert.equal(await d.read(chain, x['token' + suffix], 'SharedTestUSDC', 'balanceOf', [x['safe' + suffix]]), chain === 'l1' ? 300_000_000n : 150_000_000n);
    }
  }
  record('two wallets create independent treasuries sharing one sealed bridge pair and one Test USDC asset');
  const bal = (chain, treasury, holder) => d.read(chain, treasury.addresses[chain === 'l1' ? 'tokenL1' : 'tokenL2'], 'SharedTestUSDC', 'balanceOf', [holder]);
  async function pay(treasury, account, onL1, amount, expectSuccess = true) {
    const x = treasury.addresses;
    await rpc('l2', 'anvil_setChainId', [profile.chains.l2.chainId]);
    const epoch = BigInt((await rpc('l2', 'eth_getBlockByNumber', ['latest', false])).timestamp) / 600n;
    const chain = onL1 ? 'l1' : 'l2', suffix = onL1 ? 'L1' : 'L2';
    const allowance = await d.read(chain, x['module' + suffix], 'AllowanceModule', 'getTokenAllowance',
      [x['safe' + suffix], onL1 ? x.alias : x.policy, x['token' + suffix]]);
    const balance = await bal(chain, treasury, x['safe' + suffix]);
    const remaining = allowance[0] > allowance[1] ? allowance[0] - allowance[1] : 0n;
    const capacity = balance < remaining ? balance : remaining, local = amount < capacity ? amount : capacity;
    const fromL1 = onL1 ? local : amount - local;
    const tx = buildSafeTransaction({ chainId: BigInt(profile.chains.l2.chainId), safe: x.safeL2, to: x.policy,
      data: encodeFunctionData({ abi: d.abi('TreasuryPolicy'), functionName: 'paySplit', args: [C.address, amount, onL1, epoch, fromL1] }), nonce: await read('l2', x.safeL2, 'nonce') });
    const signature = await account.signTypedData(tx);
    return send('l2', account, x.safeL2, encodeSafeExecution(tx, await packOwnerApprovals(tx, x.adapter, [account.address], 1, [{ owner: account.address, signature }])), 0n, expectSuccess);
  }
  await pay(unfunded, A, true, 2_000_000n);
  await pay(unfunded, A, false, 2_000_000n);
  assert.equal(await bal('l1', unfunded, unfunded.addresses.safeL1), 5_000_000n);
  assert.equal(await bal('l2', unfunded, unfunded.addresses.safeL2), 1_000_000n);
  record('a treasury set up without funding can pay on either chain after separate funding');
  const recipientL1Before = await bal('l1', firstShared, C.address), recipientL2Before = await bal('l2', firstShared, C.address);
  await pay(firstShared, A, true, 110_000_000n);
  assert.equal(await bal('l1', firstShared, C.address), recipientL1Before + 110_000_000n);
  assert.equal(await bal('l1', firstShared, firstShared.addresses.safeL1), 200_000_000n);
  assert.equal(await bal('l2', firstShared, firstShared.addresses.safeL2), 140_000_000n);
  assert.equal(await bal('l1', secondShared, secondShared.addresses.safeL1), 300_000_000n);
  await pay(secondShared, B, false, 110_000_000n);
  assert.equal(await bal('l2', secondShared, C.address), recipientL2Before + 110_000_000n);
  assert.equal(await bal('l1', secondShared, secondShared.addresses.safeL1), 290_000_000n);
  assert.equal(await bal('l2', secondShared, secondShared.addresses.safeL2), 50_000_000n);
  assert.equal(await bal('l1', firstShared, firstShared.addresses.bridgeL1), await d.read('l2', binding.tokenL2, 'WrappedToken', 'totalSupply'));
  record('110-token split payments in both directions preserve the other treasury and aggregate escrow backing');
  const snapshots = async () => {
    const out = [];
    for (const t of [firstShared, secondShared]) {
      const x = t.addresses;
      for (const chain of names) {
        const suffix = chain === 'l1' ? 'L1' : 'L2';
        out.push(String(await bal(chain, t, x['safe' + suffix])));
        out.push(String(await bal(chain, t, C.address)));
        out.push((await d.read(chain, x['module' + suffix], 'AllowanceModule', 'getTokenAllowance', [x['safe' + suffix], chain === 'l1' ? x.alias : x.policy, x['token' + suffix]])).map(String));
      }
      const epoch = BigInt((await rpc('l2', 'eth_getBlockByNumber', ['latest', false])).timestamp) / 600n;
      out.push(String(await d.read('l2', x.policy, 'TreasuryPolicy', 'spent', [epoch])));
    }
    return out;
  };
  const beforeReject = await snapshots();
  await pay(firstShared, A, false, 41_000_000n, false);
  assert.deepEqual(await snapshots(), beforeReject);
  record('shared-budget rejection changes neither treasury, recipient balance nor allowance counter');
  await rpc('l1', 'anvil_setChainId', [profile.chains.l1.chainId]);
  assert.equal(await d.read('l1', binding.tokenL1, 'SharedTestUSDC', 'claimed', [A.address]), true);
  await send('l1', A, binding.tokenL1, encodeFunctionData({ abi: d.abi('SharedTestUSDC'), functionName: 'claim' }), 0n, false);
  const faucet = new TreasuryFaucetDeployment(d.target, artifacts);
  faucet.validate = async () => {}; faucet.rpc = d.rpc.bind(d);
  let faucetState = { version: 2, identity: deploymentIdentity, deployer: A.address, salt: keccak256(toHex('repeat faucet')),
    reuse: {}, addresses: { tokenL1: binding.tokenL1 }, completed: [], transactions: [] };
  const claimEpoch = BigInt((await rpc('l1', 'eth_getBlockByNumber', ['latest', false])).timestamp) / 600n;
  const treasuryState = async () => Promise.all([firstShared, secondShared].flatMap(t => [
    bal('l1', t, t.addresses.safeL1), bal('l2', t, t.addresses.safeL2),
    d.read('l2', t.addresses.policy, 'TreasuryPolicy', 'spent', [claimEpoch]),
  ]).concat([d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [binding.bridgeL1]), d.read('l2', binding.tokenL2, 'WrappedToken', 'totalSupply')]));
  const beforeClaims = await treasuryState();
  const walletBeforeClaims = await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [A.address]);
  const supplyBeforeClaims = await d.read('l1', binding.tokenL1, 'SharedTestUSDC', 'totalSupply');
  for (let i = 0; i < 2; i++) {
    const prepared = await faucet.prepare(readDeployment(JSON.stringify(faucetState)), provider('l1', A));
    assert.equal(prepared.request.to, undefined);
    const receipt = await send('l1', A, undefined, prepared.request.data, 0n, true, prepared.request);
    const pending = readDeployment(JSON.stringify({ ...faucetState, pending: { ...prepared.pending, hash: receipt.transactionHash } }));
    faucetState = await faucet.reconcile(pending);
    assert.equal(faucetState.pending, undefined);
    assert.equal(faucetState.completed.length, i + 1);
    assert.equal(await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [A.address]), walletBeforeClaims + BigInt(i + 1) * 450_000_000n);
    assert.equal(await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [receipt.contractAddress]), 0n);
  }
  assert.equal(await d.read('l1', binding.tokenL1, 'SharedTestUSDC', 'totalSupply'), supplyBeforeClaims + 900_000_000n);
  assert.deepEqual(await treasuryState(), beforeClaims, 'faucet requests do not change treasury balances, budgets or bridge backing');
  record('an already-claimed wallet receives 450 twice through canonical, reloadable faucet requests using the same asset and bridges');
  evidence.repeatableFaucet = { wallet: A.address, token: binding.tokenL1, transactions: faucetState.transactions, balanceIncrease: '900000000' };
  const customAsset = { ...binding, tokenCodeHash: keccak256(await rpc('l1', 'eth_getCode', [binding.tokenL1, 'latest'])) };
  const requestChoice = { amount: '1000123456', recipient: C.address, destination: 'l2' };
  faucetState = faucet.selectRequest(faucetState, customAsset, requestChoice);
  const init = await faucet.prepare(faucetState, provider('l1', A));
  assert.equal(init.pending.id, 'faucetPrepare_2');
  const initialized = await send('l1', A, undefined, init.request.data);
  faucetState = await faucet.reconcile({ ...faucetState, pending: { ...init.pending, hash: initialized.transactionHash } });
  assert.equal(faucetState.faucetRequests[3].amount, requestChoice.amount);
  assert.equal(await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [faucetState.addresses.faucet]), 0n);
  for (const [destination, recipient, amount] of [['l2', C.address, '1000123456'], ['l1', B.address, '0.000001'], ['l2', C.address, '2.345678']]) {
    const units = amount === '1000123456' ? 1000123456n : amount === '0.000001' ? 1n : 2345678n;
    faucetState = faucet.selectRequest(faucetState, customAsset, { destination, recipient, amount: String(units) });
    const token = destination === 'l1' ? binding.tokenL1 : binding.tokenL2;
    const balance = await d.read(destination, token, 'ERC20', 'balanceOf', [recipient]);
    const locked = await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [binding.bridgeL1]);
    const prepared = await faucet.prepare(readDeployment(JSON.stringify(faucetState)), provider('l1', A));
    assert.equal(prepared.request.to.toLowerCase(), faucetState.addresses.faucet.toLowerCase());
    assert.equal(Boolean(prepared.expiresAt), destination === 'l2');
    const receipt = await send('l1', A, prepared.pending.to, prepared.pending.data, 0n, true, prepared.request);
    faucetState = await faucet.reconcile(readDeployment(JSON.stringify({ ...faucetState, pending: { ...prepared.pending, hash: receipt.transactionHash } })));
    assert.equal(faucetState.pending, undefined);
    assert.equal(await d.read(destination, token, 'ERC20', 'balanceOf', [recipient]), balance + units);
    assert.equal(await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [binding.bridgeL1]), locked + (destination === 'l2' ? units : 0n));
    assert.equal(await d.read('l1', binding.tokenL1, 'ERC20', 'balanceOf', [binding.bridgeL1]), await d.read('l2', binding.tokenL2, 'WrappedToken', 'totalSupply'));
  }
  assert.deepEqual((await treasuryState()).slice(0, 6), beforeClaims.slice(0, 6));
  record('configurable faucet reuses one dispenser, delivers exact decimals to funded recipients on both chains, and preserves treasury balances and budgets');
  evidence.configurableFaucet = { addresses: faucetState.addresses, requests: faucetState.faucetRequests, transactions: faucetState.transactions };

  evidence.networkPredeployment = { addresses: infrastructure.addresses, transactions: infrastructure.transactions };
  evidence.sharedInfrastructure = binding;
  evidence.unfundedTreasury = { version: unfunded.version, deployer: unfunded.deployer, addresses: unfunded.addresses, transactions: unfunded.transactions };
  evidence.sharedTreasuries = [firstShared, secondShared].map(s => ({ deployer: s.deployer, addresses: s.addresses, transactions: s.transactions }));
  evidence.verified = true;
  record('300/150 balances, 100/100 allowances, wallet bridge admins, closed executors, no executor Safe authority or residual funds');
} finally {
  writeFileSync(directory + '/summary.json', JSON.stringify(evidence, null, 2) + '\n');
  for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM');
  console.log('Evidence: ' + directory);
}
