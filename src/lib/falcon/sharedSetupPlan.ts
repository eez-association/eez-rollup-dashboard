import { concatHex, encodeAbiParameters, getContractAddress, keccak256, pad, parseAbiParameters, toHex, type Address, type Hex } from 'viem';
import artifacts from './setup-artifacts.json' with { type: 'json' };
import { matchingDeployer } from '../treasury/matchingSafes.ts';

export type SetupContract = {
  id: 'verifier' | 'controllerFactory' | 'safeFactory'; chain: 'l1' | 'l2'; label: string;
  address: Address; runtimeCodeHash: Hex; runtime: Hex; data: Hex;
};

/** Constructor immutables and CREATE2 initcode are derived together. A different
 * verifier, destination chain or Safe implementation produces a different address.
 */
export function sharedSetupPlan(manager: Address, l1ChainId: number, singleton: Address, handler: Address): SetupContract[] {
  function contract(id: SetupContract['id'], chain: SetupContract['chain'], label: string,
    name: keyof typeof artifacts.contracts, args: Hex, values: Record<string, Address | bigint>) {
    const artifact = artifacts.contracts[name];
    const salt = keccak256(toHex(`eez:falcon:shared:v1:${name}`));
    const bytecode = concatHex([artifact.bytecode as Hex, args]);
    let runtime = artifact.runtime as Hex;
    for (const [field, ranges] of Object.entries(artifact.immutables)) {
      const value = values[field];
      if (value === undefined) throw new Error(`Missing Falcon immutable: ${field}`);
      const word = pad(typeof value === 'bigint' ? toHex(value) : value, { size: 32 }).slice(2).toLowerCase();
      for (const { start, length } of ranges) {
        if (length !== 32) throw new Error('Unexpected Falcon immutable size');
        const offset = 2 + start * 2;
        runtime = `${runtime.slice(0, offset)}${word}${runtime.slice(offset + length * 2)}` as Hex;
      }
    }
    return { id, chain, label, address: getContractAddress({ opcode: 'CREATE2', from: matchingDeployer, salt, bytecode }),
      runtimeCodeHash: keccak256(runtime), runtime, data: concatHex([salt, bytecode]) };
  }
  const verifier = contract('verifier', 'l2', 'Falcon verifier', 'FalconVerifier', '0x', {});
  const controllerFactory = contract('controllerFactory', 'l2', 'Controller factory', 'FalconL1ControllerFactory',
    encodeAbiParameters(parseAbiParameters('address, address, uint256'), [verifier.address, manager, BigInt(l1ChainId)]),
    { verifier: verifier.address, eezL2: manager, l1ChainId: BigInt(l1ChainId) });
  const safeFactory = contract('safeFactory', 'l1', 'Safe factory', 'OwnedSafeFactory',
    encodeAbiParameters(parseAbiParameters('address, address'), [singleton, handler]), { singleton, fallbackHandler: handler });
  return [verifier, controllerFactory, safeFactory];
}
