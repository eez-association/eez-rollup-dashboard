import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256, parseAbiParameters, zeroAddress, zeroHash } from "viem";
import type { Address, Hex } from "viem";
import type { DeploymentArtifacts } from "./deployment.ts";

// Arachnid deterministic-deployment-proxy: salt || initcode, returns 20 address bytes.
// https://github.com/Arachnid/deterministic-deployment-proxy
export const matchingDeployer = getAddress("0x4e59b44847b379578588920ca78fbf26c0b4956c");
export const matchingDeployerRuntime = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as Hex;
export const matchingDeployerHash = keccak256(matchingDeployerRuntime);
export type MatchingSafePlan = { version: 1; singleton: Address; factory: Address; safe: Address };
export function matchingSafePlan(owner: Address, salt: Hex, artifacts: DeploymentArtifacts): MatchingSafePlan {
  const singleton = getContractAddress({ opcode: "CREATE2", from: matchingDeployer, salt: zeroHash, bytecode: artifacts.contracts.Safe!.bytecode });
  const factory = getContractAddress({ opcode: "CREATE2", from: matchingDeployer, salt: zeroHash, bytecode: artifacts.contracts.SafeProxyFactory!.bytecode });
  const initializer = encodeFunctionData({ abi: artifacts.contracts.Safe!.abi, functionName: "setup", args: [[owner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] });
  const bytecode = concatHex([artifacts.contracts.SafeProxyFactory!.proxyCreationCode!, encodeAbiParameters(parseAbiParameters("address"), [singleton])]);
  const safe = getContractAddress({ opcode: "CREATE2", from: factory, salt: keccak256(concatHex([keccak256(initializer), salt])), bytecode });
  return { version: 1, singleton, factory, safe };
}
