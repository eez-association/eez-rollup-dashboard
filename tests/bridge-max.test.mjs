import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareNativeBridgeMax} from '../src/lib/bridgeMax.ts';

// The later settlement quote may use any fee up to the application ceiling.
// Keep that entire ceiling available before simulating a maximum-value send.
{
 const values = [];
 const result = await prepareNativeBridgeMax({balance:1000n,feeCap:2n,gasOverride:null,minimumReserve:300n,
   estimate:async value=>{values.push(value);return 10n;}});
 assert.deepEqual(values,[700n]);
 assert.deepEqual(result,{amount:700n,reserve:300n});
 await assert.rejects(prepareNativeBridgeMax({balance:300n,feeCap:2n,gasOverride:null,minimumReserve:300n,
   estimate:async()=>{throw new Error('must not simulate an unfunded amount');}}),/cover gas/);
 const largerGas = await prepareNativeBridgeMax({balance:1000n,feeCap:2n,gasOverride:200n,minimumReserve:300n,estimate:async()=>10n});
 assert.deepEqual(largerGas,{amount:600n,reserve:400n});
}
const balance=1000000000000000001n, feeCap=1000000014n, raw=422319n;
test('MAX reserves raw Composer gas at the quoted fee cap with full precision',async()=>{
 const values=[];
 const result=await prepareNativeBridgeMax({balance,feeCap,gasOverride:null,estimate:async value=>{values.push(value);return raw;}});
 assert.deepEqual(result,{amount:balance-raw*feeCap,reserve:raw*feeCap});
 assert.deepEqual(values,[balance,result.amount]);
});
test('manual gas override controls the reserve without altering the raw estimate',async()=>{
 const result=await prepareNativeBridgeMax({balance,feeCap,gasOverride:500000n,estimate:async()=>raw});
 assert.equal(result.amount,balance-500000n*feeCap);
});
test('a higher gas requirement at the reduced value triggers another exact estimate',async()=>{
 const values=[];
 const result=await prepareNativeBridgeMax({balance:1000n,feeCap:2n,gasOverride:null,estimate:async value=>{values.push(value);return value===1000n?10n:20n;}});
 assert.deepEqual(values,[1000n,980n,960n]);assert.equal(result.amount,960n);
});
test('a lower subsequent estimate retains a conservative reserve',async()=>{
 let calls=0;
 const result=await prepareNativeBridgeMax({balance:1000n,feeCap:2n,gasOverride:null,estimate:async()=>++calls===1?20n:10n});
 assert.equal(result.amount,960n);assert.equal(calls,2);
});
test('zero quoted fees allow the full balance without a hardcoded reserve',async()=>{
 const result=await prepareNativeBridgeMax({balance,feeCap:0n,gasOverride:null,estimate:async()=>raw});assert.equal(result.amount,balance);
});
test('insufficient native funds fail rather than inventing a spendable amount',async()=>{
 await assert.rejects(prepareNativeBridgeMax({balance:10n,feeCap:2n,gasOverride:null,estimate:async()=>10n}),/cover gas/);
});
test('Composer failures propagate without a gas fallback',async()=>{
 await assert.rejects(prepareNativeBridgeMax({balance,feeCap,gasOverride:null,estimate:async()=>{throw new Error('Composer unavailable');}}),/Composer unavailable/);
});
test('unstable estimates stop after a bounded number of attempts',async()=>{
 let calls=0;
 await assert.rejects(prepareNativeBridgeMax({balance:1000n,feeCap:1n,gasOverride:null,estimate:async()=>BigInt(++calls)}),/changed repeatedly/);assert.equal(calls,4);
});
test('invalid balances, fees, and gas limits are rejected',async()=>{
 for(const params of [{balance:0n,feeCap:1n},{balance:10n,feeCap:-1n}]) await assert.rejects(prepareNativeBridgeMax({...params,gasOverride:null,estimate:async()=>1n}));
 await assert.rejects(prepareNativeBridgeMax({balance,feeCap,gasOverride:0n,estimate:async()=>raw}),/valid gas limit/);
});

test('MAX caps the amount before estimation while preserving the gas reserve', async () => {
 const cap = 100_000_000_000_000_000n;
 const values = [];
 const result = await prepareNativeBridgeMax({balance:10n*cap,feeCap:2n,gasOverride:null,minimumReserve:300n,maxAmount:cap,
   estimate:async value=>{values.push(value);return 10n;}});
 assert.deepEqual(values,[cap]);
 assert.deepEqual(result,{amount:cap,reserve:300n});
 const lowBalance = await prepareNativeBridgeMax({balance:cap,feeCap:2n,gasOverride:null,minimumReserve:300n,maxAmount:cap,estimate:async()=>10n});
 assert.deepEqual(lowBalance,{amount:cap-300n,reserve:300n});
});
