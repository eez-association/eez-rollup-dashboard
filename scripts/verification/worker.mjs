import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeEventLog, parseAbi, isAddress, keccak256 } from 'viem';
import { matchesRuntime } from '../../src/lib/treasury/runtimeCode.ts';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const digest = x => typeof x === 'string' && /^0x[\da-f]{64}$/i.test(x);
const buildId = x => typeof x === 'string' && /^[\da-f]{64}$/.test(x);
const abi = parseAbi([
  'event Created(uint256 indexed index,address indexed target,bytes32 initHash)',
  'event ProxyCreation(address indexed proxy,address singleton)',
  'event CrossChainProxyCreated(address indexed proxy,address indexed originalAddress,uint64 indexed originalRollupId)',
  'event WrappedTokenDeployed(address indexed wrappedToken,address indexed originalToken,uint64 indexed originalRollupId)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const oldProxy = parseAbi(['event ProxyCreation(address proxy,address singleton)']);
export function creations(receipt) {
  const addresses = new Map();
  const add = (address, required) => { if (isAddress(address) && BigInt(address) > 0n) addresses.set(address.toLowerCase(), required || addresses.get(address.toLowerCase()) || false); };
  if (receipt.contractAddress) add(receipt.contractAddress, true);
  for (const log of receipt.logs ?? []) for (const events of [abi, oldProxy]) {
    try {
      const { eventName, args } = decodeEventLog({ abi: events, ...log });
      if (eventName === 'Created') add(args.target, true);
      if (['ProxyCreation','CrossChainProxyCreated'].includes(eventName)) add(args.proxy, true);
      if (eventName === 'WrappedTokenDeployed') add(args.wrappedToken, true);
      // Claim constructors forward ERC-20 allocations before returning code.
      // Previously existing token participants are filtered against the parent.
      if (eventName === 'Transfer') { add(args.from, false); add(args.to, false); }
      break;
    } catch { /* Different event layout. */ }
  }
  return [...addresses].map(([address, required]) => ({ address, required }));
}
export class VerificationWorker {
  constructor({ directory, builds, networks, additionalSources = [], fetcher = fetch, now = Date.now, capacity = 10000 }) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw new Error('Invalid verification capacity');
    Object.assign(this, { directory, builds, networks, additionalSources, fetcher, now, capacity });
    mkdirSync(directory, { recursive: true }); this.jobs = new Map(); this.active = false;
    for (const name of readdirSync(directory).filter(n => /^[a-f\d]{64}\.json$/.test(n))) {
      const job = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      this.validate(job.request, false); this.jobs.set(job.id, job);
    }
  }
  validate(r, configured = true) {
    if (!r || !buildId(r.build) || !digest(r.transactionHash)
      || !Number.isSafeInteger(r.chainId) || r.chainId <= 0 || configured && (!this.builds[r.build] || !this.networks[r.chainId])) throw new Error('Unknown build, network or transaction');
  }
  save(job) {
    job.updatedAt = this.now();
    const path = join(this.directory, `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job)); renameSync(`${path}.tmp`, path); this.jobs.set(job.id, job);
  }
  retry(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown verification job');
    if (this.processing !== id) { job.nextAttempt = 0; job.attempts = 0; this.save(job); }
    return job;
  }
  enqueue(request) {
    this.validate(request);
    const r = { build: request.build, chainId: request.chainId, transactionHash: request.transactionHash.toLowerCase() };
    const id = hash(r); if (this.jobs.has(id)) return this.jobs.get(id);
    // Completed results are a bounded cache, not unfinished work. A later
    // delivery rechecks the canonical receipt and explorer if a result expired.
    const completed = [...this.jobs.values()].filter(j => j.id !== this.processing && ['verified','reverted','not-applicable'].includes(j.status))
      .sort((a,b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    while (this.jobs.size >= this.capacity && completed.length) {
      const old = completed.shift();
      rmSync(join(this.directory, `${old.id}.json`), { force: true }); this.jobs.delete(old.id);
    }
    if (this.jobs.size >= this.capacity) throw new Error('Verification queue is full');
    const job = { id, request: r, status: 'queued', attempts: 0, nextAttempt: 0, contracts: [] };
    this.save(job); return job;
  }
  async admit(request) {
    this.validate(request);
    const identity = { build: request.build, chainId: request.chainId, transactionHash: request.transactionHash.toLowerCase() };
    const existing = this.jobs.get(hash(identity)); if (existing) return existing;
    const network = this.networks[request.chainId];
    if (BigInt(await this.rpc(network, 'eth_chainId')) !== BigInt(request.chainId)) throw new Error('Verification network changed');
    const receipt = await this.rpc(network, 'eth_getTransactionReceipt', [request.transactionHash]);
    if (!receipt || receipt.status !== '0x1') throw new Error('Wait for a successful canonical receipt');
    const block = await this.rpc(network, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (block?.hash !== receipt.blockHash) throw new Error('Wait for a canonical receipt');
    const contracts = await this.discover(network, receipt);
    const manifest = this.builds[request.build];
    const candidates = [...Object.values(manifest.contracts), ...Object.values(manifest.dependencies ?? {}), ...this.additionalSources];
    const current = await this.rpc(network, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (current?.hash !== receipt.blockHash) throw new Error('Wait for a canonical receipt');
    // Configuration-only confirmations and unrelated creations must not use
    // persistent capacity. Unknown factory metadata remains visible to the
    // requesting browser, without granting arbitrary transactions queue access.
    if (!contracts.some(c => candidates.some(a => matchesRuntime(c.runtime, a)))) {
      return { id: hash(identity), request: identity, status: contracts.length ? 'source-unavailable' : 'not-applicable',
        contracts: contracts.map(c => ({ ...c, status: 'source-unavailable', error: 'No exact compiler input for this deployed bytecode' })) };
    }
    return this.enqueue(identity);
  }
  async discover(network, receipt) {
    const number = BigInt(receipt.blockNumber);
    if (number < 1n) throw new Error('Invalid deployment block');
    const parent = `0x${(number - 1n).toString(16)}`;
    const discovered = creations(receipt), contracts = [];
    if (discovered.length > 128) throw new Error('Too many contract candidates in one transaction');
    for (const c of discovered) {
      const code = await this.rpc(network, 'eth_getCode', [c.address, receipt.blockNumber]);
      if (code === '0x') { if (c.required) throw new Error('Deployed code is not available yet'); else continue; }
      // Event signatures alone do not prove creation: arbitrary contracts can
      // emit them naming an already deployed, otherwise matching Safe.
      if (await this.rpc(network, 'eth_getCode', [c.address, parent]) !== '0x') continue;
      contracts.push({ address: c.address, runtime: code, codeHash: keccak256(code), status: 'pending' });
    }
    return contracts;
  }
  async json(url, options = {}) {
    const response = await this.fetcher(url, { ...options, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Verification service HTTP ${response.status}`);
    return response.json();
  }
  rpc(network, method, params = []) {
    return this.json(network.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      .then(body => { if (body.error || body.result === undefined) throw new Error('Verification RPC unavailable'); return body.result; });
  }
  async verifyContract(job, contract, network, manifest, receipt) {
    let info;
    if (network.explorerApi) {
      try {
        info = await this.json(`${network.explorerApi}/v2/smart-contracts/${contract.address}`);
        if (info.is_verified === true && info.is_partially_verified === false && info.deployed_bytecode?.toLowerCase() === contract.runtime.toLowerCase()) {
          contract.explorer = 'verified'; contract.status = 'verified';
          if (typeof info.name === 'string') contract.name = info.name;
          delete contract.error; return;
        }
      } catch (e) { contract.error = e.message; }
    }
    const candidates = [...Object.values(manifest.contracts), ...Object.values(manifest.dependencies ?? {}), ...this.additionalSources];
    const a = candidates.find(candidate => matchesRuntime(contract.runtime, candidate));
    if (!a) { contract.status = 'source-unavailable'; contract.error = 'No exact compiler input for this deployed bytecode'; return; }
    contract.name = a.target.split(':').at(-1); contract.input = a.input; contract.status = 'pending';
    const input = a.sourceInput ?? manifest.inputs[a.input]; if (!input) throw new Error('Missing retained compiler input');
    // Only address-specific, full explorer verification is success. A twin,
    // queued response, partial match or HTTP 200 is insufficient.
    if (network.explorerApi) {
      try {
        if (info?.is_partially_verified === true) contract.explorer = 'partial';
        const last = contract.submittedAt ?? 0;
        if (this.now() - last >= 15 * 60_000 || !last) {
          const data = new FormData(); data.append('files[0]', new Blob([JSON.stringify(input)], { type: 'application/json' }), 'input.json');
          data.append('compiler_version', `v${a.compiler}`); data.append('contract_name', a.target);
          data.append('autodetect_constructor_args', 'true');
          await this.json(`${network.explorerApi}/v2/smart-contracts/${contract.address}/verification/via/standard-input`, { method: 'POST', body: data });
          contract.submittedAt = this.now(); contract.explorer = 'pending'; this.save(job);
        }
      } catch (e) { contract.error = e.message; contract.explorer = 'retrying'; }
    }
    if ([1, 10200].includes(job.request.chainId)) {
      try {
        if (!contract.sourcifyJob && contract.sourcify !== 'exact_match') {
          const r = await this.json(`https://sourcify.dev/server/v2/verify/${job.request.chainId}/${contract.address}`, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stdJsonInput: input, compilerVersion: a.compiler,
              contractIdentifier: a.target, creationTransactionHash: job.request.transactionHash }) });
          if (!r.verificationId) throw new Error('Sourcify did not return a verification job');
          contract.sourcifyJob = r.verificationId; this.save(job);
        }
        if (contract.sourcifyJob) {
          const result = await this.json(`https://sourcify.dev/server/v2/verify/${contract.sourcifyJob}`);
          if (result.isJobCompleted) {
            const match = result.contract?.runtimeMatch;
            contract.sourcify = match ?? 'failed'; contract.sourcifyCreation = result.contract?.creationMatch ?? null;
            if (match !== 'exact_match') delete contract.sourcifyJob;
          }
        }
        if (contract.sourcify === 'exact_match') contract.status = 'sourcify-verified';
      } catch (e) { contract.error = e.message; }
    }
    // A public provider's result does not establish chain canonicality.
    const current = await this.rpc(network, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (current?.hash !== receipt.blockHash) throw new Error('Deployment block changed; rechecking verification');
  }
  async process(job) {
    const network = this.networks[job.request.chainId], manifest = this.builds[job.request.build];
    if (BigInt(await this.rpc(network, 'eth_chainId')) !== BigInt(job.request.chainId)) throw new Error('Verification RPC has a different chain ID');
    const receipt = await this.rpc(network, 'eth_getTransactionReceipt', [job.request.transactionHash]);
    if (!receipt) throw new Error('Waiting for canonical deployment receipt');
    const block = await this.rpc(network, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!block?.hash || block.hash !== receipt.blockHash) throw new Error('Waiting for canonical deployment block');
    if (receipt.status !== '0x1') { job.status = 'reverted'; job.contracts = []; return; }
    const discovered = await this.discover(network, receipt);
    const next = discovered.map(c => (job.blockHash === receipt.blockHash
      ? job.contracts.find(old => old.address === c.address && old.runtime === c.runtime) : null) ?? c);
    job.blockHash = receipt.blockHash; job.blockNumber = receipt.blockNumber; job.contracts = next;
    for (const contract of job.contracts) await this.verifyContract(job, contract, network, manifest, receipt);
    const current = await this.rpc(network, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (current?.hash !== receipt.blockHash) throw new Error('Deployment block changed; rechecking verification');
    job.status = !job.contracts.length ? 'not-applicable' : job.contracts.every(c => c.status === 'verified') ? 'verified'
      : job.contracts.some(c => c.status === 'source-unavailable') ? 'source-unavailable'
      : job.contracts.every(c => ['verified','sourcify-verified'].includes(c.status)) ? 'sourcify-verified' : 'pending';
    delete job.error;
  }
  async tick() {
    if (this.active) return; this.active = true;
    try {
      const job = [...this.jobs.values()].filter(j => j.nextAttempt <= this.now() && this.builds[j.request.build] && this.networks[j.request.chainId]).sort((a,b) => a.nextAttempt - b.nextAttempt)[0];
      if (!job) return;
      this.processing = job.id;
      job.attempts++;
      try { await this.process(job); } catch (e) { job.status = 'retrying'; job.error = e.message; }
      // One owner executes bounded work. Completed jobs are rechecked for reorgs;
      // provider outages never create more concurrent requests or lose a job.
      const awaitingExplorer = job.contracts.some(c => c.explorer === 'pending');
      job.nextAttempt = this.now() + (['verified','reverted','not-applicable','source-unavailable'].includes(job.status) ? 24 * 60 * 60_000
        : awaitingExplorer && job.status !== 'retrying' ? 15_000 : Math.min(5 * 60_000, 15_000 * 2 ** Math.min(job.attempts - 1, 8)));
      this.save(job);
    } finally { delete this.processing; this.active = false; }
  }
}
export function loadBuilds(root) {
  const entries = readdirSync(root).filter(buildId).map(build => {
    const m = JSON.parse(readFileSync(join(root, build, 'manifest.json'), 'utf8'));
    if (m.build !== build || hash(m.identity) !== build) throw new Error('Verification release identity mismatch');
    const artifacts = Object.fromEntries(Object.entries(m.contracts).map(([n,{input,...a}]) => [n,a]));
    if (m.dependencies && hash(m.dependencies) !== m.identity.dependencies) throw new Error('Factory dependency identity mismatch');
    if (hash(artifacts) !== m.identity.artifacts) throw new Error('Verification compiler output identity mismatch');
    for (const [id, input] of Object.entries(m.inputs)) if (hash(input) !== id) throw new Error('Corrupted verifier input');
    return [build, m];
  });
  return Object.fromEntries(entries);
}
/** Exact factory sources can be added without changing immutable deployment
 * releases or invalidating a user's in-progress setup. Never used for deployment.
 */
export function loadAdditionalSources(root) {
  return readdirSync(root).filter(n => /^[a-f\d]{64}\.json$/.test(n)).map(name => {
    const source = JSON.parse(readFileSync(join(root, name), 'utf8'));
    if (hash(source) !== name.slice(0, -5) || !/^0x(?:[a-f\d]{2})+$/i.test(source.runtime)
      || typeof source.compiler !== 'string' || typeof source.target !== 'string' || source.input?.language !== 'Solidity'
      || !source.input.sources || !Array.isArray(source.immutables) || !Array.isArray(source.immutableGroups)) throw new Error('Invalid supplemental verification source');
    return { ...source, input: hash(source.input), sourceInput: source.input };
  });
}
export function publicJob(job) {
  return { ...job, contracts: job.contracts.map(({runtime, ...c}) => job.status === 'retrying' ? { ...c, status: 'rechecking' } : c) };
}
