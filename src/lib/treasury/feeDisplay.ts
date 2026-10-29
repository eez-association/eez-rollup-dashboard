/** Round wei to two decimal places in gwei without floating-point conversion. */
export function formatGwei(wei: bigint): string {
  const hundredths = (wei + 5_000_000n) / 10_000_000n;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

export function describeFeeRates(fee: { price: string; priority?: string }): string {
  const price = formatGwei(BigInt(fee.price));
  return fee.priority === undefined
    ? `Gas price: ${price} gwei · Max priority fee: Not applicable.`
    : `Max gas price: ${price} gwei · Max priority fee: ${formatGwei(BigInt(fee.priority))} gwei.`;
}
