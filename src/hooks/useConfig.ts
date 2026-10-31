import { useEffect, useState } from "react";
import { config, setConfig, L1_CHAIN, L2_CHAIN, DISCOVERED_CHAIN_IDS } from "../config";
import { rpcCall } from "../rpc";
import { registerConfiguredContracts } from "../lib/addressBook";
import { l1Identity, nativeCurrency } from "../lib/networkIdentity";

type RuntimeConfig = {
  treasury?: unknown;
  treasuryTokenAddress?: string;
  networkName?: string;
  l1NetworkName?: string;
  l1NetworkLogoUrl?: string;
  l1ExplorerApiUrl?: string;
  tokenListUrl?: string;
  l1RpcUrl?: string;
  l2RpcUrl?: string;
  l1FrontUrl?: string;
  l2FrontUrl?: string;
  l1FeesEnabled?: boolean;
  l2FeesEnabled?: boolean;
  l1FeeMaxTotalWei?: string;
  l2FeeMaxTotalWei?: string;
  l1ExplorerUrl?: string;
  l2ExplorerUrl?: string;
  l2ExplorerApiUrl?: string;
  l1ContractAddress?: string;
  l2ContractAddress?: string;
  rollupManagerAddress?: string;
  bridgeL1Address?: string;
  bridgeL2Address?: string;
  rollupId?: string;
  demoBridgeAddress?: string;
  demoTokenAddress?: string;
  demoPoolAddress?: string;
  demoExecutorL1?: string;
  demoExecutorL2?: string;
  demoWrappedTokenL2?: string;
  demoNftL2?: string;
  reverseExecutorL2?: string;
  reverseNftL1?: string;
  reverseExecutorL1?: string;
  aggWeth?: string;
  aggUsdc?: string;
  aggL1Amm?: string;
  aggAggregator?: string;
  aggL2Executor?: string;
  aggL2Amm?: string;
  aggL2ExecutorProxy?: string;
  aggWrappedWethL2?: string;
  aggWrappedUsdcL2?: string;
};

function absoluteUrl(value: string | undefined): string | undefined {
  return value ? new URL(value, window.location.origin).toString() : undefined;
}

/** Loads runtime config and auto-detects chain IDs from RPCs. */
export function useConfigLoader() {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      let l1NameOverride = "";
      // Current EEZ/Kurtosis runtime configuration. The mapping below is the
      // compatibility layer between the POC UI names and the current network.
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}config.json`);
        if (response.ok) {
          const payload = (await response.json()) as RuntimeConfig & { browser?: RuntimeConfig };
          const runtime: RuntimeConfig = payload.browser ?? payload;
          const rollupName = runtime.networkName?.trim() || payload.networkName?.trim();
          l1NameOverride = runtime.l1NetworkName?.trim() || payload.l1NetworkName?.trim() || "";
          const l1Rpc = absoluteUrl(runtime.l1RpcUrl);
          const l2Rpc = absoluteUrl(runtime.l2RpcUrl);
          const l1ProxyRpc = absoluteUrl(runtime.l1FrontUrl);
          const l2ProxyRpc = absoluteUrl(runtime.l2FrontUrl);
          setConfig({
            treasury: runtime.treasury ?? null,
            treasuryTokenAddress: runtime.treasuryTokenAddress ?? "",
            ...(l1NameOverride ? { l1NetworkName: l1NameOverride } : {}),
            ...(runtime.l1NetworkLogoUrl ? { l1NetworkLogoUrl: absoluteUrl(runtime.l1NetworkLogoUrl)! } : {}),
            ...(runtime.l1ExplorerApiUrl ? { l1ExplorerApi: absoluteUrl(runtime.l1ExplorerApiUrl)! } : {}),
            ...(runtime.tokenListUrl ? { tokenListUrl: absoluteUrl(runtime.tokenListUrl)! } : {}),
            ...(rollupName ? { rollupName } : {}),
            ...(l1Rpc ? { l1Rpc } : {}),
            ...(l2Rpc ? { l2Rpc } : {}),
            ...(l1ProxyRpc ? { l1ProxyRpc } : {}),
            ...(l2ProxyRpc ? { l2ProxyRpc } : {}),
            l1FeesEnabled: runtime.l1FeesEnabled === true,
            l2FeesEnabled: runtime.l2FeesEnabled === true,
            ...(runtime.l1FeeMaxTotalWei ? { l1FeeMaxTotalWei: runtime.l1FeeMaxTotalWei } : {}),
            ...(runtime.l2FeeMaxTotalWei ? { l2FeeMaxTotalWei: runtime.l2FeeMaxTotalWei } : {}),
            ...(runtime.l1ExplorerUrl ? { l1Explorer: runtime.l1ExplorerUrl } : {}),
            ...(runtime.l2ExplorerUrl ? { l2Explorer: runtime.l2ExplorerUrl } : {}),
            ...(runtime.l2ExplorerApiUrl ? { l2ExplorerApi: runtime.l2ExplorerApiUrl } : {}),
            ...(runtime.l1ContractAddress ? { rollupsAddress: runtime.l1ContractAddress } : {}),
            ...(runtime.rollupManagerAddress ? { rollupManagerAddress: runtime.rollupManagerAddress } : {}),
            ...(runtime.rollupId ? { rollupId: runtime.rollupId } : {}),
            // The legacy demo address is only a fallback. Independently
            // deployed L1 and L2 bridges can have different addresses.
            ...(runtime.demoBridgeAddress ? {
              l1Bridge: runtime.demoBridgeAddress,
              l2Bridge: runtime.demoBridgeAddress,
            } : {}),
            ...(runtime.bridgeL1Address ? { l1Bridge: runtime.bridgeL1Address } : {}),
            ...(runtime.bridgeL2Address ? { l2Bridge: runtime.bridgeL2Address } : {}),
            ...(runtime.demoExecutorL1 ? { flashExecutorL1: runtime.demoExecutorL1 } : {}),
            ...(runtime.demoTokenAddress ? { flashTokenAddress: runtime.demoTokenAddress } : {}),
            ...(runtime.demoPoolAddress ? { flashPoolAddress: runtime.demoPoolAddress } : {}),
            ...(runtime.demoNftL2 ? { flashNftAddress: runtime.demoNftL2 } : {}),
            ...(runtime.demoExecutorL2 ? { flashExecutorL2: runtime.demoExecutorL2 } : {}),
            ...(runtime.demoWrappedTokenL2 ? { flashWrappedTokenL2: runtime.demoWrappedTokenL2 } : {}),
            ...(runtime.l2ContractAddress ? { ccmL2Address: runtime.l2ContractAddress } : {}),
            ...(runtime.reverseExecutorL2 ? { reverseExecutorL2: runtime.reverseExecutorL2 } : {}),
            ...(runtime.reverseNftL1 ? { reverseNftL1: runtime.reverseNftL1 } : {}),
            ...(runtime.reverseExecutorL1 ? { reverseExecutorL1: runtime.reverseExecutorL1 } : {}),
            ...(runtime.aggWeth ? { aggWeth: runtime.aggWeth } : {}),
            ...(runtime.aggUsdc ? { aggUsdc: runtime.aggUsdc } : {}),
            ...(runtime.aggL1Amm ? { aggL1Amm: runtime.aggL1Amm } : {}),
            ...(runtime.aggAggregator ? { aggAggregator: runtime.aggAggregator } : {}),
            ...(runtime.aggL2Executor ? { aggL2Executor: runtime.aggL2Executor } : {}),
            ...(runtime.aggL2Amm ? { aggL2Amm: runtime.aggL2Amm } : {}),
            ...(runtime.aggL2ExecutorProxy ? { aggL2ExecutorProxy: runtime.aggL2ExecutorProxy } : {}),
            ...(runtime.aggWrappedWethL2 ? { aggWrappedWethL2: runtime.aggWrappedWethL2 } : {}),
            ...(runtime.aggWrappedUsdcL2 ? { aggWrappedUsdcL2: runtime.aggWrappedUsdcL2 } : {}),
          });
        }
      } catch {
        /* Runtime config is unavailable; retain defaults and URL parameters. */
      }

      registerConfiguredContracts(config);

      // Auto-detect chain IDs from RPCs
      DISCOVERED_CHAIN_IDS.l1 = null;
      DISCOVERED_CHAIN_IDS.l2 = null;
      try {
        const l1ChainId = (await rpcCall(
          config.l1Rpc,
          "eth_chainId",
        )) as string;
        L1_CHAIN.chainId = l1ChainId;
        if (typeof l1ChainId === "string" && /^0x[0-9a-f]+$/i.test(l1ChainId)) DISCOVERED_CHAIN_IDS.l1 = l1ChainId;
        const identity = l1Identity(l1ChainId);
        L1_CHAIN.nativeCurrency = nativeCurrency(l1ChainId);
        L2_CHAIN.nativeCurrency = nativeCurrency(l1ChainId);
        setConfig({ l1NetworkName: l1NameOverride || identity.name, l1NetworkLogo: identity.logo, l1IsEthereumMainnet: BigInt(l1ChainId) === 1n });
      } catch {
        /* keep defaults */
      }

      try {
        const l2ChainId = (await rpcCall(
          config.l2Rpc,
          "eth_chainId",
        )) as string;
        L2_CHAIN.chainId = l2ChainId;
        if (typeof l2ChainId === "string" && /^0x[0-9a-f]+$/i.test(l2ChainId)) DISCOVERED_CHAIN_IDS.l2 = l2ChainId;
        L2_CHAIN.chainName = config.rollupName;
      } catch {
        /* keep defaults */
      }

      setLoaded(true);
    })();
  }, []);

  return loaded;
}
