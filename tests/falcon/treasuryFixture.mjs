import { keccak256, toHex } from 'viem';
import { reloadFixture } from '../fixtures/treasury-reload.mjs';
import { setupIdentity } from '../../src/lib/treasury/mainnetSetup.ts';
export function treasuryFixture(d, origin) {
 const f=reloadFixture(origin), {network,state,config}=f;
 network.registry=d.l1.registry;network.manager=d.l2.manager;
 network.chains.l1.chainId=d.l1.chainId;network.chains.l2.chainId=d.l2.chainId;
 network.discovered={kind:'erc20',symbol:config.payments.assetLabel};
 network.rollupId=Number(d.l2.rollupId);
 for(const [key,address] of Object.entries({usdcProxy:config.payments.tokenL1,wrappedUSDC:config.payments.tokenL2,bridgeL1:config.payments.bridgeL1,bridgeL2:config.payments.bridgeL2}))network.contracts[key]={...network.contracts[key],address};
 state.identity=setupIdentity(network);
 config.network=network;
 config.environment='dashboard-network';config.registry=d.l1.registry;config.manager=d.l2.manager;
 config.l1.chainId=d.l1.chainId;config.l2.chainId=d.l2.chainId;
 for(const binding of config.protocol){binding.proxy=binding.chain==='l1'?d.l1.registry:d.l2.manager;config.code.push({chain:binding.chain,address:binding.proxy,hash:keccak256(toHex('protocol'))});}
 const key='eez:treasury:paired-setup:'+setupIdentity(network);
 return {...f,key,entries:[[key,JSON.stringify(state)],[key+':manifest',JSON.stringify(config)],['eez:treasury:discovered:fixture:network',JSON.stringify(network)]]};
}
