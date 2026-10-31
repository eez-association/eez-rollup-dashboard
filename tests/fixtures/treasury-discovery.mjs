import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, toHex, zeroAddress } from 'viem';
import { matchingDeployer, matchingDeployerRuntime } from '../../src/lib/treasury/matchingSafes.ts';
import { DeploymentIO } from '../../src/lib/treasury/deploymentIO.ts';
import { COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_MARKER } from '../../src/lib/composerDiscovery.ts';
import { EIP1967_IMPLEMENTATION_SLOT } from '../../src/lib/treasury/mainnet.ts';
const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
export const release = json(`../../src/lib/treasury/builds/${json('../../src/lib/treasury/current-build.json').build}.json`);
const source = id => json(`../../verification/supplemental/${id}.json`);
const codes = {
 l1Proxy: [source('499bdeb7d7e43e46166a34cf3667bde30e6af9f2af15e36565a13564179d59fa')],
 l2Proxy: [source('4e19f2ae17305a854840ea72517080c18fab1189f607dfaf586d25aae5e98de8')],
 l1Implementation: [source('e8623aeed038d34187f8af8559f09f9de050c4ecc3cae8c6fde1e3dafeaf7665')],
 l2Implementation: [source('807165ace8a88d39bb5e229f1481c629f6d01551c756bd3f699f3826535da401')],
 bridgeProxy: [source('a2a97d4ad17097b771a00be27ba408c36d66db1dd028bb175fc51f871dced9ba')],
 wrappedToken: [source('3d2cbbaf2cc47fbe8e86ce66e9f5e640cfba86c960dcd7a75d859cd6c2396e9d')],
};
const bridgeImpl = json('../../verification/supplemental/725808667000ef9e74ad8cc8e0ce5031c133f88320805bc51899785f99e0dbc7.json').runtime;
export const address = n => getAddress(toHex(n, { size: 20 }));
export const target = { l1: { rpc: 'http://127.0.0.1/l1', front: 'http://127.0.0.1/l1', explorer: 'https://example.com' }, l2: { rpc: 'http://127.0.0.1/l2', front: 'http://127.0.0.1/l2', explorer: 'https://example.com' }, fees: { l1: '100000000000000000', l2: '100000000000000000' } };
export const dashboard = { l1ChainId: '31337', l2ChainId: '987654', registry: address(100), manager: address(101), bridgeL1: address(102), bridgeL2: address(103) };
export const token = address(104), wrapped = address(105), owner = address(106);
const abi = parseAbi(['function EEZContract() view returns(address)', 'function manager() view returns(address)', 'function rollupId() view returns(uint64)', 'function ROLLUP_ID() view returns(uint64)', 'function MAINNET_ROLLUP_ID() view returns(uint64)', 'function canonicalBridgeAddress() view returns(address)', 'function getWrappedToken(address,uint64) view returns(address)', 'function wrappedTokenInfo(address) view returns(address,uint64)', 'function BRIDGE() view returns(address)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)', 'function bridgeL1() view returns(address)', 'function destinationRollup() view returns(uint64)', 'function MAX_REQUEST_AMOUNT() view returns(uint256)', 'function owner() view returns(address)', 'function closed() view returns(bool)', 'function sequence() view returns(uint256)', 'function computeCrossChainProxyAddress(address,uint64) view returns(address)']);
const same = (a,b) => a?.toLowerCase() === b?.toLowerCase();
export function fixture() {
  const state = { deployer: true, symbolReads: 0, missing: new Set(), unknown: false, decimals: 6, wrapped: true, wrongOrigin: false, wrongPeer: false, composerMismatch: false, reorg: false, tipReorg: false, demo: false, tokenImplementation: zeroAddress, block: 10n };
  const io = new DeploymentIO(target, release);
  io.rpc = async (chain, method, params = []) => {
    const l1 = chain === 'l1', protocol = l1 ? dashboard.registry : dashboard.manager, bridge = l1 ? dashboard.bridgeL1 : dashboard.bridgeL2;
    if (method === 'eth_blockNumber') return toHex(state.block);
    if (method === 'eth_chainId') return toHex(BigInt(l1 ? dashboard.l1ChainId : dashboard.l2ChainId));
    if (method === 'eth_getBlockByNumber') return { number: params[0] === 'latest' ? toHex(state.block) : params[0], hash: state.reorg || state.tipReorg && params[0] !== '0x0' ? toHex(99, {size:32}) : toHex(l1 ? 1 : 2, { size: 32 }), transactions: [] };
    if (method === 'eth_getCode') {
      const a = params[0]; if (same(a,matchingDeployer)) return state.deployer ? matchingDeployerRuntime : '0x'; if (state.missing.has(a.toLowerCase())) return '0x';
      if (same(a, protocol)) return codes[`${chain}Proxy`][0].runtime;
      if (same(a, address(l1 ? 110 : 111))) return state.unknown ? '0x6000' : codes[`${chain}Implementation`][0].runtime;
      if (same(a, bridge)) return codes.bridgeProxy[0].runtime;
      if (same(a, address(112))) return state.unknown ? '0x6001' : bridgeImpl;
      if (same(a, token)) return state.demo ? release.contracts.TestUSDC.runtime : '0x60006000';
      if (same(a, wrapped)) return state.unknown ? '0x6002' : codes.wrappedToken[0].runtime;
      if (same(a, state.tokenImplementation) && !same(a, zeroAddress)) return '0x60006001';
      return '0x';
    }
    if (method === 'eth_getStorageAt') {
      let a = zeroAddress;
      if (params[1] === EIP1967_IMPLEMENTATION_SLOT) a = same(params[0], protocol) ? address(l1 ? 110 : 111) : same(params[0], bridge) ? address(112) : same(params[0], token) ? state.tokenImplementation : zeroAddress;
      return toHex(BigInt(a), { size: 32 });
    }
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_estimateGas') return '0x100000';
    if (method === 'eth_getTransactionReceipt') return null;
    if (method !== 'eth_call') throw new Error(`Unexpected RPC ${method}`);
    if (same(params[0].to, COMPOSER_DISCOVERY_ADDRESS)) {
      const {args} = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data: params[0].data });
      return encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', result: [COMPOSER_DISCOVERY_MARKER, 1n, args[0], BigInt(l1 ? dashboard.l1ChainId : dashboard.l2ChainId), toHex(JSON.stringify({ version: 'fixture', supportedNetworks: { eezL1: Number(dashboard.l1ChainId), eezL2: state.composerMismatch ? 99 : Number(dashboard.l2ChainId) }, eezContracts: { eezRegistryAddress: dashboard.registry, eezL2Address: dashboard.manager, eezL1BridgeSender: dashboard.bridgeL1, eezL2BridgeReceiver: dashboard.bridgeL2 } }))] });
    }
    const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
    if (functionName === 'symbol') state.symbolReads++;
    const values = { EEZContract: protocol, manager: protocol, rollupId: l1 ? 0n : 77n, MAINNET_ROLLUP_ID: 0n, ROLLUP_ID: 77n,
      canonicalBridgeAddress: state.wrongPeer ? address(999) : l1 ? dashboard.bridgeL2 : dashboard.bridgeL1,
      getWrappedToken: state.wrapped ? wrapped : zeroAddress, wrappedTokenInfo: [state.wrongOrigin ? address(999) : token, 0n], BRIDGE: dashboard.bridgeL2,
      decimals: state.decimals, symbol: state.demo ? 'Test USDC' : 'EXAMPLE', bridgeL1: dashboard.bridgeL1, destinationRollup: 77n, MAX_REQUEST_AMOUNT: 1000000000n,
      owner, closed: false, sequence: 1n, computeCrossChainProxyAddress: address(1000 + Number(BigInt(args?.[0] ?? 0))) };
    return encodeFunctionResult({ abi, functionName, result: values[functionName] });
  };
  return { io, state };
}
