const lower = value => String(value || '').toLowerCase();
const identity = frame => `${frame.chain}:${lower(frame.to)}`;
const context = frame => `${identity(frame)}:${frame.blockNumber}`;

// Optional historical display metadata. Empty return data does not establish
// an EOA: only an empty eth_getCode response at the transaction's canonical
// block can supply this label. Never fall back to latest state.
export async function enrichAccountTypes(trace, readers, { timeoutMs = 1500, maxRequests = 200 } = {}) {
  const maxGroups = Math.min(100, Math.floor(maxRequests / 2));
  if (!(timeoutMs > 0) || !(maxGroups > 0)) return;
  const transactions = new Map(trace.transactions.map(tx => [`${tx.chain}:${lower(tx.hash)}`, tx]));
  const executedCode = new Set();
  for (const frame of trace.frames) {
    // A direct failure is not enough evidence for an EOA, even with empty
    // output. Inherited rollback alone does not imply that this target ran code.
    if (frame.type?.startsWith('CREATE') || frame.children?.length || frame.error ||
        frame.output && frame.output !== '0x' || frame.role !== 'application') executedCode.add(context(frame));
  }
  for (const event of trace.events || []) {
    const tx = transactions.get(`${event.chain}:${lower(event.transactionHash)}`);
    if (tx) executedCode.add(`${event.chain}:${lower(event.address)}:${tx.blockNumber}`);
  }
  const groups = new Map();
  for (const frame of trace.frames) {
    if (frame.decoded?.contractName !== 'Unknown contract' || frame.role !== 'application' ||
        !['CALL', 'STATICCALL'].includes(frame.type) || executedCode.has(context(frame)) ||
        !/^0x[\da-f]{40}$/i.test(frame.to || '') || BigInt(frame.to) <= 255n) continue;
    const tx = transactions.get(`${frame.chain}:${lower(frame.transactionHash)}`);
    if (!Number.isSafeInteger(tx?.blockNumber) || tx.blockNumber < 0 || tx.blockNumber !== frame.blockNumber ||
        !/^0x[\da-f]{64}$/i.test(tx.blockHash || '')) continue;
    const key = `${identity(frame)}:${lower(tx.blockHash)}`;
    if (!groups.has(key)) {
      if (groups.size >= maxGroups) continue;
      groups.set(key, { chain: frame.chain, address: frame.to, blockHash: tx.blockHash,
        block: '0x' + tx.blockNumber.toString(16), frames: [] });
    }
    groups.get(key).frames.push(frame);
  }
  if (!groups.size) return;
  const controller = new AbortController(), { signal } = controller;
  const confirmed = new Set();
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, Math.min(timeoutMs, 1500)); });
  const batch = async (chain, method, params) => {
    if (signal.aborted) return [];
    try {
      const result = await readers[chain].optionalBatch(method, params, signal);
      return Array.isArray(result) && result.length === params.length ? result : [];
    } catch { return []; }
  };
  const work = Promise.all(['L1', 'L2'].map(async chain => {
    const items = [...groups.values()].filter(group => group.chain === chain);
    if (!items.length) return;
    const codes = await batch(chain, 'eth_getCode', items.map(group => [group.address, group.block]));
    if (signal.aborted) return;
    // Even a single STOP byte (0x00) is code. Errors and malformed responses
    // must never masquerade as an empty account.
    const empty = items.filter((_group, index) => codes[index] === '0x');
    const blocks = [...new Map(empty.map(group => [group.block, group.blockHash])).entries()];
    if (!blocks.length) return;
    const canonical = await batch(chain, 'eth_getBlockByNumber', blocks.map(([block]) => [block, false]));
    if (signal.aborted) return;
    const observed = new Map(blocks.map(([block], index) => [block, lower(canonical[index]?.hash)]));
    for (const group of empty) if (observed.get(group.block) === lower(group.blockHash)) confirmed.add(group);
  }));
  try { await Promise.race([work, expired]); }
  finally { clearTimeout(timer); controller.abort(); }

  // One label per chain/address across all calls and both presentation modes.
  // Assign after the reads so numbering never depends on response timing.
  const identities = [...new Set([...confirmed].map(group => `${group.chain}:${lower(group.address)}`))].sort();
  const labels = new Map(identities.map((key, index) => [key, identities.length === 1 ? 'EOA' : `EOA_${index + 1}`]));
  for (const group of confirmed) for (const frame of group.frames) {
    frame.decoded.accountType = 'eoa';
    frame.decoded.contractName = labels.get(identity(frame));
    frame.decoded.nameProvenance = { source: 'eth_getCode', address: frame.to, blockNumber: frame.blockNumber, blockHash: group.blockHash };
  }
}
