import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { config, L1_CHAIN, L2_CHAIN } from "./config";
import { formatUnits } from "viem";
import { useConfigLoader } from "./hooks/useConfig";
import { useLog } from "./hooks/useLog";
import { useWallet } from "./hooks/useWallet";
import { useCounter } from "./hooks/useCounter";
import { useCrossChain, crossChainRoute, type CrossChainDirection } from "./hooks/useCrossChain";
import { lookupAddressForChain } from "./lib/addressBook";
import { useBridge } from "./hooks/useBridge";
import { useTxHistory } from "./hooks/useTxHistory";
import { useBlockscoutAbi } from "./hooks/useBlockscoutAbi";
import { useRecentAddresses } from "./hooks/useRecentAddresses";
import { NetworkMonitorView } from "./monitor/NetworkMonitorView";
import { Header } from "./components/Header";
import { ComposerStatus } from "./components/ComposerStatus";
import { CounterPanel } from "./components/CounterPanel";
import { CrossChainPanel } from "./components/CrossChainPanel";
import { ProxyDeploySection } from "./components/ProxyDeploySection";
import { CrossChainCallBuilder } from "./components/CrossChainCallBuilder";
import { CrossChainTransactionDialog } from "./components/CrossChainTransactionDialog";
import { BridgePanel } from "./components/BridgePanel";
import { TxHistoryPanel } from "./components/TxHistoryPanel";
import { QuoteDebugger } from "./components/QuoteDebugger";
import styles from "./App.module.css";

const VisualizerView = lazy(() => import("./components/VisualizerView").then(module => ({ default: module.VisualizerView })));
const TreasuryDemo = lazy(() => import("./components/TreasuryDemo").then(module => ({ default: module.TreasuryDemo })));
const CowLightDemo = lazy(() => import("./components/CowLightDemo").then(module => ({ default: module.CowLightDemo })));
const FalconDemo = lazy(() => import("./components/FalconDemo").then(module => ({ default: module.FalconDemo })));

const TREASURY_VISIBILITY_KEY = "eez:treasury-demo:visible";

function treasuryVisibleForSession(): boolean {
  try { return sessionStorage.getItem(TREASURY_VISIBILITY_KEY) === "1"; }
  catch { return false; }
}

// Flash-loan and aggregator views are retained but are not enabled on this network.
type DashboardTab = "dashboard" | "counter-demo" | "treasury-demo" | "cow-demo" | "falcon-demo";
const isHiddenDemo = (tab: DashboardTab) => tab === "treasury-demo" || tab === "cow-demo" || tab === "falcon-demo";

/** Dashboard sub-tabs that can be deep-linked via hash */
const HASH_TO_TAB: Record<string, DashboardTab> = {
  "counter-demo": "counter-demo",
  "treasury-demo": "treasury-demo",
  "cow-demo": "cow-demo",
  "falcon-demo": "falcon-demo",
  // Keep saved bridge links opening the combined dashboard.
  "bridge": "dashboard",
};

function getInitialView(): string {
  const raw = window.location.hash.replace("#/", "").replace("#", "");
  const hash = raw.split("?")[0];
  if (hash === "monitor") return "monitor";
  if (hash === "visualizer") return "visualizer";
  if (hash === "debug") return "debug";
  if (window.location.pathname === "/monitor" || window.location.pathname === "/monitor/") return "monitor";
  return "dashboard";
}

function getInitialTab(treasuryVisible: boolean): DashboardTab {
  const raw = window.location.hash.replace("#/", "").replace("#", "");
  const hash = raw.split("?")[0] || "";
  const tab = HASH_TO_TAB[hash] ?? "dashboard";
  return isHiddenDemo(tab) && !treasuryVisible ? "dashboard" : tab;
}

/** Parse ?key=value from the hash fragment (e.g. #/?target=0x...) */
function getHashParam(key: string): string | null {
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return null;
  const params = new URLSearchParams(hash.slice(qIdx));
  return params.get(key);
}

const DASHBOARD_TABS: { id: DashboardTab; label: string }[] = [
  { id: "dashboard", label: "Bridge & Calls" },
  { id: "counter-demo", label: "Counter Demo" },
  { id: "treasury-demo", label: "Treasury Demo" },
  { id: "cow-demo", label: "CoW Light Demo" },
  { id: "falcon-demo", label: "Falcon Safe Demo" },
];

export function App() {
  const configLoaded = useConfigLoader();

  const { entries: _entries, log } = useLog();
  const wallet = useWallet(log, configLoaded);
  const [counterChain, setCounterChain] = useState<"l1" | "l2">("l2");
  const counterL1 = useCounter(log, wallet.sendL1Tx, { chain: "l1", senderAddress: wallet.address, ready: configLoaded });
  const counterL2 = useCounter(log, wallet.sendTx, { chain: "l2", senderAddress: wallet.address, ready: configLoaded });
  const counter = counterChain === "l1" ? counterL1 : counterL2;
  const counterDirection: CrossChainDirection = counterChain === "l1" ? "l2-to-l1" : "l1-to-l2";
  const crossChainOptions = { sendL2Tx: wallet.sendTx, sendL2ProxyTx: wallet.sendL2ProxyTx, senderAddress: wallet.address, ready: configLoaded };
  const crossChain = useCrossChain(log, wallet.sendL1Tx, wallet.sendL1ProxyTx, crossChainOptions);
  const crossChainGeneric = useCrossChain(log, wallet.sendL1Tx, wallet.sendL1ProxyTx, crossChainOptions);
  const bridgeHook = useBridge(log, wallet.sendTx, wallet.sendL2ProxyTx, wallet.sendL1Tx, wallet.sendL1ProxyTx, wallet.address, configLoaded, wallet.quoteProxyFees);
  const bridgeFromL1 = bridgeHook.state.direction === "l1-to-l2";
  const bridgeFeesEnabled = bridgeFromL1 ? config.l1FeesEnabled : config.l2FeesEnabled;
  const bridgeFeeCap = bridgeFromL1 ? config.l1FeeMaxTotalWei : config.l2FeeMaxTotalWei;
  const bridgeSourceChain = bridgeFromL1 ? L1_CHAIN : L2_CHAIN;

  const txHistory = useTxHistory();
  const latestBridgeState = useRef(bridgeHook.state);
  latestBridgeState.current = bridgeHook.state;
  const switchBridgeNetwork = async (chain: "l1" | "l2") => {
    const switched = await (chain === "l1" ? wallet.switchToL1() : wallet.switchToL2());
    const direction = chain === "l1" ? "l1-to-l2" : "l2-to-l1";
    if (switched && ["idle", "confirmed", "failed"].includes(latestBridgeState.current.phase)
        && direction !== latestBridgeState.current.direction) bridgeHook.setDirection(direction);
    return switched;
  };

  // Dashboard tab hooks
  const [genericTargetAddr, setGenericTargetAddr] = useState<string>(() => {
    return getHashParam("target") || "";
  });
  const [genericDirection, setGenericDirection] = useState<CrossChainDirection>("l1-to-l2");
  const [selectingProxy, setSelectingProxy] = useState(false);
  const proxySelectionPending = useRef(false);
  const [proxySelectionError, setProxySelectionError] = useState<string | null>(null);
  const destinationChain = crossChainRoute(genericDirection).destination;
  const blockscoutAbi = useBlockscoutAbi(genericTargetAddr, destinationChain);
  const recentAddrs = useRecentAddresses(destinationChain);

  const [view, setView] = useState(getInitialView);
  const [treasuryVisible, setTreasuryVisible] = useState(treasuryVisibleForSession);
  const [visualizerRoute, setVisualizerRoute] = useState(() => window.location.hash);
  const visualizerParams = new URLSearchParams(visualizerRoute.split("?")[1] ?? "");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>(() => getInitialTab(treasuryVisible));
  const [returnToTreasury, setReturnToTreasury] = useState(false);
  useEffect(() => {
    document.title = `${view === "debug" ? "Quote Debugger" : view === "visualizer" ? "Execution Visualizer" : view === "monitor" ? "Network Monitor" : dashboardTab === "counter-demo" ? "Counter Demo" : dashboardTab === "treasury-demo" ? "Treasury Demo" : dashboardTab === "cow-demo" ? "CoW Light Demo" : dashboardTab === "falcon-demo" ? "Falcon Safe Demo" : "Dashboard"} — ${config.rollupName}`;
  }, [view, dashboardTab, configLoaded]);

  /** Switch dashboard sub-tab and update hash for deep linking */
  const switchTab = useCallback((tab: DashboardTab) => {
    setDashboardTab(tab);
    window.location.hash = tab === "dashboard" ? "" : `#/${tab}`;
  }, []);

  const openTreasuryGasBridge = (destination: "l1" | "l2") => {
    const current = latestBridgeState.current;
    if (!["idle", "confirmed", "failed"].includes(current.phase) || current.phase === "failed" && current.txHash) {
      throw new Error("A bridge transfer is still unresolved. Open Bridge & Calls and finish checking it before starting another.");
    }
    bridgeHook.setDirection(destination === "l2" ? "l1-to-l2" : "l2-to-l1");
    bridgeHook.setAsset("eth");
    bridgeHook.setDestination("");
    bridgeHook.setGasOverride(null);
    setReturnToTreasury(true);
    switchTab("dashboard");
  };

  const navigate = useCallback((v: string) => {
    setView(v);
    const pathname = v === "monitor" ? "/monitor/" : import.meta.env.BASE_URL;
    window.history.pushState(null, "", v === "visualizer" || v === "debug" ? `${pathname}#/${v}` : pathname);
    if (v === "visualizer") setVisualizerRoute(window.location.hash);
    if (v === "dashboard") setDashboardTab("dashboard");
  }, []);

  // This is a per-tab navigation preference, not authorization. A direct URL
  // must not reveal the unfinished example before the shortcut is used.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.repeat || event.isComposing
          || !(event.ctrlKey || event.metaKey) || !event.altKey || !event.shiftKey || event.code !== "KeyT"
          || (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role='textbox']")))) return;
      event.preventDefault();
      const visible = !treasuryVisible;
      setTreasuryVisible(visible);
      try {
        if (visible) sessionStorage.setItem(TREASURY_VISIBILITY_KEY, "1");
        else sessionStorage.removeItem(TREASURY_VISIBILITY_KEY);
      } catch { /* Storage can be unavailable; the shortcut still works until reload. */ }
      if (visible) {
        navigate("dashboard");
        switchTab("treasury-demo");
      } else if (isHiddenDemo(dashboardTab)) {
        switchTab("counter-demo");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [treasuryVisible, dashboardTab, navigate, switchTab]);

  // Listen for browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const raw = window.location.hash.replace("#/", "").replace("#", "").split("?")[0];
      // Check for target deep link
      const target = getHashParam("target");
      if (target) setGenericTargetAddr(target);
      // Deep link to dashboard sub-tabs (e.g. #/counter-demo, #/bridge)
      const tab = raw ? HASH_TO_TAB[raw] : undefined;
      setDashboardTab(tab && isHiddenDemo(tab) && !treasuryVisible ? "dashboard" : tab ?? "dashboard");
      setView(getInitialView());
      setVisualizerRoute(window.location.hash);
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
    };
  }, [treasuryVisible]);

  // Track counter demo cross-chain transactions in history
  const ccTxRef = useRef<string | null>(null);
  const prevCCPhase = useRef(crossChain.state.phase);

  useEffect(() => {
    const { phase, txHash, targetAddress, direction } = crossChain.state;

    if (
      (phase === "creating-proxy" || phase === "sending") &&
      prevCCPhase.current !== phase
    ) {
      const type = phase === "creating-proxy" ? "cross-chain-proxy" : "cross-chain-call";
      const label =
        phase === "creating-proxy"
          ? `Proxy for ${targetAddress.slice(0, 10)}...`
          : `Call → ${targetAddress.slice(0, 10)}...`;
      ccTxRef.current = txHistory.addTx(type, label, null, direction);
    }

    if (txHash && ccTxRef.current && (phase === "proxy-pending" || phase === "l1-pending" || phase === "l2-pending")) {
      txHistory.updateTx(ccTxRef.current, { hash: txHash });
    }

    if ((phase === "confirmed" || phase === "failed") && ccTxRef.current) {
      txHistory.updateTx(ccTxRef.current, {
        status: phase === "confirmed" ? "confirmed" : "failed",
        hash: txHash ?? undefined,
      });
      ccTxRef.current = null;
    }

    prevCCPhase.current = phase;
  }, [crossChain.state.phase, crossChain.state.txHash]);

  // Read the destination counter after source-chain confirmation; polling continues
  // to pick up any later state visibility on either network.
  useEffect(() => {
    if (crossChain.state.phase === "confirmed" && crossChain.state.calldata) void counter.refresh();
  }, [crossChain.state.phase, crossChain.state.txHash, counter.refresh]);

  // Track generic cross-chain transactions in history
  const ccGenTxRef = useRef<string | null>(null);
  const prevCCGenPhase = useRef(crossChainGeneric.state.phase);

  useEffect(() => {
    const { phase, txHash, targetAddress, direction } = crossChainGeneric.state;

    if (
      (phase === "creating-proxy" || phase === "sending") &&
      prevCCGenPhase.current !== phase
    ) {
      const type = phase === "creating-proxy" ? "cross-chain-proxy" : "cross-chain-call";
      const label =
        phase === "creating-proxy"
          ? `Proxy for ${targetAddress.slice(0, 10)}...`
          : `Call → ${lookupAddressForChain(targetAddress, crossChainRoute(direction).destination) || targetAddress.slice(0, 10) + "…"}`;
      ccGenTxRef.current = txHistory.addTx(type, label, null, direction);
    }

    if (txHash && ccGenTxRef.current && (phase === "proxy-pending" || phase === "l1-pending" || phase === "l2-pending")) {
      txHistory.updateTx(ccGenTxRef.current, { hash: txHash });
    }

    if ((phase === "confirmed" || phase === "failed") && ccGenTxRef.current) {
      txHistory.updateTx(ccGenTxRef.current, {
        status: phase === "confirmed" ? "confirmed" : "failed",
        hash: txHash ?? undefined,
      });
      ccGenTxRef.current = null;
    }

    prevCCGenPhase.current = phase;
  }, [crossChainGeneric.state.phase, crossChainGeneric.state.txHash]);

  // Track bridge transactions in history
  const bridgeTxRef = useRef<string | null>(null);
  const prevBridgePhase = useRef(bridgeHook.state.phase);

  useEffect(() => {
    const { phase, txHash, direction, asset, amount, tokenMeta } = bridgeHook.state;

    if (phase === "sending" && prevBridgePhase.current !== "sending") {
      const symbol = asset === "eth" ? (direction === "l1-to-l2" ? L1_CHAIN : L2_CHAIN).nativeCurrency.symbol : (tokenMeta?.symbol || "tokens");
      const dirLabel = direction === "l1-to-l2" ? "L1\u2192L2" : "L2\u2192L1";
      bridgeTxRef.current = txHistory.addTx(
        "bridge",
        `Bridge ${amount} ${symbol} ${dirLabel}`,
        null,
        direction,
      );
    }

    if (txHash && bridgeTxRef.current && phase === "tx-pending") {
      txHistory.updateTx(bridgeTxRef.current, { hash: txHash });
    }

    if ((phase === "confirmed" || phase === "failed") && bridgeTxRef.current) {
      txHistory.updateTx(bridgeTxRef.current, {
        status: phase === "confirmed" ? "confirmed" : "failed",
        hash: txHash ?? undefined,
      });
      bridgeTxRef.current = null;
    }

    prevBridgePhase.current = phase;
  }, [bridgeHook.state.phase, bridgeHook.state.txHash]);

  // Track auto-detected proxy from ProxyDeploySection (on-chain but not in localStorage)
  const [autoDetectedProxy, setAutoDetectedProxy] = useState<{ address: string; target: string; direction: CrossChainDirection } | null>(null);
  const handleProxyDetected = useCallback((address: string | null, target: string, direction: CrossChainDirection) => {
    setAutoDetectedProxy(address ? { address, target, direction } : null);
  }, []);

  // A newly verified on-chain proxy takes priority over an older browser mapping.
  const savedProxy = genericTargetAddr
    ? crossChainGeneric.getProxy(genericTargetAddr, genericDirection)
    : null;
  const genericProxy = (autoDetectedProxy?.target === genericTargetAddr && autoDetectedProxy.direction === genericDirection ? autoDetectedProxy.address : null) || savedProxy;

  const selectGenericProxy = async (target: string, direction: CrossChainDirection) => {
    if (proxySelectionPending.current || !["idle", "confirmed", "failed"].includes(crossChainGeneric.state.phase)) return;
    proxySelectionPending.current = true;
    setSelectingProxy(true); setProxySelectionError(null);
    try {
      const cached = crossChainGeneric.getProxy(target, direction);
      if (cached) await crossChainGeneric.verifyProxy(target, cached, direction);
      if (wallet.address && !await switchBridgeNetwork(crossChainRoute(direction).source)) {
        setProxySelectionError("Wallet network switch was cancelled. Your selected proxy has not changed.");
        return;
      }
      crossChainGeneric.reset();
      setGenericDirection(direction); setGenericTargetAddr(target);
    } catch (error) {
      setProxySelectionError(`Cannot verify proxy: ${error instanceof Error ? error.message : String(error)}`);
    } finally { proxySelectionPending.current = false; setSelectingProxy(false); }
  };

  // Wrapper for generic sendCrossChainCall that also saves to recent addresses
  const handleGenericSendCall = useCallback(
    (proxy: string, calldata: string, target?: string, _value?: string, gas?: string) => {
      if (target) recentAddrs.addAddress(target);
      crossChainGeneric.sendCrossChainCall(proxy, calldata, target, _value, gas, genericDirection);
    },
    [crossChainGeneric, recentAddrs, genericDirection],
  );

  if (!configLoaded) return null;

  return (
    <>
      <a className="eez-skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <Header
        wallet={wallet}
        walletName={wallet.walletName}
        walletOptions={wallet.walletOptions}
        onConnect={wallet.connect}
        onDisconnect={wallet.disconnect}
        onNavigate={navigate}
        currentView={view}
        theme="dark"
        currentChainId={wallet.chainId}
        onSwitchL1={() => { void switchBridgeNetwork("l1"); }}
        onSwitchL2={() => { void switchBridgeNetwork("l2"); }}
        composerConnection={wallet.composerConnection}
        checkingComposer={wallet.checkingComposer}
        onRecheckComposer={wallet.recheckComposer}
        onConnectComposer={wallet.connectComposer}
        connectingComposer={wallet.connectingComposer}
        composerSetupMessage={wallet.composerSetupMessage}
      />

      {wallet.isConnected && <ComposerStatus connection={wallet.composerConnection}
        checking={wallet.checkingComposer} onRecheck={wallet.recheckComposer} walletName={wallet.walletName} variant="notice"
        onConnectNetwork={wallet.connectComposer} connectingNetwork={wallet.connectingComposer} setupMessage={wallet.composerSetupMessage} />}

      {view === "monitor" ? (
        <NetworkMonitorView />
      ) : view === "debug" ? (
        <QuoteDebugger ready={configLoaded} />
      ) : view === "visualizer" ? (
        <Suspense fallback={<main id="main" tabIndex={-1} className={styles.page}>Loading visualizer…</main>}>
          <VisualizerView
            key={visualizerRoute}
            onBack={() => navigate("dashboard")}
            initialDebugHash={visualizerParams.get("tx") ?? visualizerParams.get("debug")}
            initialMode={visualizerParams.get("mode")}
            configReady={configLoaded}
            initialChain={visualizerParams.get("chain")}
            initialBlock={visualizerParams.get("block")}
            initialCounterpart={visualizerParams.get("counterpart")}
            initialBatch={visualizerParams.get("batch")}
            initialSelected={visualizerParams.get("selected")}
            initialSelectedChain={visualizerParams.get("selectedChain")}
            initialEvent={visualizerParams.get("event")}
            initialTab={visualizerParams.get("tab")}
            initialCall={visualizerParams.get("call")}
          />
        </Suspense>
      ) : (
        <main id="main" tabIndex={-1} className={styles.page} data-dashboard>
          <section className={`${styles.intro} eez-intro`} aria-labelledby="page-heading">
            <div>
              <p className="eez-eyebrow">[ {config.rollupName} · DASHBOARD ]</p>
              <h1 id="page-heading" className="eez-page-heading">Toward a <strong>synchronous Ethereum</strong></h1>
              <p className="eez-description">Experience <strong>atomic synchronous composability</strong> across L1 and L2 with EEZ</p>
            </div>
            <a className="eez-pill" href="https://eez-demos.vercel.app/" target="_blank" rel="noopener noreferrer">
              Quickstarts <span className="eez-arrow" aria-hidden="true">→</span>
            </a>
          </section>

          <nav className={styles.tabs} aria-label="Dashboard sections">
            {DASHBOARD_TABS.filter(tab => !isHiddenDemo(tab.id) || treasuryVisible).map((tab) => (
              <button
                key={tab.id}
                className={`${styles.tab} ${dashboardTab === tab.id ? styles.tabActive : ""}`}
                aria-current={dashboardTab === tab.id ? "page" : undefined}
                onClick={() => switchTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            {dashboardTab === "dashboard" && (
              <div className={styles.dashboardGrid}>
                <section className={styles.bridgeColumn} aria-label="Bridge transfers">
                  {returnToTreasury && treasuryVisible && <div className={styles.feeNotice} role="region" aria-label="Safe setup funding">
                    <p>Your Safe setup is saved. Bridge native currency to your wallet, then return to continue.</p>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => {
                      setReturnToTreasury(false); switchTab("treasury-demo");
                    }}>Return to Safe setup</button>
                  </div>}
                  <BridgePanel
                    state={bridgeHook.state}
                    recentTokens={bridgeHook.recentTokens}
                    walletAddress={wallet.address}
                    walletOptions={wallet.walletOptions}
                    onConnect={wallet.connect}
                    onSetDirection={bridgeHook.setDirection}
                    onSetAsset={bridgeHook.setAsset}
                    onSetAmount={bridgeHook.setAmount}
                    onSetDestination={bridgeHook.setDestination}
                    onSetTokenAddress={bridgeHook.setTokenAddress}
                    onSetMax={bridgeHook.setMax}
                    onApprove={bridgeHook.approve}
                    onBridge={bridgeHook.bridge}
                    onDismiss={bridgeHook.dismiss}
                    onGasOverride={bridgeHook.setGasOverride}
                    onRefreshFees={bridgeHook.refreshFees}
                  />
                  {bridgeFeesEnabled && (
                    <p className={styles.feeNotice} role="status">
                      {bridgeFromL1 ? "L1 → L2" : "L2 → L1"} transactions include settlement in their network fee.
                      {" "}App fee cap: {formatUnits(BigInt(bridgeFeeCap), bridgeSourceChain.nativeCurrency.decimals)} {bridgeSourceChain.nativeCurrency.symbol}, excluding the amount sent.
                    </p>
                  )}
                </section>

                <section className={styles.proxyColumn} aria-label="Cross-chain contracts">
                  <div className={styles.workflowHeader}>
                    <h2>Cross-Chain Calls</h2>
                    <p>Call a contract or address on either network through its proxy.</p>
                  </div>
                  <ProxyDeploySection
                    embedded
                    direction={genericDirection}
                    selecting={selectingProxy}
                    onDirectionChange={direction => { void selectGenericProxy("", direction); }}
                    onSelectProxy={(target, direction) => { void selectGenericProxy(target, direction); }}
                    state={crossChainGeneric.state}
                    targetAddress={genericTargetAddr}
                    onTargetChange={setGenericTargetAddr}
                    contractName={blockscoutAbi.contractName}
                    recentAddresses={recentAddrs.addresses}
                    savedProxies={crossChainGeneric.savedProxies}
                    savedL2Proxies={crossChainGeneric.savedL2Proxies}
                    onCreateProxy={crossChainGeneric.createProxy}
                    onSaveProxy={crossChainGeneric.registerProxy}
                    onLookupProxy={crossChainGeneric.lookupProxy}
                    onRemoveProxy={(target, direction) => {
                      crossChainGeneric.removeProxy(target, direction);
                      if (direction === genericDirection && target.toLowerCase() === genericTargetAddr.toLowerCase()) {
                        setGenericTargetAddr(""); setAutoDetectedProxy(null); crossChainGeneric.reset();
                      }
                      setProxySelectionError(null);
                    }}
                    getProxy={crossChainGeneric.getProxy}
                    computeProxyAddress={crossChainGeneric.computeProxyAddress}
                    onProxyDetected={handleProxyDetected}
                  />
                  {proxySelectionError && <p role="alert">{proxySelectionError}</p>}

                  <CrossChainCallBuilder
                    embedded
                    key={`${genericDirection}:${genericTargetAddr}:${genericProxy}`}
                    direction={genericDirection}
                    selecting={selectingProxy}
                    targetAddress={genericTargetAddr}
                    proxyAddress={genericProxy}
                    abi={blockscoutAbi.abi}
                    abiLoading={blockscoutAbi.loading}
                    abiError={blockscoutAbi.error}
                    contractName={blockscoutAbi.contractName}
                    crossChainState={crossChainGeneric.state}
                    onSendCall={handleGenericSendCall}
                    destinationRpc={destinationChain === "l1" ? config.l1Rpc : config.l2Rpc}
                    senderAddress={wallet.address}
                  />
                  <CrossChainTransactionDialog state={crossChainGeneric.state} onDismiss={crossChainGeneric.reset} />
                </section>
              </div>
            )}

            {dashboardTab === "counter-demo" && (
              <div className={styles.dashboardGrid}>
                <CounterPanel
                  key={counterChain}
                  chain={counterChain}
                  onChainChange={chain => { crossChain.reset(); counter.reset(); setCounterChain(chain); }}
                  address={counter.address}
                  onAddressChange={address => { crossChain.reset(); counter.reset(); counter.setAddress(address); }}
                  count={counter.count}
                  prevCount={counter.prevCount}
                  readError={counter.readError}
                  busy={counterL1.busy || counterL2.busy || !["idle", "confirmed", "failed"].includes(crossChain.state.phase)}
                  walletConnected={wallet.isConnected}
                  txStatus={counter.txStatus}
                  onDeploy={counter.deploy}
                  onIncrement={counter.increment}
                  onRefresh={counter.refresh}
                  onReset={counter.reset}
                />

                <CrossChainPanel
                  state={crossChain.state}
                  direction={counterDirection}
                  counterAddress={counter.address}
                  counterReady={counter.count !== null}
                  senderAddress={wallet.address}
                  locked={counterL1.busy || counterL2.busy}
                  onCreateProxy={crossChain.createProxy}
                  onSendCall={crossChain.sendCrossChainCall}
                  getProxy={crossChain.getProxy}
                  computeProxyAddress={crossChain.computeProxyAddress}
                  verifyProxy={crossChain.verifyProxy}
                  onReset={crossChain.reset}
                />
              </div>
            )}

            {treasuryVisible && dashboardTab === "treasury-demo" && (
              <Suspense fallback={<p role="status">Loading treasury preview…</p>}>
                <TreasuryDemo wallet={wallet} ready={configLoaded} onBridgeGas={openTreasuryGasBridge} />
              </Suspense>
            )}

            {treasuryVisible && dashboardTab === "cow-demo" && (
              <Suspense fallback={<p role="status">Loading CoW Light demo…</p>}>
                <CowLightDemo ready={configLoaded} wallet={wallet} />
              </Suspense>
            )}

            {treasuryVisible && dashboardTab === "falcon-demo" && (
              <Suspense fallback={<p role="status">Loading Falcon Safe demo…</p>}>
                <FalconDemo ready={configLoaded} wallet={wallet} />
              </Suspense>
            )}

            {!isHiddenDemo(dashboardTab) && <TxHistoryPanel
              records={txHistory.records}
              onClear={txHistory.clearHistory}
              onInspect={(hash, chain) => { window.location.hash = `#/visualizer?mode=trace&chain=${chain}&tx=${hash}`; }}
            />}


          </div>
        </main>
      )}
      <footer className={styles.footer}>
        <span>[ EEZ NETWORK ]</span>
        <a href="https://eez-demos.vercel.app/" target="_blank" rel="noopener noreferrer">Learn how EEZ works ↗</a>
      </footer>
    </>
  );
}
