import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, encodePacked, getContractAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { TokenMeta } from "../hooks/useBridge";
import { rpcCall } from "../rpc.ts";
import { readBridgeToken } from "./bridgeTokens.ts";
import factories from "./bridge-token-artifacts.json" with { type: "json" };

export interface BridgeTokenNetwork { rpc: string; bridge: string; chainId: number; name?: string }
const abi = parseAbi([
  "function wrappedTokenInfo(address) view returns (address,uint64)",
  "function getWrappedToken(address,uint64) view returns (address)",
  "function rollupId() view returns (uint64)",
  "function manager() view returns (address)",
]);

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
  const read = async (network: BridgeTokenNetwork, functionName: "wrappedTokenInfo" | "getWrappedToken" | "rollupId" | "manager", args?: readonly [Address] | readonly [Address,bigint]) => {
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
      const [runtime, managerValue] = await Promise.all([
        rpcCall(destination.rpc,"eth_getCode",[destination.bridge,"latest"],signal), read(destination,"manager"),
      ]);
      if (typeof runtime !== "string" || !/^0x[0-9a-f]+$/i.test(runtime)) throw new Error("Destination bridge is unavailable.");
      const manager = decodeAbiParameters([{type:"address"}],managerValue)[0];
      const address = predictBridgeToken(token, originalToken, originalRollupId, destination.bridge as Address, manager, runtime as Hex);
      counterpart = { name:token.name,symbol:token.symbol,decimals:token.decimals,address,chainId:destination.chainId,predicted:true };
    }
  }
  return [
    {...token,origin,isProxy:original !== zeroAddress,bridgeAddress:source.bridge,counterpart:{address:counterpart.address,chainId:destination.chainId}},
    {...counterpart,origin,isProxy:originalRollupId !== destinationRollupId,bridgeAddress:destination.bridge,counterpart:{address:token.address,chainId:source.chainId}},
  ];
}
