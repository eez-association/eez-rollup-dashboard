import type { Address, Hex } from 'viem';

export type ChainBinding = { chainId: number; chainName: string; anchor: { blockNumber: bigint; blockHash: Hex }; explorer: string };
export type CodeBinding = { address: Address; runtimeCodeHash: Hex };
export type SafeDeployment = {
  factory: CodeBinding; singleton: CodeBinding; fallbackHandler: CodeBinding;
  proxyRuntimeCodeHash: Hex; version: '1.4.1'; nativeSymbol: string;
};
/** Public deployment data. No RPC URL or per-user controller or Safe belongs here. */
export type CrossChainDeployment = {
  l2: ChainBinding & { verifier: CodeBinding; manager: Address; rollupId: bigint; factory: CodeBinding };
  l1: ChainBinding & { registry: Address; safe?: SafeDeployment };
};

// Verified shared contracts; each user's controller and Safe are discovered on chain.
export const crossChainDeployment: CrossChainDeployment = {
  "l2": {
    "chainId": 916969,
    "chainName": "EEZ-X Devnet",
    "anchor": {
      "blockNumber": 0n,
      "blockHash": "0xbb9e52d97581ec62134cdfd6a4c21330de6002557f66fb8bd49b3e2f800d80ae"
    },
    "explorer": "https://eez.asuscomm.com/explorer",
    "verifier": {
      "address": "0x1F7B6E9BfC86F2d72C44E3cEF9b133C59c57C6E9",
      "runtimeCodeHash": "0x28402fe675b2e0b8fdcb281c7b5bef4c441ba32adae6b68c30f9471d87af0e66"
    },
    "manager": "0x4B2760F84B83d6b3829E30A7573B0172B6d6402C",
    "rollupId": 4n,
    "factory": {
      "address": "0x935808C804FC35a3C38BAf6Dd1cf4b408352a3CB",
      "runtimeCodeHash": "0x93ec6840b188b566b275539225b59d720a99db2595b5957abe9fc0b9a163615d"
    }
  },
  "l1": {
    "chainId": 10200,
    "chainName": "Chiado",
    "anchor": {
      "blockNumber": 23506829n,
      "blockHash": "0x03d75a655f0b00711678405da0c224eacaa78c5949105e353caaf37e019e6561"
    },
    "explorer": "https://gnosis-chiado.blockscout.com",
    "registry": "0x3b1d212f8f352c2d9334733aa31cf7546f15c239",
    "safe": {
      "factory": {
        "address": "0xB90b9d8305E5E6Dc87B9173B7c0dC3b4AE7ec04B",
        "runtimeCodeHash": "0xeea179ee3c7e7b0256cda8c560ea68f877778a527441ddb32cf3295f8c8e6c57"
      },
      "singleton": {
        "address": "0xC4a2532Bb5971Ff541f0B24A92ADa2E2ceEbA2c3",
        "runtimeCodeHash": "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff"
      },
      "fallbackHandler": {
        "address": "0x020f1891Acf82bA9127b5ccF86858e4dd55d8eA6",
        "runtimeCodeHash": "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9"
      },
      "proxyRuntimeCodeHash": "0xb30ba1e3d8e15fff550f82025529177dabc8e791b5473a8f0e66d5f6f08bffbf",
      "version": "1.4.1",
      "nativeSymbol": "xDAI"
    }
  }
};
