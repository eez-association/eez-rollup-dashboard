import { ethers } from 'ethers';
import { tokenTransfersByFrame } from '../flow/model.mjs';

const abi = new ethers.Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)']);
const lower = value => String(value || '').toLowerCase();

// Presentation-only reads: never invent trace frames or fall back to current
// state for a historical transfer. Cache only within this decode, per chain,
// token and receipt block hash. Failed optional reads leave raw units intact.
export async function enrichTokenMetadata(trace, readers, { timeoutMs = 1500, maxRequests = 24 } = {}) {
  trace.tokenMetadata = {};
  const maxGroups = Math.min(8, Math.floor(maxRequests / 3));
  if (!(timeoutMs > 0) || !(maxGroups > 0)) return;
  const frames = new Map(trace.frames.map(frame => [frame.id, frame]));
  const transactions = new Map(trace.transactions.map(tx => [`${tx.chain}:${lower(tx.hash)}`, tx]));
  const groups = new Map();
  for (const [frameId, transfers] of tokenTransfersByFrame(trace)) {
    const frame = frames.get(frameId), txKey = `${frame.chain}:${lower(frame.transactionHash)}`;
    const tx = transactions.get(txKey), receipt = tx?.receipt;
    if (!receipt || !/^0x[\da-f]{64}$/i.test(receipt.blockHash || '') || !/^0x[\da-f]+$/i.test(receipt.blockNumber || '')) continue;
    for (const transfer of transfers) {
      if (transfer.decimals != null && transfer.symbol != null) continue;
      const key = `${frame.chain}:${lower(receipt.blockHash)}:${transfer.token}`;
      if (!groups.has(key)) {
        if (groups.size >= maxGroups) continue;
        groups.set(key, { chain: frame.chain, token: transfer.token, receipt, keys: new Set(), fields: new Set() });
      }
      const group = groups.get(key);
      group.keys.add(`${txKey}:${transfer.token}`);
      if (transfer.decimals == null) group.fields.add('decimals');
      if (transfer.symbol == null) group.fields.add('symbol');
    }
  }
  if (!groups.size) return;
  const controller = new AbortController(), { signal } = controller;
  let timer;
  // Race custom transports as well as fetch: a transport that ignores abort
  // cannot hold the decoded trace open or publish metadata after this deadline.
  const expired = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, Math.min(timeoutMs, 1500)); });
  const batch = async (reader, method, params) => {
    if (signal.aborted) return [];
    try {
      if (reader.optionalBatch) {
        const results = await reader.optionalBatch(method, params, signal);
        return Array.isArray(results) && results.length === params.length ? results : [];
      }
      const results = new Array(params.length).fill(null); let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, params.length) }, async () => {
        while (next < params.length && !signal.aborted) {
          const i = next++;
          try { results[i] = await reader.send(method, params[i]); } catch { /* Optional custom reader. */ }
        }
      }));
      return results;
    } catch { return []; }
  };
  const work = Promise.all(['L1', 'L2'].map(async chain => {
    const items = [...groups.values()].filter(group => group.chain === chain);
    if (!items.length) return;
    const reader = readers[chain], calls = items.flatMap(group => [...group.fields].map(field => ({ group, field })));
    const results = await batch(reader, 'eth_call', calls.map(({ group, field }) =>
      [{ to: group.token, data: abi.encodeFunctionData(field) }, group.receipt.blockNumber]));
    if (signal.aborted) return;
    const valuesByGroup = new Map();
    calls.forEach(({ group, field }, i) => {
      try {
        const data = results[i];
        if (typeof data !== 'string' || data.length > 2048) return;
        if (field === 'decimals' && (!/^0x[\da-f]{64}$/i.test(data) || BigInt(data) > 255n)) return;
        const value = abi.decodeFunctionResult(field, data)[0];
        const values = valuesByGroup.get(group) ?? {};
        if (field === 'decimals') {
          if (value >= 0n && value <= 255n) values.decimals = Number(value);
        } else if (typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value)) values.symbol = value;
        if (Object.keys(values).length) valuesByGroup.set(group, values);
      } catch { /* Metadata is optional; do not turn a decoded trace into an error. */ }
    });
    // One fresh canonical check per chain/block, shared by all its token reads.
    const receipts = [...new Map([...valuesByGroup.keys()].map(group => [lower(group.receipt.blockHash), group.receipt])).values()];
    if (!receipts.length) return;
    const blocks = await batch(reader, 'eth_getBlockByNumber', receipts.map(receipt => [receipt.blockNumber, false]));
    if (signal.aborted) return;
    const byHash = new Map(receipts.map((receipt, i) => [lower(receipt.blockHash), blocks[i]]));
    for (const [group, values] of valuesByGroup) {
      const block = byHash.get(lower(group.receipt.blockHash));
      if (lower(block?.hash) !== lower(group.receipt.blockHash)) continue;
      for (const key of group.keys) trace.tokenMetadata[key] = { ...values, blockHash: group.receipt.blockHash };
    }
  }));
  try { await Promise.race([work, expired]); }
  finally { clearTimeout(timer); controller.abort(); }
}
