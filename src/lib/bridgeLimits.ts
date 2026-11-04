import { parseEther } from "viem";

// Edit this ETH amount to update both the enforced limit and its validation message.
const MAINNET_ETH_LIMIT_ETH = "0.1";
const MAINNET_ETH_LIMIT_WEI = parseEther(MAINNET_ETH_LIMIT_ETH);
const MAINNET_ETH_LIMIT_MESSAGE = `Only ${MAINNET_ETH_LIMIT_ETH} ETH or less is allowed.`;

/** Use the configured L1 identity in both directions, including withdrawals from its rollup. */
export function nativeBridgeLimit(l1ChainId: string, asset: string): bigint | null {
  return asset === "eth" && BigInt(l1ChainId) === 1n ? MAINNET_ETH_LIMIT_WEI : null;
}

export function bridgeAmountError(l1ChainId: string, asset: string, amount: string): string | null {
  const limit = nativeBridgeLimit(l1ChainId, asset);
  if (limit === null || !amount) return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(amount)) return "Enter a valid ETH amount.";
  const [whole, fraction = ""] = amount.split(".");
  const padded = fraction.padEnd(18, "0");
  const wei = BigInt(whole || "0") * 10n ** 18n + BigInt(padded.slice(0, 18));
  // Do not silently truncate a typed amount just above the limit to the allowed limit.
  return wei > limit || wei === limit && /[1-9]/.test(padded.slice(18))
    ? MAINNET_ETH_LIMIT_MESSAGE : null;
}
