import test from 'node:test';
import assert from 'node:assert/strict';
import { treasuryRpc, treasuryReadRpc } from '../src/lib/treasury/rpcTransport.ts';

test('independent reads use bounded batches, match reordered IDs, and never cache completed results', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body); requests.push(payload);
    const response = item => ({ jsonrpc: '2.0', id: item.id, result: item.params[0] });
    return Response.json(Array.isArray(payload) ? payload.map(response).reverse() : response(payload));
  });
  const url = 'https://rpc.example/batch';
  const values = await Promise.all(Array.from({ length: 19 }, (_, i) => treasuryReadRpc(url, 'eth_getBalance', [String(i), 'latest'])));
  assert.deepEqual(values, Array.from({ length: 19 }, (_, i) => String(i)));
  assert.deepEqual(requests.map(r => r.length), [8, 8, 3]);
  await Promise.all(Array.from({ length: 5 }, () => treasuryReadRpc(url, 'eth_getBalance', ['0', 'latest'])));
  assert.equal(requests.length, 4, 'identical in-flight reads share one request');
  assert(!Array.isArray(requests[3]), 'a lone read stays a normal JSON-RPC request');
  await treasuryReadRpc(url, 'eth_getBalance', ['0', 'latest']);
  assert.equal(requests.length, 5, 'a later read must observe the network again');
});

test('an endpoint rejecting arrays falls back once to bounded single reads', async t => {
  let batches = 0, singles = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (Array.isArray(body)) { batches++; return Response.json({ error: { code: -32600, message: 'No batches' } }); }
    singles++; return Response.json({ id: body.id, result: '0x1' });
  });
  const read = () => Promise.all(['eth_chainId', 'eth_blockNumber'].map(method => treasuryReadRpc('https://rpc.example/no-batches', method)));
  assert.deepEqual(await read(), ['0x1', '0x1']);
  await read(); assert.equal(batches, 1); assert.equal(singles, 4);
});

test('large read bursts keep at most four batches in flight', async t => {
  let active = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const batch = JSON.parse(options.body);
    assert(batch.length <= 8); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return Response.json(batch.map(item => ({ id: item.id, result: '0x1' })));
  });
  await Promise.all(Array.from({ length: 48 }, (_, i) => treasuryReadRpc('https://rpc.example/burst', 'eth_getBalance', [String(i)])));
  assert.equal(peak, 4); assert.equal(active, 0);
});

test('a failed batch member does not discard successful reads or replay contract errors', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests++; const batch = JSON.parse(options.body);
    return Response.json(batch.map((item, i) => i ? { id: item.id, error: { code: -32000, message: 'execution reverted' } }
      : { id: item.id, result: '0x1' }));
  });
  const results = await Promise.allSettled(['eth_chainId', 'eth_call'].map(method => treasuryReadRpc('https://rpc.example/member-error', method)));
  assert.equal(results[0].value, '0x1'); assert.equal(results[1].reason.code, -32000);
  assert.equal(requests, 1);
});

test('missing or duplicate response IDs cannot authorize a read', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const batch = JSON.parse(options.body);
    return Response.json(batch.map(() => ({ id: batch[0].id, result: '0x1' })));
  });
  const results = await Promise.allSettled(['eth_chainId', 'eth_blockNumber'].map(method => treasuryReadRpc('https://rpc.example/bad-ids', method)));
  assert(results.every(result => result.status === 'rejected' && /invalid batch/.test(result.reason.message)));
});

test('writes and fee quotes are never batched or merged with normal reads', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return Response.json({ result: '0x1' });
  });
  await Promise.all(['eth_sendTransaction', 'eth_sendTransaction', 'eez_quoteFee'].map(method => treasuryReadRpc('https://rpc.example/not-batchable', method, [{}])));
  assert.equal(requests.length, 3); assert(requests.every(request => !Array.isArray(request)));
});

test('treasury reads share only in-flight requests and bound concurrency per endpoint', async t => {
  let active=0,peak=0,calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;peak=Math.max(peak,++active);
    await new Promise(resolve=>setTimeout(resolve,10));active--;
    return Response.json({result:'0x1'});
  });
  const url='https://rpc.example/concurrency';
  await Promise.all(Array.from({length:12},(_,i)=>treasuryRpc(url,'eth_getBalance',[String(i)])));
  assert.equal(calls,12);assert.equal(peak,4);
  await Promise.all(Array.from({length:5},()=>treasuryRpc(url,'eth_chainId')));
  assert.equal(calls,13);
  await treasuryRpc(url,'eth_chainId');assert.equal(calls,14,'later checks must read fresh state');
});

test('429 retries only reads and honors the server cooldown',async t=>{
  let calls=0;const times=[];
  t.mock.method(globalThis,'fetch',async()=>{
    times.push(Date.now());return ++calls===1?new Response('',{status:429,headers:{'retry-after':'1'}}):Response.json({result:'0x1'});
  });
  assert.equal(await treasuryRpc('https://rpc.example/retry','eth_blockNumber'),'0x1');
  assert.equal(calls,2);assert(times[1]-times[0]>=990);
  calls=0;
  await assert.rejects(treasuryRpc('https://rpc.example/send','eth_sendRawTransaction',['0x1234']),/429/);
  assert.equal(calls,1,'transactions must never be retried automatically');
});

test('persistent rate limits fail explicitly without an unlimited retry loop',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'1'}});});
  await assert.rejects(treasuryRpc('https://rpc.example/limited','eth_chainId'),/rate limited.*retry automatically/);
  assert.equal(calls,2);
});
