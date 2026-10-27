import { ethers } from 'ethers';
import { tokenTransfersByFrame } from '../flow/model.mjs';

const abi = new ethers.Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)']);
const lower = value => String(value || '').toLowerCase();

// Presentation-only reads: never invent trace frames or fall back to current
// state for a historical transfer. Cache only within this decode, per chain,
// token and receipt block hash. Failed optional reads leave raw units intact.
export async function enrichTokenMetadata(trace, readers) {
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
        if (groups.size >= 32) continue;
        groups.set(key, { chain: frame.chain, token: transfer.token, receipt, keys: new Set(), fields: new Set() });
      }
      const group = groups.get(key);
      group.keys.add(`${txKey}:${transfer.token}`);
      if (transfer.decimals == null) group.fields.add('decimals');
      if (transfer.symbol == null) group.fields.add('symbol');
    }
  }
  trace.tokenMetadata = {};
  const items = [...groups.values()]; let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (next < items.length) {
      const group = items[next++], reader = readers[group.chain], values = {};
      await Promise.all([...group.fields].map(async field => {
        try {
          const data = await reader.send('eth_call', [{ to: group.token, data: abi.encodeFunctionData(field) }, group.receipt.blockNumber]);
          if (typeof data !== 'string' || data.length > 2048) return;
          if (field === 'decimals' && (!/^0x[\da-f]{64}$/i.test(data) || BigInt(data) > 255n)) return;
          const value = abi.decodeFunctionResult(field, data)[0];
          if (field === 'decimals') {
            if (value >= 0n && value <= 255n) values.decimals = Number(value);
          } else if (typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value)) values.symbol = value;
        } catch { /* Metadata is optional; do not turn a decoded trace into an error. */ }
      }));
      if (!Object.keys(values).length) continue;
      try {
        const block = await reader.send('eth_getBlockByNumber', [group.receipt.blockNumber, false]);
        if (lower(block?.hash) !== lower(group.receipt.blockHash)) continue;
        for (const key of group.keys) trace.tokenMetadata[key] = { ...values, blockHash: group.receipt.blockHash };
      } catch { /* Cannot establish the historical observation. */ }
    }
  }));
}
