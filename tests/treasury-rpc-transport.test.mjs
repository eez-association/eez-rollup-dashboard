import test from 'node:test';
import assert from 'node:assert/strict';
import { treasuryRpc } from '../src/lib/treasury/rpcTransport.ts';

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
