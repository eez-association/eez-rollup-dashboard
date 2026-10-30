import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeAbiParameters, toFunctionSelector, zeroAddress } from 'viem';
import { predictBridgeToken, resolveBridgeTokenPair } from '../src/lib/bridgeTokenPair.ts';
import { loadBridgeTokens, saveBridgeToken } from '../src/lib/bridgeTokens.ts';
const bundle = fs.readdirSync('src/lib/treasury/builds').map(file => JSON.parse(fs.readFileSync('src/lib/treasury/builds/'+file))).find(b=>b.contracts.Bridge);
const runtime = bundle.contracts.Bridge.runtime;
const address = n => '0x'+n.repeat(40);
const source={rpc:'https://source.invalid',bridge:address('1'),chainId:10200};
const destination={rpc:'https://destination.invalid',bridge:address('2'),chainId:699169};
const token={address:address('3'),chainId:source.chainId,name:'Test token',symbol:'TEST',decimals:6};
const word=n=>encodeAbiParameters([{type:'uint256'}],[BigInt(n)]);
const addr=a=>encodeAbiParameters([{type:'address'}],[a]);
const text=s=>encodeAbiParameters([{type:'string'}],[s]);

test('unknown factory code cannot produce a guessed counterpart',()=>{
  assert.throws(()=>predictBridgeToken(token,token.address,0n,destination.bridge,address('4'),'0x6000'),/does not support/);
});

test('token pairs predict undeployed wrappers, reuse deployed wrappers, and unwrap to originals', async t=>{
  for (const mode of ['predicted','deployed','return']) await t.test(mode,async()=>{
    const originalFetch=globalThis.fetch;
    const requests=[];
    globalThis.fetch=async(url,options)=>{
      const {method,params}=JSON.parse(options.body);requests.push({url,method,params});
      let result;
      if(method==='eth_getCode')result=runtime;
      else {
        const selector=params[0].data.slice(0,10);
        if(selector===toFunctionSelector('wrappedTokenInfo(address)'))result=encodeAbiParameters([{type:'address'},{type:'uint64'}],[mode==='return'?address('5'):zeroAddress,2n]);
        else if(selector===toFunctionSelector('rollupId()'))result=word(url===source.rpc?0:2);
        else if(selector===toFunctionSelector('getWrappedToken(address,uint64)'))result=addr(mode==='deployed'?address('6'):zeroAddress);
        else if(selector===toFunctionSelector('manager()'))result=addr(address('4'));
        else if(selector===toFunctionSelector('name()'))result=text(token.name);
        else if(selector===toFunctionSelector('symbol()'))result=text(token.symbol);
        else if(selector===toFunctionSelector('decimals()'))result=word(token.decimals);
        else throw Error('Unexpected RPC');
      }
      return {json:async()=>({result})};
    };
    try {
      const [original,counterpart]=await resolveBridgeTokenPair(token,source,destination);
      assert.equal(counterpart.chainId,destination.chainId);
      assert.deepEqual(original.counterpart,{address:counterpart.address,chainId:destination.chainId});
      assert.deepEqual(counterpart.counterpart,{address:original.address,chainId:source.chainId});
      if(mode==='predicted') {
        assert.equal(counterpart.predicted,true);
        assert.notEqual(counterpart.address,token.address);
        assert.notEqual(counterpart.address,predictBridgeToken(token,token.address,2n,destination.bridge,address('4'),runtime));
        assert.notEqual(counterpart.address,predictBridgeToken(token,token.address,0n,source.bridge,address('4'),runtime));
      } else assert.equal(counterpart.address,mode==='return'?address('5'):address('6'));
      assert(requests.every(r=>['eth_call','eth_getCode'].includes(r.method)));
    } finally {globalThis.fetch=originalFetch;}
  });
});

test('storage keeps both chains, de-duplicates case-insensitively, and tolerates invalid data',()=>{
  const previous=globalThis.localStorage;let stored='{"not":"an array"}';
  globalThis.localStorage={getItem:()=>stored,setItem:(_key,value)=>{stored=value;}};
  try {
    assert.deepEqual(loadBridgeTokens(),[]);
    let tokens=saveBridgeToken(token,[]);
    tokens=saveBridgeToken({...token,chainId:destination.chainId},tokens);
    tokens=saveBridgeToken({...token,symbol:'UPDATED'},tokens);
    assert.equal(tokens.length,2);assert.equal(loadBridgeTokens()[0].symbol,'UPDATED');
    stored=JSON.stringify([{...token,counterpart:{address:4}},token]);
    assert.equal(loadBridgeTokens().length,1);
    globalThis.localStorage.setItem=()=>{throw Error('Storage unavailable');};
    assert.equal(saveBridgeToken(token,[]).length,1);
  }finally{globalThis.localStorage=previous;}
});

test('saving from a stale tab preserves tokens imported by another tab',()=>{
  const previous=globalThis.localStorage;let stored='[]';
  globalThis.localStorage={getItem:()=>stored,setItem:(_key,value)=>{stored=value;}};
  try {
    const tabA=loadBridgeTokens(),tabB=loadBridgeTokens();
    saveBridgeToken(token,tabA);
    saveBridgeToken({...token,address:address('7'),symbol:'OTHER'},tabB);
    assert.deepEqual(loadBridgeTokens().map(t=>t.symbol),['OTHER','TEST']);
  }finally{globalThis.localStorage=previous;}
});

test('reverting optional metadata matches bridge defaults without hiding RPC failures',async()=>{
  const {readBridgeToken}=await import('../src/lib/bridgeTokens.ts');
  const originalFetch=globalThis.fetch;
  try {
    let error={code:3,message:'execution reverted'};
    globalThis.fetch=async(_url,options)=>({json:async()=>{
      const {params}=JSON.parse(options.body);
      return params[0].data===toFunctionSelector('decimals()')?{result:word(6)}:{error};
    }});
    const read=await readBridgeToken(source.rpc,token.address,source.chainId);
    assert.equal(read.name,'Unknown Token');assert.equal(read.symbol,'UNKTKN');assert.equal(read.decimals,6);
    error={code:-32000,message:'RPC timeout'};
    await assert.rejects(readBridgeToken(source.rpc,token.address,source.chainId),/RPC timeout/);
  }finally{globalThis.fetch=originalFetch;}
});
