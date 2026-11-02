// Read-only snapshot for repeatable isolated rehearsal; no keys or broadcast API.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, parseAbi, toHex } from 'viem';
import { ETHEREUM_USDC, USDC_IMPLEMENTATION_SLOT } from '../src/lib/treasury/mainnet.ts';
import { readBridgeManager } from '../src/lib/bridgeManager.ts';
const { values } = parseArgs({ options: { config: { type: 'string' }, output: { type: 'string' } } });
if (!values.config || !values.output) throw new Error('Use --config PUBLIC_DASHBOARD_CONFIG_URL --output PATH');
const url = new URL(values.config), config = await (await fetch(url)).json();
const rpc = async (chain, method, params = []) => {
  const endpoint = new URL(config[`${chain}RpcUrl`], url.origin);
  const body = await (await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) })).json();
  if (body.error) throw new Error(`${chain} ${method}: RPC ${body.error.code}`);
  return body.result;
};
const snapshot = { source: `${url.origin}${url.pathname}`, capturedAt: new Date().toISOString(), protocolCommit: config.protocolCommit,
  registry: config.l1ContractAddress, manager: config.l2ContractAddress, rollupId: String(config.rollupId), chains: {}, contracts: {} };
for (const chain of ['l1','l2']) {
  const block = await rpc(chain, 'eth_getBlockByNumber', ['latest', false]);
  snapshot.chains[chain] = { chainId: Number(BigInt(await rpc(chain,'eth_chainId'))), number: block.number, hash: block.hash };
}
if (snapshot.chains.l1.chainId !== 1 || snapshot.chains.l2.chainId === 906969) throw new Error('Expected existing Ethereum deployment');
const capture = async (key, chain, address) => {
  const code = await rpc(chain,'eth_getCode',[address,snapshot.chains[chain].number]);
  if (!code || code === '0x') throw new Error(`${key}: empty runtime`);
  snapshot.contracts[key] = { chain, address:getAddress(address), code, hash:keccak256(code) };
};
await capture('bridgeL1','l1',config.bridgeL1Address);
await capture('bridgeL2','l2',config.bridgeL2Address);
await capture('usdcProxy','l1',ETHEREUM_USDC);
const slot = await rpc('l1','eth_getStorageAt',[ETHEREUM_USDC,USDC_IMPLEMENTATION_SLOT,snapshot.chains.l1.number]);
await capture('usdcImplementation','l1',getAddress(`0x${slot.slice(-40)}`));
const abi = parseAbi(['function getWrappedToken(address,uint64) view returns(address)','function wrappedTokenInfo(address) view returns(address,uint64)',
  'function canonicalBridgeAddress() view returns(address)','function rollupId() view returns(uint64)','function BRIDGE() view returns(address)']);
const read = async (chain,to,functionName,args=[]) => decodeFunctionResult({abi,functionName,data:await rpc(chain,'eth_call',[{to,data:encodeFunctionData({abi,functionName,args})},snapshot.chains[chain].number])});
const wrapped = await read('l2',config.bridgeL2Address,'getWrappedToken',[ETHEREUM_USDC,0n]);
await capture('wrappedUSDC','l2',wrapped);
for (const chain of ['l1','l2']) {
  const bridge = snapshot.contracts[chain==='l1'?'bridgeL1':'bridgeL2'];
  bridge.bindings = { manager:await readBridgeManager(data => rpc(chain,'eth_call',[{to:bridge.address,data},snapshot.chains[chain].number])), counterpart:await read(chain,bridge.address,'canonicalBridgeAddress'), rollupId:String(await read(chain,bridge.address,'rollupId')) };
  if (bridge.bindings.manager.toLowerCase() !== (chain==='l1'?snapshot.registry:snapshot.manager).toLowerCase()
    || bridge.bindings.counterpart.toLowerCase() !== snapshot.contracts[chain==='l1'?'bridgeL2':'bridgeL1'].address.toLowerCase()
    || bridge.bindings.rollupId !== (chain==='l1'?'0':snapshot.rollupId)) throw new Error('Bridge bindings changed');
}
const [original,origin] = await read('l2',config.bridgeL2Address,'wrappedTokenInfo',[wrapped]);
if (original.toLowerCase()!==ETHEREUM_USDC.toLowerCase() || origin!==0n || (await read('l2',wrapped,'BRIDGE')).toLowerCase()!==config.bridgeL2Address.toLowerCase()) throw new Error('Wrapped USDC binding changed');
for (const chain of ['l1','l2']) if ((await rpc(chain,'eth_getBlockByNumber',[snapshot.chains[chain].number,false])).hash!==snapshot.chains[chain].hash) throw new Error('Snapshot changed');
writeFileSync(values.output,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({chains:snapshot.chains,contracts:Object.fromEntries(Object.entries(snapshot.contracts).map(([k,v])=>[k,{address:v.address,hash:v.hash}]))},null,2));
