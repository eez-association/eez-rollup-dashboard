import { decodeEventLog, encodeDeployData, getContractAddress, isAddress, keccak256, maxUint256, parseAbi, parseUnits, zeroAddress, type Abi, type Address, type Hex } from 'viem';

export type TestTokenInput = { name: string; symbol: string; amount: string };
export type TestTokenArtifact = { abi: Abi; bytecode: Hex; runtime: Hex };
export type TestTokenDeployment = {
  version: 1; id: string; chainId: number; account: Address; nonce: Hex;
  input: TestTokenInput; data: Hex; hash?: Hex;
  outcome?: 'confirmed' | 'reverted' | 'replaced'; address?: Address;
};
export type TestTokenRpc = (method: string, params?: unknown[]) => Promise<unknown>;
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** EIP-1193 wallets often reject with plain objects rather than Error instances. */
export function testTokenErrorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  let message = '';
  while (error && !seen.has(error)) {
    seen.add(error);
    if (typeof error === 'string') { if (error.trim()) message = error; break; }
    if (typeof error !== 'object') break;
    const item = error as {message?: unknown; shortMessage?: unknown; cause?: unknown; data?: {originalError?: unknown; cause?: unknown; message?: unknown}};
    const text = item.shortMessage ?? item.message;
    if (typeof text === 'string' && text.trim()) message = text;
    error = item.data?.originalError ?? item.cause ?? item.data?.cause ?? item.data?.message;
  }
  return message || 'The wallet could not prepare this deployment. Check its active network and connection.';
}

export function parseTestToken(input: TestTokenInput) {
  const name = input.name.trim(), symbol = input.symbol.trim(), amount = input.amount.trim();
  check(name.length && new TextEncoder().encode(name).length <= 48, 'Enter a token name of up to 48 bytes.');
  check(/^[a-z\d]{1,12}$/i.test(symbol), 'Use 1–12 letters or numbers for the symbol.');
  check(/^(0|[1-9]\d{0,77})(\.\d{1,18})?$/.test(amount), 'Enter an initial supply with at most 18 decimal places.');
  const supply = parseUnits(amount, 18);
  check(supply > 0n && supply <= maxUint256, 'Initial supply must be positive and fit uint256.');
  return { name, symbol, amount, supply };
}
export async function loadTestTokenArtifact(): Promise<TestTokenArtifact> {
  return (await import('./bridge-test-token-artifact.json')).default as TestTokenArtifact;
}
export function testTokenData(input: TestTokenInput, artifact: TestTokenArtifact): Hex {
  const {name,symbol,supply} = parseTestToken(input);
  return encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode,args:[name,symbol,supply]});
}
export function readTestTokenDeployment(raw: string | null): TestTokenDeployment | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as TestTokenDeployment;
  check(value?.version === 1 && typeof value.id === 'string' && value.id && Number.isSafeInteger(value.chainId) && value.chainId > 0
    && isAddress(value.account) && /^0x[\da-f]+$/i.test(value.nonce) && /^0x(?:[\da-f]{2})+$/i.test(value.data)
    && (!value.hash || hash(value.hash)) && (!value.outcome || ['confirmed','reverted','replaced'].includes(value.outcome))
    && (!value.address || isAddress(value.address)) && (value.outcome !== 'confirmed' || !!value.address && !!value.hash),
  'Saved token deployment is invalid. Preserve it and check your wallet activity.');
  parseTestToken(value.input);
  return value;
}

/** Confirm the actual creation, its canonical block and the initial mint. A
 * replacement closes the request without pretending it deployed a token. */
export async function observeTestToken(rpc: TestTokenRpc, request: TestTokenDeployment, artifact: TestTokenArtifact): Promise<TestTokenDeployment> {
  check(Number(BigInt(await rpc('eth_chainId') as string)) === request.chainId, 'The RPC serves a different network.');
  check(testTokenData(request.input, artifact) === request.data, 'Saved token deployment belongs to a different contract version.');
  if (!request.hash) return request;
  const tx = await rpc('eth_getTransactionByHash',[request.hash]) as {
    hash: string; from: string; to: string | null; nonce: string; input: string; value: string; chainId?: string;
    blockHash: string | null; blockNumber: string | null;
  } | null;
  if (!tx) return request;
  check(same(tx.hash,request.hash) && same(tx.from,request.account) && BigInt(tx.nonce) === BigInt(request.nonce)
    && (tx.chainId === undefined || BigInt(tx.chainId) === BigInt(request.chainId)), 'Transaction does not match the saved wallet, nonce and network.');
  const receipt = await rpc('eth_getTransactionReceipt',[request.hash]) as {
    transactionHash: string; from: string; to: string | null; status: string; blockHash: string; blockNumber: Hex;
    contractAddress: Address | null; logs: {address: Address; data: Hex; topics: [Hex,...Hex[]]}[];
  } | null;
  if (!receipt) return request;
  check(hash(receipt.blockHash) && same(receipt.transactionHash,request.hash) && same(receipt.from,request.account)
    && tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber
    && ['0x0','0x1'].includes(receipt.status), 'Deployment receipt does not match its transaction.');
  const canonical = async () => {
    const block = await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]) as {hash: string} | null;
    check(block?.hash === receipt.blockHash, 'The deployment block changed. Checking again…');
  };
  await canonical();
  if (tx.to !== null || !same(tx.input,request.data) || BigInt(tx.value) !== 0n) return {...request,outcome:'replaced'};
  if (receipt.status === '0x0') return {...request,outcome:'reverted'};
  const address = getContractAddress({from:request.account,nonce:BigInt(request.nonce)});
  check(receipt.to === null && receipt.contractAddress && same(receipt.contractAddress,address), 'Unexpected deployed token address.');
  const runtime = await rpc('eth_getCode',[address,receipt.blockNumber]) as Hex;
  check(keccak256(runtime) === keccak256(artifact.runtime), 'Deployed token code does not match the demo contract.');
  const supply = parseTestToken(request.input).supply;
  const mintAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  check(receipt.logs.some(log => {
    if (!same(log.address,address)) return false;
    try {
      const {args} = decodeEventLog({abi:mintAbi,...log});
      return same(args.from,zeroAddress) && same(args.to,request.account) && args.value === supply;
    } catch { return false; }
  }), 'The receipt does not contain the expected mint to your wallet.');
  await canonical();
  return {...request,outcome:'confirmed',address};
}
