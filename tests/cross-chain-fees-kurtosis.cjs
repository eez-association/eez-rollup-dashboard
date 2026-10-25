// Real dashboard-to-settlement tests on disposable Kurtosis chains only.
// The injected EIP-1193 fixture signs locally; this does not test wallet extensions.
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { chromium } = require('playwright');
const { encodeAbiParameters, encodeFunctionData, parseAbi, keccak256, toHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const required = name => { assert(process.env[name], `${name} is required`); return process.env[name]; };
const base = required('EEZ_UI_URL').replace(/\/$/, '');
const output = required('EEZ_UI_FEE_EVIDENCE_FILE');
const account = privateKeyToAccount(required('EEZ_TEST_FEE_KEY'));
const chains = {
  l1: { id: 7331, rpc: required('EEZ_DEVNET_L1_RPC'), front: required('EEZ_DEVNET_L1_FRONT') },
  l2: { id: 696990, rpc: required('EEZ_DEVNET_L2_RPC'), front: required('EEZ_DEVNET_L2_FRONT') },
};
const valueBytecode = JSON.parse(readFileSync(required('EEZ_VALUE_ARTIFACT'), 'utf8')).bytecode.object;
const recipient = '0x8888888888888888888888888888888888888888';
const refundRecipient = '0x5555555555555555555555555555555555555555';
const l2FeeRecipient = '0x4444444444444444444444444444444444444444';
const evidence = { verified: false, wallet: 'injected fixture adapter', scenarios: [], fixtures: {} };
const checkpoint = () => writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
const hex = value => `0x${BigInt(value).toString(16)}`;
const calldata = (signature, args = []) => encodeFunctionData({ abi: parseAbi([`function ${signature}`]), args });
let id = 0;
async function rpc(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
  assert(response.ok, `RPC HTTP ${response.status}`);
  const result = await response.json();
  assert(!result.error, `${method}: ${JSON.stringify(result.error)}`);
  return result.result;
}
async function until(label, check, seconds = 240) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
async function receipt(url, hash) {
  const result = await until(`receipt ${hash}`, () => rpc(url, 'eth_getTransactionReceipt', [hash]));
  assert.equal(result.status, '0x1', `reverted ${hash}`);
  return result;
}
async function sign(tx) {
  return account.signTransaction({ chainId: Number(BigInt(tx.chainId)), nonce: Number(BigInt(tx.nonce)),
    to: tx.to ?? undefined, data: tx.data, gas: BigInt(tx.gas), value: BigInt(tx.value ?? '0x0'),
    ...(tx.type === '0x0' ? { type: 'legacy', gasPrice: BigInt(tx.gasPrice) }
      : { type: 'eip1559', maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }) });
}
async function ordinary(chain, to, data = '0x') {
  const [nonce, block] = await Promise.all([
    rpc(chain.rpc, 'eth_getTransactionCount', [account.address, 'pending']),
    rpc(chain.rpc, 'eth_getBlockByNumber', ['latest', false]),
  ]);
  const raw = await sign({ chainId: hex(chain.id), nonce, to, data, gas: hex(8_000_000),
    maxPriorityFeePerGas: hex(1_000_000_000), maxFeePerGas: hex(2n * BigInt(block.baseFeePerGas) + 1_000_000_000n) });
  return receipt(chain.rpc, await rpc(chain.front, 'eth_sendRawTransaction', [raw]));
}
async function settledL2(blockNumber, seconds = 240) {
  return until('canonical L2 state', async () => {
    const safe = await rpc(chains.l2.rpc, 'eth_getBlockByNumber', ['safe', false]);
    return safe && BigInt(safe.number) >= BigInt(blockNumber);
  }, seconds);
}
async function fixture(source, config) {
  const destination = source === 'l1' ? 'l2' : 'l1';
  const deployed = await ordinary(chains[destination], undefined,
    valueBytecode + encodeAbiParameters([{ type: 'uint256' }], [0n]).slice(2));
  const target = deployed.contractAddress;
  assert(target, 'Value fixture deployed');
  const manager = source === 'l1' ? config.l1ContractAddress : config.l2ContractAddress;
  const remoteId = source === 'l1' ? BigInt(config.rollupId) : 0n;
  const encoded = await rpc(chains[source].rpc, 'eth_call', [{ to: manager,
    data: calldata('computeCrossChainProxyAddress(address,uint64) view returns (address)', [target, remoteId]) }, 'latest']);
  const proxy = `0x${encoded.slice(-40)}`;
  const creation = await ordinary(chains[source], manager, calldata('createCrossChainProxy(address,uint64)', [target, remoteId]));
  await settledL2(source === 'l2' ? creation.blockNumber : deployed.blockNumber);
  assert.notEqual(await rpc(chains[source].rpc, 'eth_getCode', [proxy, 'latest']), '0x');
  return { target, proxy };
}

(async () => {
  // Check every signing/broadcast route before deploying or sending fixture funds.
  for (const chain of Object.values(chains)) for (const url of [chain.rpc, chain.front]) {
    assert.equal(Number(BigInt(await rpc(url, 'eth_chainId'))), chain.id, 'private Kurtosis chains only');
  }
  const config = await (await fetch(`${base}/config.json`)).json();
  assert.equal(config.l1FeesEnabled, true); assert.equal(config.l2FeesEnabled, true);
  for (const [source, chain] of Object.entries(chains)) {
    const uiFront = new URL(config[`${source}FrontUrl`], base).href;
    assert.equal(Number(BigInt(await rpc(uiFront, 'eth_chainId'))), chain.id);
    assert(BigInt(await rpc(chain.rpc, 'eth_getBalance', [account.address, 'latest'])) > 10n ** 18n);
  }
  const warmup = await ordinary(chains.l2, account.address);
  console.log('Waiting for initial canonical settlement and fresh PBS validator registration');
  await settledL2(warmup.blockNumber, 600);
  for (const source of ['l1', 'l2']) evidence.fixtures[source] = await fixture(source, config);
  checkpoint();
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const cases = ['l1', 'l2'].flatMap(source => [
      { source, wallet: 'Rabby', kind: 'call' },
      { source, wallet: 'MetaMask', kind: 'call' },
      { source, wallet: 'MetaMask', kind: 'bridge' },
    ]);
    for (const [index, test] of cases.entries()) {
      const { source, wallet, kind } = test;
      const destination = source === 'l1' ? 'l2' : 'l1';
      const chain = chains[source], remote = chains[destination];
      const target = evidence.fixtures[source];
      const expected = BigInt(991 + index);
      const data = calldata('setValue(uint256)', [expected]);
      const remoteBalance = BigInt(await rpc(remote.rpc, 'eth_getBalance', [recipient, 'latest']));
      const context = await browser.newContext(), page = await context.newPage();
      const quotes = [], sends = [], errors = [];
      const record = { ...test, sends, quotes: [] };
      evidence.scenarios.push(record); checkpoint();
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        const request = response.request();
        if (request.method() === 'POST' && request.postDataJSON()?.method === 'eez_quoteFee') {
          quotes.push(response.json());
        }
      });
      let selectedChain = hex(chain.id);
      await page.exposeBinding('fixtureWalletRequest', async (_origin, { method, params = [] }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account.address];
        if (method === 'eth_chainId') return selectedChain;
        if (method === 'wallet_addEthereumChain') return null;
        if (method === 'wallet_switchEthereumChain') {
          assert.equal(Number(BigInt(params[0].chainId)), chain.id);
          selectedChain = params[0].chainId; return null;
        }
        if (method === 'eth_sendTransaction') {
          assert.equal(sends.length, 0, 'one ordinary wallet signature per action');
          const tx = params[0];
          assert.equal(tx.from.toLowerCase(), account.address.toLowerCase());
          assert.equal(Number(BigInt(tx.chainId)), chain.id);
          assert.equal(tx.type, wallet === 'Rabby' && chain.id !== 1 ? '0x0' : '0x2');
          if (kind === 'call') { assert.equal(tx.to.toLowerCase(), target.proxy); assert.equal(tx.data, data); }
          const raw = await sign(tx);
          const entry = { transaction: tx, hash: keccak256(raw) };
          sends.push(entry); checkpoint();
          assert.equal(await rpc(chain.front, 'eth_sendRawTransaction', [raw]), entry.hash);
          return entry.hash;
        }
        assert(/^eth_(get|call|estimate|maxPriority|gasPrice)/.test(method), `unexpected wallet method ${method}`);
        return rpc(chain.front, method, params);
      });
      await page.addInitScript(({ target, source, wallet }) => {
        localStorage.setItem(source === 'l1' ? 'crossChainProxies' : 'crossChainProxiesL2',
          JSON.stringify({ [target.target.toLowerCase()]: target.proxy }));
        window.ethereum = { isRabby: wallet === 'Rabby', isMetaMask: wallet === 'MetaMask',
          on() {}, removeListener() {}, request: request => window.fixtureWalletRequest(request) };
      }, { target, source, wallet });
      try {
        await page.goto(`${base}/#/bridge`);
        await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
        await page.getByRole('button', { name: wallet, exact: true }).click();
        if (kind === 'call') {
          const panel = page.getByRole('region', { name: 'Cross-chain contracts', exact: true });
          await panel.getByRole('button', { name: `Select proxy for ${target.target.toLowerCase()} on ${source.toUpperCase()}`, exact: true }).click();
          await panel.getByLabel('Calldata', { exact: true }).fill(data);
          await panel.getByRole('button', { name: 'Send Cross-Chain Transaction', exact: true }).click();
        } else {
          // A fresh bridge form starts L1 -> L2 independently of the wallet's
          // initial chain. Select the transfer direction as a user would.
          if (source === 'l2') await page.getByTitle('Swap direction').click();
          await page.getByLabel('Bridge amount', { exact: true }).fill('0.001');
          await page.getByRole('button', { name: 'Change recipient', exact: true }).click();
          await page.getByLabel('Recipient address', { exact: true }).fill(recipient);
          await page.getByRole('button', { name: 'Bridge ETH', exact: true }).click();
        }
        await until('wallet submission', async () => {
          const failure = await page.getByRole('dialog').getByRole('alert').allTextContents();
          assert(!failure.length, failure.join('\n'));
          return sends[0]?.hash;
        });
        assert(quotes.length >= 1);
        record.quotes = await Promise.all(quotes);
        const quote = record.quotes.at(-1).result;
        assert(quote, JSON.stringify(record.quotes[0]));
        const tx = sends[0].transaction, option = quote.options.find(option => option.type === tx.type);
        for (const field of ['type', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) assert.equal(tx[field], option[field], field);
        for (const field of ['chainId', 'nonce']) assert.equal(tx[field], quote[field], field);
        const binding = Object.fromEntries(['chainId', 'data', 'from', 'gas', 'nonce', 'to', 'type', 'value'].map(field => [field, tx[field]]));
        assert.equal(keccak256(toHex(JSON.stringify(binding))), option.requestHash);
        assert(BigInt(tx.gas) * BigInt(tx.gasPrice ?? tx.maxFeePerGas) <= BigInt(config[`${source}FeeMaxTotalWei`]));
        const ownership = await until('canonical source consumption', async () => {
          const state = await rpc(chain.front, 'eez_getCrossChainTransaction', [sends[0].hash]);
          return state?.ownership?.canonical ? state : null;
        });
        assert.equal(ownership.ownership.reason, 'Committed');
        const sourceReceipt = await receipt(chain.rpc, sends[0].hash);
        const block = await rpc(chain.rpc, 'eth_getBlockByNumber', [sourceReceipt.blockNumber, true]);
        assert.equal(block.hash, sourceReceipt.blockHash);
        const paid = BigInt(sourceReceipt.effectiveGasPrice);
        const tip = BigInt(sourceReceipt.gasUsed) * (paid - BigInt(block.baseFeePerGas));
        assert(tip > 0n);
        assert.equal(paid, tx.type === '0x0' ? BigInt(tx.gasPrice)
          : (BigInt(tx.maxFeePerGas) < BigInt(block.baseFeePerGas) + BigInt(tx.maxPriorityFeePerGas)
            ? BigInt(tx.maxFeePerGas) : BigInt(block.baseFeePerGas) + BigInt(tx.maxPriorityFeePerGas)));
        let postingHash, income;
        if (source === 'l1') {
          const sourceIndex = Number(BigInt(sourceReceipt.transactionIndex));
          const posts = block.transactions.slice(0, sourceIndex).filter(tx => tx.type === '0x3'
            && tx.to?.toLowerCase() === config.l1ContractAddress.toLowerCase());
          assert.equal(posts.length, 1, 'native blob post before L1 source');
          postingHash = posts[0].hash;
          const payouts = block.transactions.slice(sourceIndex + 1).filter(tx => tx.from.toLowerCase() === block.miner.toLowerCase()
            && tx.to?.toLowerCase() === refundRecipient && tx.input === '0x' && BigInt(tx.value) > 0n);
          assert.equal(payouts.length, 1, 'builder refund after L1 source');
          record.refundReceipt = await receipt(chains.l1.rpc, payouts[0].hash);
          income = BigInt(payouts[0].value);
        } else {
          assert.equal(block.miner.toLowerCase(), l2FeeRecipient);
          record.settlement = await until('canonical L2 settlement mapping', async () => {
            const mapping = await rpc(chain.front, 'eez_getSettlementByL2Block', [sourceReceipt.blockHash]);
            return mapping?.canonicalL2 ? mapping : null;
          });
          postingHash = record.settlement.l1TransactionHash;
          income = tip;
        }
        const post = await receipt(chains.l1.rpc, postingHash);
        assert.equal(post.type, '0x3'); assert(BigInt(post.blobGasUsed) > 0n);
        assert.equal((await rpc(chains.l1.rpc, 'eth_getBlockByNumber', [post.blockNumber, false])).hash, post.blockHash);
        const cost = BigInt(post.gasUsed) * BigInt(post.effectiveGasPrice) + BigInt(post.blobGasUsed) * BigInt(post.blobGasPrice);
        assert(income >= cost, 'private parity fixture covers native posting and blob cost');
        const blockTag = destination === 'l2' ? 'safe' : 'latest';
        await until('canonical destination effect', async () => kind === 'call'
          ? BigInt(await rpc(remote.rpc, 'eth_call', [{ to: target.target, data: calldata('value() view returns (uint256)') }, blockTag])) === expected
          : BigInt(await rpc(remote.rpc, 'eth_getBalance', [recipient, blockTag])) === remoteBalance + 10n ** 15n);
        assert.deepEqual(errors, []);
        await page.getByRole('dialog').getByRole('heading', { name: kind === 'call' ? 'Cross-chain call confirmed' : 'Bridge transaction confirmed', exact: true }).waitFor();
        Object.assign(record, { verified: true, ownership, sourceReceipt, post, userTip: String(tip),
          recovered: String(income), postingCost: String(cost), surplus: String(income - cost) });
        checkpoint();
        console.log(JSON.stringify({ source, wallet, kind, hash: sends[0].hash, verified: true }));
      } catch (error) {
        record.error = error.message; record.quotes = await Promise.all(quotes); checkpoint();
        await page.screenshot({ path: `${output}.${source}-${wallet}-${kind}.failure.png`, fullPage: true });
        throw error;
      } finally { await context.close(); }
    }
    evidence.verified = true; checkpoint();
    console.log(JSON.stringify({ verified: true, scenarios: evidence.scenarios.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
