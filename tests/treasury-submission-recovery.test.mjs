import test from 'node:test';
import assert from 'node:assert/strict';
import { walletRejected, checkCancelledSubmission } from '../src/lib/treasury/submissionRecovery.ts';

test('only explicit wallet rejection codes release a rejected send', () => {
  for (const error of [{ code: 4001 }, { code: '4001' }, { code: -32603, data: { originalError: { code: 4001 } } },
    { cause: { error: { code: 4001 } } }]) assert(walletRejected(error));
  const cycle = {}; cycle.cause = cycle;
  for (const error of [cycle, null, { code: 4900 }, new Error('Network timeout'), { message: 'Request cancelled' }]) assert.equal(walletRejected(error), false);
});

const intent = { sender: '0x' + '11'.repeat(20), nonce: '4', sourceNonce: '0x1', payment: { source: 'l1' }, submissionChain: 'l1' };
function fixture() {
  const state = { outcome: { kind: 'unknown' }, nonce: 4n, count: '0x1', fail: false }, calls = [];
  const client = { config: { l1: { rpc: 'l1', front: 'composer-l1' }, l2: { rpc: 'l2' } },
    validate: async () => {}, outcome: async () => state.outcome, snapshot: async source => { assert.equal(source, 'l1'); return { nonce: state.nonce }; },
    rpc: async (url, method, params) => { if (state.fail) throw Error('RPC unavailable'); calls.push([url, method, params]); return state.count; } };
  return { client, state, calls };
}
test('user-confirmed cancellation checks chain and Composer nonces before clearing an unhashed request', async () => {
  const f = fixture(); await checkCancelledSubmission(f.client, intent);
  assert.deepEqual(f.calls.map(([url, , params]) => [url, params[1]]), [['l1', 'latest'], ['l1', 'pending'], ['composer-l1', 'pending']]);
  for (const change of [{ outcome: { kind: 'unknown', hash: '0x1234' } }, { outcome: { kind: 'pending' } }, { nonce: 5n }, { count: '0x2' }, { count: '0x0' }, { count: 'unavailable' }]) {
    const g = fixture(); Object.assign(g.state, change);
    await assert.rejects(checkCancelledSubmission(g.client, intent), /activity was detected/);
  }
  await assert.rejects(checkCancelledSubmission(f.client, { ...intent, hash: '0x1234' }), /must remain tracked/);
  f.state.fail = true;
  await assert.rejects(checkCancelledSubmission(f.client, intent), /RPC unavailable/);
});
