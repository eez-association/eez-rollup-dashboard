import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import { MainnetSetup, selectMainnetSetupNetwork, setupIdentity } from '../src/lib/treasury/mainnetSetup.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';
import { USDC_IMPLEMENTATION_SLOT } from '../src/lib/treasury/mainnet.ts';
const read = path => JSON.parse(readFileSync(path));
const legacy = read('src/lib/treasury/mainnet-network.json'), rollupx = read('src/lib/treasury/rollupx-mainnet-network.json');
const release = read(`src/lib/treasury/builds/${read('src/lib/treasury/current-build.json').build}.json`);
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
const target = { l1:{rpc:'http://127.0.0.1:1',front:'http://127.0.0.1:1'}, l2:{rpc:'http://127.0.0.1:2',front:'http://127.0.0.1:2'}, fees:{l1:'100',l2:'100'} };
const abi = parseAbi(['function EEZContract() view returns(address)', 'function manager() view returns(address)', 'function rollupId() view returns(uint64)',
  'function canonicalBridgeAddress() view returns(address)', 'function getWrappedToken(address,uint64) view returns(address)',
  'function wrappedTokenInfo(address) view returns(address,uint64)', 'function BRIDGE() view returns(address)', 'function paused() view returns(bool)']);
function fixture(source=rollupx) {
  const network=structuredClone(source), bytes='0x6000', hash=keccak256(bytes), state={};
  for (const contract of Object.values(network.contracts)) contract.hash=hash;
  for (const protocol of network.protocol) protocol.proxyHash=protocol.implementationHash=hash;
  for (const implementation of Object.values(network.bridgeImplementations??{})) implementation.hash=hash;
  const engine=new MainnetSetup(target,release,network);
  engine.io.rpc=async(chain,method,params=[])=>{
    const protocol=network.protocol.find(p=>p.chain===chain), bridge=network.contracts[chain==='l1'?'bridgeL1':'bridgeL2'];
    if(method==='eth_chainId')return toHex(network.chains[chain].chainId);
    if(method==='eth_getBlockByNumber')return {number:network.chains[chain].number,hash:network.chains[chain].hash};
    if(method==='eth_getCode') {
      if(same(params[0],network.contracts.wrappedUSDC.address))return state.missingToken?'0x':bytes;
      if(network.bridgeImplementations?.[chain]&&same(params[0],network.bridgeImplementations[chain].address)&&state.changedCode)return '0x6001';
      return bytes;
    }
    if(method==='eth_getStorageAt') {
      const address=params[1]===USDC_IMPLEMENTATION_SLOT?network.contracts.usdcImplementation.address
        :same(params[0],bridge.address)?state.changedImplementation??network.bridgeImplementations?.[chain]?.address??zeroAddress:protocol.implementation;
      return toHex(BigInt(address),{size:32});
    }
    assert.equal(method,'eth_call');
    if(same(params[0].to,COMPOSER_DISCOVERY_ADDRESS)) {
      const {args}=decodeFunctionData({abi:COMPOSER_DISCOVERY_ABI,data:params[0].data});
      return encodeFunctionResult({abi:COMPOSER_DISCOVERY_ABI,functionName:'composerInfo',result:[COMPOSER_DISCOVERY_MARKER,1n,args[0],BigInt(network.chains[chain].chainId),toHex(JSON.stringify({version:'fixture',supportedNetworks:{eezL1:1,eezL2:network.chains.l2.chainId},eezContracts:{eezRegistryAddress:network.registry,eezL2Address:network.manager}}))]});
    }
    const {functionName}=decodeFunctionData({abi,data:params[0].data});
    if(functionName==='EEZContract'&&!network.bridgeImplementations)throw Error('unknown getter');
    const values={EEZContract:state.wrongManager??bridge.bindings.manager,manager:bridge.bindings.manager,rollupId:BigInt(bridge.bindings.rollupId),
      canonicalBridgeAddress:network.bridgeImplementations?zeroAddress:bridge.bindings.counterpart,getWrappedToken:network.contracts.wrappedUSDC.address,
      wrappedTokenInfo:[network.contracts.usdcProxy.address,state.wrongOrigin?1n:0n],BRIDGE:network.contracts.bridgeL2.address,paused:false};
    return encodeFunctionResult({abi,functionName,result:values[functionName]});
  };
  return {engine,state};
}
test('mainnet selection supports both deployments without reusing their saved setup identity',()=>{
  for(const network of [legacy,rollupx]) {
    const args=[toHex(network.chains.l1.chainId),toHex(network.chains.l2.chainId),network.registry,network.manager,network.contracts.bridgeL1.address,network.contracts.bridgeL2.address];
    assert.deepEqual(selectMainnetSetupNetwork(...args),network);
    assert.equal(selectMainnetSetupNetwork(...args.slice(0,5),zeroAddress),null);
    assert.equal(selectMainnetSetupNetwork('0x27d8',...args.slice(1)),null);
  }
  assert.notEqual(setupIdentity(legacy),setupIdentity(rollupx));
});
test('mainnet validation accepts pinned immutable and proxy bridges',async()=>{
  for(const network of [legacy,rollupx])await fixture(network).engine.validate();
});
test('proxy bridge changes and wrong identities remain blocked',async()=>{
  for(const patch of [{changedImplementation:zeroAddress},{changedCode:true},{wrongManager:zeroAddress},{wrongOrigin:true}]) {
    const {engine,state}=fixture();Object.assign(state,patch);
    await assert.rejects(engine.validate(),/bridge connection changed|bridge implementation changed|USDC origin/);
  }
});
test('missing wrapped USDC is explained only after bridge implementation checks pass',async()=>{
  const {engine,state}=fixture();state.missingToken=true;
  await assert.rejects(engine.validate(),/USDC has not been provisioned on RollupX/);
  state.changedImplementation=zeroAddress;
  await assert.rejects(engine.validate(),/bridge connection changed/);
});
