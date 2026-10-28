import {readFileSync}from'node:fs';import{keccak256,toHex}from'viem';
import{setupIdentity}from'../../src/lib/treasury/mainnetSetup.ts';import{savedNetworkKey}from'../../src/lib/treasury/savedNetwork.ts';
const read=p=>JSON.parse(readFileSync(p)),profile=read('src/lib/treasury/paired-testnet-network.json');
const a=n=>toHex(n,{size:20}),h=n=>toHex(n,{size:32});
export function reloadFixture(origin='http://127.0.0.1:1234'){
 const target={l1:{rpc:origin+'/rpc/l1',front:origin+'/composer/l1',explorer:'https://l1.example'},l2:{rpc:origin+'/rpc/l2',front:origin+'/composer/l2',explorer:'https://l2.example'},fees:{l1:'100',l2:'100'}};
 const network={...read('src/lib/treasury/mainnet-network.json'),testnet:true,registry:profile.registry,manager:profile.manager,
  chains:Object.fromEntries(['l1','l2'].map(chain=>[chain,{chainId:profile.chains[chain].chainId,...profile.chains[chain].checkpoint}]))};
 const state={version:3,build:read('src/lib/treasury/current-build.json').build,identity:setupIdentity(network),salt:h(100),deployer:a(99),addresses:{safeL1:a(3),safeL2:a(4)},code:[],completed:Array.from({length:6},(_,i)=>({chain:['l1','l2','l2','l1','l1','l1'][i],hash:h(20+i),blockHash:h(40+i),number:toHex(i+1)}))};
 const config={version:1,environment:'dashboard-testnet',instance:keccak256(toHex(`${state.salt}:${a(3)}:${a(4)}`)),
  l1:{...target.l1,chainId:network.chains.l1.chainId,checkpoint:profile.chains.l1.checkpoint},l2:{...target.l2,chainId:network.chains.l2.chainId,checkpoint:profile.chains.l2.checkpoint},
  safeL1:a(3),safeL2:a(4),adapter:a(5),registry:profile.registry,manager:profile.manager,ownerLabels:{},fees:{maxTotalWei:'100',l1MaxTotalWei:'100'},
  protocol:['l1','l2'].map(chain=>({chain,proxy:profile.chains[chain].protocol.proxy,implementation:profile.chains[chain].protocol.implementation})),
  code:['l1','l2'].flatMap(chain=>Array.from({length:25},(_,i)=>({chain,address:a(i+2),hash:h(i+2)}))),
  payments:{version:2,bridgeKind:'standard',policy:a(8),alias:a(9),tokenL1:a(10),tokenL2:a(11),pair:{version:1,policyL1:a(12),peerProxyL2:a(13)},safeL2Alias:a(14),moduleL1:a(15),moduleL2:a(16),bridgeL1:a(17),bridgeL2:a(18),recipient:a(19),decimals:6,period:600,globalLimit:'150000000',assetLabel:'Test USDC'}};
 for(const p of config.protocol)config.code.push({chain:p.chain,address:p.proxy,hash:h(77)},{chain:p.chain,address:p.implementation,hash:h(78)});
 const key='eez:treasury:paired-setup:'+setupIdentity(network),cacheKey=savedNetworkKey(target,a(17),a(18),a(10));
 return{config,network,target,state,key,cacheKey,entries:[[key,JSON.stringify(state)],[key+':manifest',JSON.stringify(config)],[cacheKey,JSON.stringify(network)]],owners:[a(99)],blockHash:h(106),orphanHash:h(107),useTestnet:true};
}
