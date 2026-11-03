import { decodeFunctionResult, encodeFunctionData, hexToBytes, keccak256, parseAbi, stringToHex, toHex } from "viem";

/** Virtual address answered by Composer fronts; no contract is deployed here. */
export const COMPOSER_DISCOVERY_ADDRESS = "0x7Ae2c80116976915a0Ee9b7994e7Bb12026087f8";
export const COMPOSER_DISCOVERY_MARKER = keccak256(stringToHex("EEZ_COMPOSER_DISCOVERY"));
export const COMPOSER_DISCOVERY_ABI = parseAbi([
  "function composerInfo(bytes32 nonce) view returns (bytes32 marker, uint256 schemaVersion, bytes32 echoedNonce, uint256 sourceChainId, bytes info)",
]);

export interface ComposerInfo {
  version: string;
  supportedNetworks: { eezL1: number; eezL2: number };
  eezContracts: {
    eezRegistryAddress: string;
    eezL2Address: string;
    eezRollupManagerAddress?: string;
    eezL1BridgeSender?: string;
    eezL2BridgeReceiver?: string;
  };
}

export interface ComposerExpectation {
  l1ChainId: string;
  l2ChainId: string;
  registryAddress: string;
  l2Address: string;
  rollupManagerAddress?: string;
  l1BridgeAddress?: string;
  l2BridgeAddress?: string;
}

export interface ComposerDetection {
  status: "idle" | "detected" | "not-detected" | "mismatch" | "unavailable" | "unsupported-network";
  chainId: string | null;
  detail: string;
  info?: ComposerInfo;
}

type Provider = Pick<EthereumProvider, "request">;

function chainId(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[\da-f]+$/i.test(value)) throw new Error("Invalid wallet chain ID");
  return BigInt(value);
}

/** Provider responses are untrusted; malformed IDs must not throw during render. */
export function sameChainId(actual: unknown, expected: unknown): boolean {
  try { return chainId(actual) === chainId(expected); }
  catch { return false; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function address(value: unknown): value is string {
  return typeof value === "string" && /^0x[\da-f]{40}$/i.test(value) && BigInt(value) !== 0n;
}

function parseInfo(bytes: `0x${string}`): ComposerInfo {
  const info: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(bytes)));
  if (!record(info) || typeof info.version !== "string" || !info.version.trim() || info.version.length > 128
      || !record(info.supportedNetworks) || !record(info.eezContracts)) throw new Error("Invalid Composer metadata");
  for (const key of ["eezL1", "eezL2"] as const) {
    const id = info.supportedNetworks[key];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid Composer network IDs");
  }
  for (const key of ["eezRegistryAddress", "eezL2Address"] as const) {
    if (!address(info.eezContracts[key])) throw new Error("Invalid Composer contract addresses");
  }
  for (const key of ["eezRollupManagerAddress", "eezL1BridgeSender", "eezL2BridgeReceiver"] as const) {
    if (info.eezContracts[key] !== undefined && !address(info.eezContracts[key])) throw new Error("Invalid Composer contract addresses");
  }
  return info as unknown as ComposerInfo;
}

/** Always uses the selected wallet, never a dashboard HTTP/read RPC. */
export async function probeComposer(
  provider: Provider,
  expected: ComposerExpectation,
  timeoutMs = 8000,
): Promise<ComposerDetection> {
  let sourceChain: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = async (): Promise<ComposerDetection> => {
    const before = chainId(await provider.request({ method: "eth_chainId" }));
    sourceChain = toHex(before);
    if (before !== chainId(expected.l1ChainId) && before !== chainId(expected.l2ChainId)) {
      return { status: "unsupported-network", chainId: sourceChain, detail: "Select a dashboard network to check Composer" };
    }
    // Changing calldata avoids reusing wallet caches after an RPC change.
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const data = encodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, functionName: "composerInfo", args: [nonce] });
    const response = await provider.request({
      method: "eth_call",
      params: [{ to: COMPOSER_DISCOVERY_ADDRESS, data }, "latest"],
    });
    const after = chainId(await provider.request({ method: "eth_chainId" }));
    if (before !== after) throw new Error("Wallet network changed during verification; recheck Composer");
    if (response === "0x") {
      return { status: "not-detected", chainId: sourceChain, detail: "The wallet read did not identify Composer." };
    }
    if (typeof response !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(response) || response.length > 32770) {
      throw new Error("Invalid Composer discovery response");
    }
    const [marker, schema, echoedNonce, sourceChainId, bytes] = decodeFunctionResult({
      abi: COMPOSER_DISCOVERY_ABI, functionName: "composerInfo", data: response as `0x${string}`,
    });
    if (marker.toLowerCase() !== COMPOSER_DISCOVERY_MARKER) throw new Error("Unrecognized Composer discovery marker");
    if (schema !== 1n) throw new Error("Unsupported Composer discovery version");
    if (echoedNonce.toLowerCase() !== nonce.toLowerCase()) throw new Error("Composer discovery nonce did not match; recheck Composer");
    const info = parseInfo(bytes);
    const mismatch = (detail: string): ComposerDetection => ({ status: "mismatch", chainId: sourceChain, detail, info });
    if (sourceChainId !== before) return mismatch("Composer source chain does not match the wallet network");
    if (BigInt(info.supportedNetworks.eezL1) !== chainId(expected.l1ChainId)
        || BigInt(info.supportedNetworks.eezL2) !== chainId(expected.l2ChainId)) {
      return mismatch("Composer serves a different L1/L2 network pair");
    }
    const contracts: [string, string | undefined, string | undefined][] = [
      ["L1 registry", expected.registryAddress, info.eezContracts.eezRegistryAddress],
      ["L2 manager", expected.l2Address, info.eezContracts.eezL2Address],
      ["rollup manager", expected.rollupManagerAddress, info.eezContracts.eezRollupManagerAddress],
      ["L1 bridge", expected.l1BridgeAddress, info.eezContracts.eezL1BridgeSender],
      ["L2 bridge", expected.l2BridgeAddress, info.eezContracts.eezL2BridgeReceiver],
    ];
    for (const [name, configured, advertised] of contracts) {
      // Optional bindings may be absent on older deployment configurations.
      if (configured && advertised && configured.toLowerCase() !== advertised.toLowerCase()) {
        return mismatch(`Composer ${name} address does not match this dashboard`);
      }
    }
    return { status: "detected", chainId: sourceChain, detail: "The wallet read reached Composer for this deployment", info };
  };
  try {
    return await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Composer verification timed out; recheck your wallet RPC")), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { status: "unavailable", chainId: sourceChain, detail: error instanceof Error ? error.message.slice(0, 240) : "Unable to verify the wallet RPC" };
  } finally {
    clearTimeout(timer);
  }
}
