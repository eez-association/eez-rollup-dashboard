import type { Address, Hex } from 'viem';
export type FeeType = '0x0' | '0x2';
export type FeeIntent = { from: Address; to: Address; data?: Hex; value?: Hex; type?: FeeType; chainId?: Hex; nonce?: Hex; gas?: Hex };
export type FeeTransaction = Required<FeeIntent> & { gasPrice?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex };
export type FeeOption = { type: FeeType; gas: Hex; requestHash: Hex; estimatedFee: Hex; gasPrice?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex }
  | { type: FeeType; error: { code: string; message: string } };
export type FeeQuote = {
  version: 1; chainId: Hex; nonce: Hex; expiresAt: Hex; options: FeeOption[];
};

type Validation = { quote: FeeQuote; transaction: FeeIntent; type: FeeType; chainId: Hex; keccak256: (text: string) => string; maxTotalFee: bigint; now?: number };
export function feeQuoteTransaction(options: Validation): FeeTransaction;
export function requestFeeQuote(options: {
  transaction: FeeIntent; transactionTypes?: FeeType[];
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
}): Promise<FeeQuote>;
export function sendFeeQuotedTransaction(options: Validation & {
  wallet: Pick<EthereumProvider, 'request'>;
}): Promise<unknown>;
