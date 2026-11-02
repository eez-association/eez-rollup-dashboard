import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeAbiParameters, keccak256, toFunctionSelector, zeroAddress } from 'viem';
import { predictBridgeToken, resolveBridgeTokenPair } from '../src/lib/bridgeTokenPair.ts';

const json = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url)));
const codes = json('./fixtures/bridge-token-factories.json');
const eezRuntime = json('../verification/supplemental/a2a97d4ad17097b771a00be27ba408c36d66db1dd028bb175fc51f871dced9ba.json').runtime;
const network = json('../src/lib/treasury/rollupx-mainnet-network.json');
const factories = json('../src/lib/bridge-token-artifacts.json');
const address = n => `0x${n.repeat(40)}`;
const manager = address('4'), implementation = address('5');
const l1 = { rpc: 'https://l1.invalid', bridge: address('1'), chainId: 1, name: 'Ethereum' };
const l2 = { rpc: 'https://l2.invalid', bridge: address('2'), chainId: 696991, name: 'RollupX' };
const token = { address: address('3'), name: 'USD Coin', symbol: 'USDC', decimals: 6 };
const addr = value => encodeAbiParameters([{type:'address'}], [value]);
const word = value => encodeAbiParameters([{type:'uint64'}], [value]);

async function withRpc(options, action) {
  const previous = globalThis.fetch, calls = [];
  let slotReads = 0;
  globalThis.fetch = async (url, request) => {
    const {method,params} = JSON.parse(request.body);
    calls.push({url,method,params});
    let result;
    if (method === 'eth_getCode') result = params[0] === implementation ? options.implementation ?? codes.implementation : options.runtime ?? codes.proxy;
    else if (method === 'eth_getStorageAt') {
      assert.equal(params[1], '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
      result = options.slot ?? addr(options.upgrade && slotReads++ ? address('6') : implementation);
    } else if (method === 'eth_call') {
      const selector = params[0].data.slice(0,10);
      if (selector === toFunctionSelector('EEZContract()')) {
        if (options.legacy) return {json:async()=>({error:{code:3,message:'execution reverted'}})};
        result = addr(manager);
      } else if (selector === toFunctionSelector('manager()')) {
        assert(options.legacy, 'Modern bridge must never call the legacy getter');
        result = addr(manager);
      } else if (selector === toFunctionSelector('wrappedTokenInfo(address)')) result = encodeAbiParameters([{type:'address'},{type:'uint64'}],[zeroAddress,0n]);
      else if (selector === toFunctionSelector('rollupId()')) result = word(url === l1.rpc ? 0n : 2n);
      else if (selector === toFunctionSelector('getWrappedToken(address,uint64)')) result = addr(zeroAddress);
      else throw new Error(`Unexpected selector ${selector}`);
    } else throw new Error(`Unexpected RPC ${method}`);
    return {json:async()=>({result})};
  };
  try { return await action(calls); }
  finally { globalThis.fetch = previous; }
}

test('verified proxy and implementation reproduce the recorded RollupX USDC wrapper', () => {
  assert.equal(keccak256(codes.proxy), network.contracts.bridgeL2.hash);
  assert.equal(keccak256(codes.implementation), network.bridgeImplementations.l2.hash);
  const predicted = predictBridgeToken(token, network.contracts.usdcProxy.address, 0n,
    network.contracts.bridgeL2.address, network.manager, codes.implementation);
  assert.equal(predicted, network.contracts.wrappedUSDC.address);
});

test('legacy eez.dev and current proxy bridges import original ERC20s in both directions', async t => {
  for (const legacy of [true,false]) for (const reverse of [false,true]) await t.test(`${legacy ? 'legacy' : 'current'} ${reverse ? 'L2 to L1' : 'L1 to L2'}`, async () => {
    const source = reverse ? l2 : l1, destination = reverse ? l1 : l2;
    await withRpc({legacy, runtime:legacy ? eezRuntime : codes.proxy}, async calls => {
      const [original, paired] = await resolveBridgeTokenPair({...token,chainId:source.chainId},source,destination);
      assert.equal(paired.predicted,true);
      assert.equal(paired.chainId,destination.chainId);
      assert.equal(paired.origin.chainId,source.chainId);
      assert.deepEqual(original.counterpart,{address:paired.address,chainId:destination.chainId});
      const runtime = legacy ? eezRuntime : codes.implementation;
      assert.equal(paired.address,predictBridgeToken(token,token.address,reverse ? 2n : 0n,destination.bridge,manager,runtime));
      assert.notEqual(paired.address,predictBridgeToken(token,token.address,reverse ? 2n : 0n,implementation,manager,runtime));
      assert.equal(calls.some(call=>call.method==='eth_getStorageAt'),!legacy);
      const selectors = calls.filter(call=>call.method==='eth_call').map(call=>call.params[0].data);
      assert(selectors.includes(toFunctionSelector('EEZContract()')));
      assert.equal(selectors.includes(toFunctionSelector('manager()')),legacy);
    });
  });
});

test('proxy prediction rejects unknown code, unusable slots and concurrent upgrades', async t => {
  for (const [name, options, message] of [
    ['unknown proxy',{runtime:'0x6000'},/does not support/],
    ['unknown implementation',{implementation:'0x6000'},/implementation does not support/],
    ['empty implementation',{implementation:'0x'},/implementation does not support/],
    ['zero implementation',{slot:addr(zeroAddress)},/implementation is unavailable/],
    ['malformed slot',{slot:'0x01'},/implementation is unavailable/],
    ['upgrade during inspection',{upgrade:true},/implementation changed/],
  ]) await t.test(name,()=>withRpc(options,()=>assert.rejects(resolveBridgeTokenPair(token,l1,l2),message)));
  assert(factories.some(entry=>entry.proxyRuntimeHashes?.includes(keccak256(codes.proxy))));
});
