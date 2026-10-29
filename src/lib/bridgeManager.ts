import { getAddress, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";

/** Prefer the current bridge getter; older bridges expose manager() instead.
 * A valid address (including zero) is returned for the caller to validate.
 * Never fall back merely because the address differs from an expected binding.
 */
export async function readBridgeManager(call: (data: Hex) => Promise<unknown>): Promise<Address> {
  const read = async (signature: "EEZContract()" | "manager()") => {
    const result = await call(toFunctionSelector(signature));
    if (typeof result !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(result)) {
      throw new Error(`Invalid bridge ${signature} response`);
    }
    return getAddress(`0x${result.slice(-40)}`);
  };
  try { return await read("EEZContract()"); }
  catch { return read("manager()"); }
}
