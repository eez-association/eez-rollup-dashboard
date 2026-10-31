import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, encodePacked, getContractAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { TokenMeta } from "../hooks/useBridge";
import { rpcCall } from "../rpc.ts";
import { readBridgeToken } from "./bridgeTokens.ts";
import { readBridgeManager } from "./bridgeManager.ts";
import factories from "./bridge-token-artifacts.json" with { type: "json" };

export interface BridgeTokenNetwork { rpc: string; bridge: string; chainId: number; name?: string }
const abi = parseAbi([
  "function wrappedTokenInfo(address) view returns (address,uint64)",
  "function getWrappedToken(address,uint64) view returns (address)",
  "function rollupId() view returns (uint64)",
]);
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** A storage slot alone does not prove delegatecall behavior. Accept only the
 * reproduced proxy runtime and its independently verified implementation. */
async function factoryRuntime(network: BridgeTokenNetwork, runtime: Hex, signal?: AbortSignal): Promise<Hex> {
  const hash = keccak256(runtime);
  if (factories.some(entry => entry.runtimeHash === hash)) return runtime;
  const allowed = factories.filter(entry => entry.proxyRuntimeHashes?.includes(hash));
  if (!allowed.length) throw new Error('This bridge version does not support token address prediction yet.');
  const readSlot = () => rpcCall(network.rpc, 'eth_getStorageAt', [network.bridge, implementationSlot, 'latest'], signal);
  const slot = await readSlot();
  if (typeof slot !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(slot) || BigInt(slot) === 0n) {
    throw new Error('Destination bridge implementation is unavailable.');
  }
  const implementation = `0x${slot.slice(-40)}`;
  const code = await rpcCall(network.rpc, 'eth_getCode', [implementation, 'latest'], signal);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)
    || !allowed.some(entry => entry.runtimeHash === keccak256(code as Hex))) {
    throw new Error('This bridge implementation does not support token address prediction yet.');
  }
  if (String(await readSlot()).toLowerCase() !== slot.toLowerCase()) throw new Error('Bridge implementation changed. Try the token lookup again.');
  return code as Hex;
}

export function predictBridgeToken(token: TokenMeta, originalToken: Address, originalRollupId: bigint, bridge: Address, manager: Address, runtime: Hex): Address {
  const factory = factories.find(entry => entry.runtimeHash === keccak256(runtime));
  if (!factory) throw new Error("This bridge version does not support token address prediction yet.");
  const args = factory.kind === "eez"
    ? encodeAbiParameters([{type:"address"},{type:"address"},{type:"string"},{type:"string"},{type:"uint8"}], [manager,bridge,token.name,token.symbol,token.decimals])
    : encodeAbiParameters([{type:"string"},{type:"string"},{type:"uint8"},{type:"address"}], [token.name,token.symbol,token.decimals,bridge]);
  return getContractAddress({ opcode: "CREATE2", from: bridge,
    salt: keccak256(encodePacked(["address","uint64"], [originalToken,originalRollupId])),
    bytecode: concatHex([factory.creationCode as Hex,args]) });
}

/** Follow wrapped tokens back to their origin; otherwise resolve/predict the destination wrapper. */
export async function resolveBridgeTokenPair(token: TokenMeta, source: BridgeTokenNetwork, destination: BridgeTokenNetwork, signal?: AbortSignal): Promise<[TokenMeta, TokenMeta]> {
  const read = async (network: BridgeTokenNetwork, functionName: "wrappedTokenInfo" | "getWrappedToken" | "rollupId", args?: readonly [Address] | readonly [Address,bigint]) => {
    const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const result = await rpcCall(network.rpc,"eth_call",[{to:network.bridge,data},"latest"],signal);
    if (typeof result !== "string" || !/^0x[0-9a-f]+$/i.test(result)) throw new Error("Unable to read the bridge token pair.");
    return result as Hex;
  };
  const [info, sourceId, destinationId] = await Promise.all([
    read(source,"wrappedTokenInfo",[token.address as Address]), read(source,"rollupId"), read(destination,"rollupId"),
  ]);
  const [original, originId] = decodeAbiParameters([{type:"address"},{type:"uint64"}],info);
  const sourceRollupId = decodeAbiParameters([{type:"uint64"}],sourceId)[0];
  const destinationRollupId = decodeAbiParameters([{type:"uint64"}],destinationId)[0];
  const originalToken = original === zeroAddress ? token.address as Address : original;
  const originalRollupId = original === zeroAddress ? sourceRollupId : originId;
  const originNetwork = originalRollupId === sourceRollupId ? source
    : originalRollupId === destinationRollupId ? destination : undefined;
  const origin: NonNullable<TokenMeta["origin"]> = {
    address: originalToken, rollupId: originalRollupId.toString(),
    ...(originNetwork ? { chainId: originNetwork.chainId } : {}),
    networkName: originNetwork?.name || (originNetwork ? `Chain ${originNetwork.chainId}` : `Rollup ${originalRollupId}`),
  };
  let counterpart: TokenMeta;
  if (original !== zeroAddress && originId === destinationRollupId) {
    counterpart = await readBridgeToken(destination.rpc, original, destination.chainId, signal);
  } else {
    const deployed = decodeAbiParameters([{type:"address"}],await read(destination,"getWrappedToken",[originalToken,originalRollupId]))[0];
    if (deployed !== zeroAddress) {
      counterpart = await readBridgeToken(destination.rpc,deployed,destination.chainId,signal);
    } else {
      const [runtime, manager] = await Promise.all([
        rpcCall(destination.rpc,"eth_getCode",[destination.bridge,"latest"],signal),
        readBridgeManager(data => rpcCall(destination.rpc, 'eth_call', [{to:destination.bridge,data}, 'latest'], signal)),
      ]);
      if (typeof runtime !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(runtime) || manager === zeroAddress) throw new Error("Destination bridge is unavailable.");
      const executable = await factoryRuntime(destination, runtime as Hex, signal);
      // CREATE2 runs in the proxy's context, so the deployer and constructor
      // authority remain the bridge address, never the implementation address.
      const address = predictBridgeToken(token, originalToken, originalRollupId, destination.bridge as Address, manager, executable);
      counterpart = { name:token.name,symbol:token.symbol,decimals:token.decimals,address,chainId:destination.chainId,predicted:true };
    }
  }
  return [
    {...token,origin,isProxy:original !== zeroAddress,bridgeAddress:source.bridge,counterpart:{address:counterpart.address,chainId:destination.chainId}},
    {...counterpart,origin,isProxy:originalRollupId !== destinationRollupId,bridgeAddress:destination.bridge,counterpart:{address:token.address,chainId:source.chainId}},
  ];
}
