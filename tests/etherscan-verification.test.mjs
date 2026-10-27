import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Etherscan } from '../scripts/verification/etherscan.mjs';
import { VerificationWorker, publicJob } from '../scripts/verification/worker.mjs';
const key = 'server-only-test-secret', address = '0x' + '12'.repeat(20);
const artifact = { target: 'A.sol:A', compiler: '0.8.34+commit.80d5c536', input: 'source',
  runtime: '0x60006000556001a164736f6c6343000822000a', immutables: [], immutableGroups: [] };
const input = { language: 'Solidity', sources: { 'A.sol': { content: 'contract A {}' } }, settings: { optimizer: { enabled: true, runs: 200 } } };
const missing = { status: '1', result: [{ SourceCode: '', ABI: 'Contract source code not verified', SimilarMatch: '' }] };
const full = { status: '1', result: [{ SourceCode: 'contract A {}', SimilarMatch: '' }] };
const guid = '1234567890abcdefghij';
function client(responses) {
  const calls = [], delays = [];
  const api = new Etherscan(async (url, options) => {
    calls.push({ url: new URL(url), options });
    const reply = responses.shift();
    if (reply instanceof Error) throw reply;
    return Response.json(reply);
  }, async ms => { delays.push(ms); });
  return { api, calls, delays };
}
test('Etherscan submits exact standard JSON and polls without exposing credentials in contract state', async () => {
  const { api, calls, delays } = client([missing, { status: '1', result: guid }, missing,
    { status: '0', result: 'Pending in queue' }, missing, { status: '1', result: 'Pass - Verified' }]);
  const contract = { address }; let saves = 0;
  const run = () => api.publish(key, 1, contract, artifact, input, 1000000, () => saves++);
  await run(); assert.equal(saves, 1); assert.equal(contract.status, 'pending'); assert.equal(contract.etherscanGuid, guid);
  await run(); assert.equal(contract.status, 'pending');
  await run(); assert.equal(contract.status, 'verified');
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  const submission = calls[1], body = new URLSearchParams(submission.options.body);
  assert.equal(submission.url.origin, 'https://api.etherscan.io');
  assert.equal(submission.url.pathname, '/v2/api');
  assert.equal(submission.url.searchParams.get('chainid'), '1');
  assert.equal(submission.url.searchParams.get('apikey'), key);
  assert.equal(submission.options.redirect, 'error');
  assert.deepEqual(JSON.parse(body.get('sourceCode')), input);
  assert.equal(body.get('contractname'), artifact.target);
  assert.equal(body.get('compilerversion'), 'v' + artifact.compiler);
  assert.equal(body.get('codeformat'), 'solidity-standard-json-input');
  assert(delays.slice(1).every(ms => ms > 0), 'requests are paced');
  assert(!JSON.stringify(contract).includes(key));
});
test('full address-specific sources succeed, but similar matches require publication', async () => {
  const exact = client([full]), contract = { address };
  await exact.api.publish(key, 1, contract, artifact, input, 1000000, () => {});
  assert.equal(contract.status, 'verified'); assert.equal(exact.calls.length, 1);
  for (const similar of [address, undefined]) {
    const { api } = client([{ status: '1', result: [{ SourceCode: 'contract A {}', SimilarMatch: similar }] }, { status: '1', result: guid }]);
    const pending = { address };
    await api.publish(key, 1, pending, artifact, input, 1000000, () => {});
    assert.equal(pending.status, 'pending');
  }
});
test('quota, authentication, transport and rejection responses never leak provider secrets or claim success', async () => {
  for (const responses of [
    [new Error('request failed: https://api.etherscan.io?apikey=' + key)],
    [{ status: '0', result: 'Invalid API Key ' + key }],
    [missing, { status: '0', result: 'Rate limit ' + key }],
    [missing, { status: '1', result: 'unexpected response' }],
  ]) {
    const { api } = client(responses), contract = { address };
    await assert.rejects(api.publish(key, 1, contract, artifact, input, 1000000, () => {}), e => !e.message.includes(key));
    assert.notEqual(contract.status, 'verified'); assert(!JSON.stringify(contract).includes(key));
  }
});
test('failed GUIDs are retried with backoff; a rate limit preserves pending GUIDs', async () => {
  const { api, calls } = client([missing, { status: '0', result: 'Fail - Unable to verify' }, missing]);
  const contract = { address, etherscanGuid: guid, etherscanSubmittedAt: 1000000 };
  await assert.rejects(api.publish(key, 1, contract, artifact, input, 1000010, () => {}));
  assert.equal(contract.etherscanGuid, undefined);
  await api.publish(key, 1, contract, artifact, input, 1000020, () => {});
  assert.equal(calls.length, 3, 'do not immediately resubmit failed sources');
  const limited = client([missing, { status: '0', result: 'Max rate limit reached' }]);
  contract.etherscanGuid = guid;
  await limited.api.publish(key, 1, contract, artifact, input, 1000030, () => {});
  assert.equal(contract.etherscanGuid, guid); assert.equal(contract.status, 'pending');
});
test('worker persists Etherscan polling across restarts and gates publication on exact canonical bytecode', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'eez-etherscan-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const build = 'ab'.repeat(32), blockHash = '0x' + '34'.repeat(32);
  let time = 1000000, code = artifact.runtime, block = blockHash, blockReads = 0, reorg = false;
  const replies = [missing, { status: '1', result: guid }, missing, { status: '1', result: 'Pass - Verified' }];
  const { api, calls } = client(replies);
  const config = { directory, now: () => time, builds: { [build]: { contracts: { A: artifact }, inputs: { source: input } } },
    networks: { 1: { rpc: 'https://rpc.invalid', etherscanKey: key, explorerApi: 'https://unused.invalid' } },
    fetcher: async (url, options) => {
      if (url.includes('sourcify')) return Response.json({ verificationId: 'sourcify-job', isJobCompleted: false });
      assert.equal(url, 'https://rpc.invalid', 'Blockscout must not bypass Etherscan');
      const { method } = JSON.parse(options.body);
      if (method === 'eth_getBlockByNumber' && ++blockReads === 3 && reorg) block = '0x' + '56'.repeat(32);
      return Response.json({ result: { eth_chainId: '0x1', eth_getCode: code,
        eth_getBlockByNumber: { number: '0x20', hash: block } }[method] });
    } };
  const worker = new VerificationWorker(config); worker.etherscan = api;
  const job = worker.enqueue({ build, chainId: 1, address });
  await worker.tick(); assert.equal(job.status, 'pending');
  const persisted = readFileSync(join(directory, job.id + '.json'), 'utf8');
  assert(persisted.includes(guid)); assert(!persisted.includes(key));
  assert(!JSON.stringify(publicJob(job)).includes(key));
  const resumed = new VerificationWorker(config); resumed.etherscan = api; time += 16000;
  await resumed.tick(); assert.equal(resumed.jobs.get(job.id).status, 'verified');
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  replies.push(full); reorg = true; blockReads = 0;
  resumed.retry(job.id); await resumed.tick();
  assert.equal(resumed.jobs.get(job.id).status, 'retrying');
  assert.equal(publicJob(resumed.jobs.get(job.id)).contracts[0].status, 'rechecking');
  reorg = false; block = blockHash;
  code = code.slice(0, -2) + 'ff'; resumed.retry(job.id); await resumed.tick();
  assert.equal(resumed.jobs.get(job.id).status, 'source-unavailable'); assert.equal(calls.length, 5);
});
test('the API key is wired only into the verification container and not frontend configuration', () => {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  assert.equal(compose.split('ETHERSCAN_API_KEY: "${ETHERSCAN_API_KEY:-}"').length, 2);
  assert(compose.slice(compose.indexOf('\n  verification:')).includes('ETHERSCAN_API_KEY'));
  assert(!readFileSync('src/config.ts', 'utf8').includes('ETHERSCAN_API_KEY'));
});
