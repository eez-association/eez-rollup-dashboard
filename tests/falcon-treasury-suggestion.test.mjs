import assert from 'node:assert/strict';
import {test} from 'node:test';
import {treasurySafeSuggestion} from '../src/lib/falcon/existingSafe.ts';
import {crossChainDeployment as d} from '../src/lib/falcon/crossChainDeployment.ts';
import {treasuryFixture} from './falcon/treasuryFixture.mjs';
const storage=entries=>{const map=new Map(entries);return {getItem:key=>map.get(key)??null,key:i=>[...map.keys()][i]??null,get length(){return map.size;},setItem:(k,v)=>map.set(k,v)}};
test('prefill uses the completed Treasury L1 Safe and excludes incomplete, wrong-network and unrelated storage',()=>{
 const f=treasuryFixture(d);const s=storage(f.entries);
 assert.equal(treasurySafeSuggestion(s,d).toLowerCase(),f.config.safeL1.toLowerCase());
 assert.notEqual(f.config.safeL1,f.config.safeL2);
 assert.equal(treasurySafeSuggestion(s,{...d,l2:{...d.l2,chainId:123}}),'');
 s.setItem(f.key,JSON.stringify({...f.state,completed:f.state.completed.slice(0,-1)}));assert.equal(treasurySafeSuggestion(s,d),'');
 s.setItem(f.key,'broken');assert.equal(treasurySafeSuggestion(s,d),'');
 assert.equal(treasurySafeSuggestion(storage([['random',JSON.stringify(f.config)]]),d),'');
});
