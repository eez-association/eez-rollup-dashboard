import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Address } from 'viem';
import { crossChainDeployments } from '../../src/lib/falcon/crossChainDeployment.ts';
import { simulateL2, verifierDeployment, type EezClient, type PublicSample } from '../../src/lib/falcon/eez.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/deployed-code.json', import.meta.url), 'utf8'));
const sample: PublicSample = { message: '0x01', signature: '0x02', publicKey: '0x03' };
const account: Address = '0x1111111111111111111111111111111111111111';
for (const d of crossChainDeployments) test(`${d.l2.chainName} simulation uses only its verified network and contract`, async () => {
  const network = verifierDeployment(d);
  const calls: string[] = [];
  const client = {
    getChainId: async () => d.l2.chainId,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      assert.equal(blockNumber, network.anchor.blockNumber); return { hash: network.anchor.blockHash };
    },
    getBlockNumber: async () => 123n,
    getCode: async ({ address }: { address: Address }) => { assert.equal(address, network.address); return fixture.verifier.code; },
    readContract: async ({ address }: { address: Address }) => { calls.push('verify'); assert.equal(address, network.address); return true; },
    estimateGas: async ({ to }: { to: Address }) => { calls.push('estimate'); assert.equal(to, network.address); return 6000000n; },
  };
  const run = (patch = {}) => simulateL2({ ...client, ...patch } as unknown as EezClient, sample, new AbortController().signal, account, network);
  assert.equal((await run()).valid, true);
  assert.deepEqual(calls, ['verify', 'estimate']); calls.length = 0;
  for (const patch of [
    { getChainId: async () => 1 },
    { getBlock: async () => ({ hash: '0x' + '00'.repeat(32) }) },
    { getCode: async () => '0x' },
  ]) await assert.rejects(run(patch));
  assert.deepEqual(calls, [], 'mismatched deployment must stop before signature simulation or gas estimation');
});
