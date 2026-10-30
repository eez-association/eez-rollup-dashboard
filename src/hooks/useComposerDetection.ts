import { useCallback, useEffect, useRef, useState } from "react";
import { config, L1_CHAIN, L2_CHAIN } from "../config";
import { probeComposer, type ComposerDetection } from "../lib/composerDiscovery";

const idle: ComposerDetection = { status: "idle", chainId: null, detail: "" };

/** Wallet RPC changes need not emit chainChanged; focus and retry check anew. */
export function useComposerDetection(provider: EthereumProvider | null, address: string | null, chainId: string | null, ready: boolean, revision = 0) {
  const [connection, setConnection] = useState<ComposerDetection>(idle);
  const [checking, setChecking] = useState(false);
  const checkRef = useRef<() => Promise<ComposerDetection>>(async () => idle);

  useEffect(() => {
    setConnection(idle);
    if (!ready || !provider || !address || !chainId) {
      setChecking(false);
      checkRef.current = async () => idle;
      return;
    }
    let active = true;
    let sequence = 0;
    let inFlight = false;
    const check = async () => {
      const current = ++sequence;
      inFlight = true;
      setChecking(true);
      const result = await probeComposer(provider, {
        l1ChainId: L1_CHAIN.chainId, l2ChainId: L2_CHAIN.chainId,
        registryAddress: config.rollupsAddress, l2Address: config.ccmL2Address,
        rollupManagerAddress: config.rollupManagerAddress,
        l1BridgeAddress: config.l1Bridge, l2BridgeAddress: config.l2Bridge,
      });
      if (!active || current !== sequence) return {
        status: 'unavailable' as const,
        chainId: null,
        detail: 'Wallet connection or Composer check changed. Recheck before continuing.',
      };
      inFlight = false;
      // Even if the RPC cannot answer chainId, offer setup guidance for the
      // wallet's last reported network without claiming positive detection.
      const connection = { ...result, chainId: result.chainId ?? chainId };
      setConnection(connection);
      setChecking(false);
      return connection;
    };
    const refresh = () => {
      if (!inFlight && document.visibilityState === "visible") void check();
    };
    checkRef.current = check;
    void check();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = setInterval(refresh, 30000);
    return () => {
      active = false;
      checkRef.current = async () => idle;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [provider, address, chainId, ready, revision]);

  const recheckComposer = useCallback(() => { void checkRef.current(); }, []);
  const verifyComposer = useCallback(() => checkRef.current(), []);
  return { composerConnection: connection, checkingComposer: checking, recheckComposer, verifyComposer };
}
