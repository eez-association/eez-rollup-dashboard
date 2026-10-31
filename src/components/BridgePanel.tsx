import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import type { BridgeState, BridgeDirection, BridgeAsset, TokenMeta } from "../hooks/useBridge";
import { config, L1_CHAIN, L2_CHAIN } from "../config";
import { GasLimitEditor } from "./GasLimitEditor";
import { BridgeTransactionDialog } from "./BridgeTransactionDialog";
import styles from "./BridgePanel.module.css";
import { BridgeTokenPicker } from "./BridgeTokenPicker";
import { BridgeAssetSwap } from "./BridgeAssetSwap";
import { WalletIcon } from "./WalletIcon";
import { BridgeFeeQuote } from "./BridgeFeeQuote";

interface Props {
  state: BridgeState;
  recentTokens: TokenMeta[];
  walletAddress: string | null;
  walletOptions: { id: string; name: string }[];
  onConnect: (providerId?: string) => void;
  onSetDirection: (dir: BridgeDirection) => void;
  onSetAsset: (asset: BridgeAsset) => void;
  onSetAmount: (amt: string) => void;
  onSetDestination: (addr: string) => void;
  onSetTokenAddress: (addr: string, pair?: [TokenMeta, TokenMeta]) => void;
  onSetMax: () => void;
  onApprove: () => void;
  onBridge: () => void;
  onDismiss: () => void;
  onGasOverride: (gasHex: string | null) => void;
  onRefreshFees: () => void;
}

export function BridgePanel({
  state,
  recentTokens,
  walletAddress,
  walletOptions,
  onConnect,
  onSetDirection,
  onSetAsset,
  onSetAmount,
  onSetDestination,
  onSetTokenAddress,
  onSetMax,
  onApprove,
  onBridge,
  onDismiss,
  onGasOverride,
  onRefreshFees,
}: Props) {
  const [editingRecipient, setEditingRecipient] = useState(false);
  const [choosingWallet, setChoosingWallet] = useState(false);
  const connectButton = useRef<HTMLButtonElement>(null);
  const firstWallet = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (choosingWallet) firstWallet.current?.focus(); }, [choosingWallet]);
  useEffect(() => { if (walletAddress) setChoosingWallet(false); }, [walletAddress]);
  const {
    phase, direction, asset, amount, tokenAddress, tokenMeta,
    sourceBalance, sourceBalanceRaw, allowance,
    l1BridgeReady, l2BridgeReady, gas, destinationAddress, tokenNeedsApproval, tokenReadError,
  } = state;

  const nativeSymbol = (direction === "l1-to-l2" ? L1_CHAIN : L2_CHAIN).nativeCurrency.symbol;
  const feesEnabled = direction === "l1-to-l2" ? config.l1FeesEnabled : config.l2FeesEnabled;
  const ethereumSource = BigInt((direction === "l1-to-l2" ? L1_CHAIN : L2_CHAIN).chainId) === 1n;
  const busy = !["idle", "confirmed", "failed"].includes(phase);
  const sourceBridgeReady = direction === "l1-to-l2" ? l1BridgeReady : l2BridgeReady;
  const sourceBridgeError = direction === "l1-to-l2" ? state.l1BridgeError : state.l2BridgeError;
  const bridgeConfigured = direction === "l1-to-l2" ? !!config.l1Bridge : !!config.l2Bridge;
  const invalidRecipient = !!destinationAddress && !/^0x[0-9a-fA-F]{40}$/.test(destinationAddress);

  // Determine if approval is needed
  const decimals = asset === "eth" ? 18 : (tokenMeta?.decimals ?? 18);
  let rawAmount = 0n;
  if (amount) {
    try {
      const parts = amount.split(".");
      const whole = parts[0] || "0";
      const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
      rawAmount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
    } catch { /* ignore */ }
  }
  const needsApproval = asset === "erc20" && tokenNeedsApproval === true && allowance !== null && rawAmount > 0n && allowance < rawAmount;

  // Insufficient balance check
  let insufficientBalance = false;
  if (amount && sourceBalanceRaw !== null && rawAmount > 0n) {
    insufficientBalance = rawAmount > sourceBalanceRaw;
  }

  const canBridge =
    !!walletAddress &&
    !busy && phase !== "confirmed" && !state.maxPending && !state.maxError &&
    sourceBridgeReady &&
    (gas.status === "estimated" || gas.status === "unsupported" && !!state.gasOverrideHex) &&
    amount &&
    rawAmount > 0n &&
    !invalidRecipient &&
    !insufficientBalance &&
    !needsApproval &&
    (asset === "eth" || tokenMeta !== null && !tokenMeta.predicted && tokenNeedsApproval !== null && sourceBalanceRaw !== null && /^0x[0-9a-fA-F]{40}$/.test(tokenAddress));

  const disabledReason = !walletAddress ? null :
    !canBridge && !busy && sourceBridgeReady && rawAmount > 0n ?
      asset === "erc20" && tokenReadError ? `Unable to check the token: ${tokenReadError}. Retrying…` :
      asset === "erc20" && (tokenNeedsApproval === null || sourceBalanceRaw === null) ? "Checking token balance and approval…" :
      insufficientBalance ? `Insufficient ${asset === "eth" ? nativeSymbol : tokenMeta?.symbol || "token"} balance on ${direction === "l1-to-l2" ? "L1" : "L2"}.` :
      needsApproval ? `Approve ${tokenMeta?.symbol || "the token"} before bridging.` :
      gas.status === "idle" || gas.status === "estimating" ? "Waiting for a Composer gas estimate…" : null : null;

  const actionLabel = asset === "eth" ? `Bridge ${nativeSymbol}` : `Bridge ${tokenMeta?.symbol || "Tokens"}`;
  const sourceSide = direction === "l1-to-l2" ? "l1" : "l2";
  const destinationSide = sourceSide === "l1" ? "l2" : "l1";
  const destinationChainId = Number(BigInt((destinationSide === "l1" ? L1_CHAIN : L2_CHAIN).chainId));
  const destinationBridge = destinationSide === "l1" ? config.l1Bridge : config.l2Bridge;
  const counterpart = tokenMeta?.counterpart;
  const destinationToken = counterpart?.chainId === destinationChainId ? recentTokens.find(token =>
    token.chainId === destinationChainId && token.address.toLowerCase() === counterpart.address.toLowerCase()
    && token.bridgeAddress?.toLowerCase() === destinationBridge.toLowerCase()) : undefined;
  const selectedTokens = { [sourceSide]: tokenMeta ?? undefined, [destinationSide]: destinationToken };

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>Bridge</span>
      </div>

      {/* Warning: bridge not deployed */}
      {!bridgeConfigured && (
        <div className={styles.warningBar}>
          Bridge contracts are not configured for this network.
        </div>
      )}
      {bridgeConfigured && sourceBridgeReady === null && (
        <div className={styles.phaseBar} role="status">
          {sourceBridgeError
            ? `Unable to check the bridge on ${direction === "l1-to-l2" ? "L1" : "L2"}. Retrying…`
            : `Checking bridge on ${direction === "l1-to-l2" ? "L1" : "L2"}…`}
        </div>
      )}
      {bridgeConfigured && sourceBridgeReady === false && (
        <div className={styles.warningBar}>
          Bridge contract not deployed or not initialized on {direction === "l1-to-l2" ? "L1" : "L2"}.
        </div>
      )}

      <BridgeAssetSwap
        direction={direction} asset={asset} amount={amount}
        received={rawAmount > 0n ? formatUnits(rawAmount, decimals) : ""}
        symbol={tokenMeta?.symbol || null} balance={sourceBalance} connected={!!walletAddress}
        tokens={selectedTokens}
        disabled={busy} maxPending={state.maxPending} maxError={state.maxError}
        onDirectionChange={onSetDirection}
        renderTokenPicker={(chain, close) => <BridgeTokenPicker
          key={chain} direction={chain === "l1" ? "l1-to-l2" : "l2-to-l1"} walletAddress={walletAddress} disabled={busy}
          asset={asset} tokenAddress={chain === sourceSide ? tokenAddress : destinationToken?.address ?? ""} recentTokens={recentTokens}
          onClose={close} onSelect={(address, pair) => {
            if (!address) { if (asset !== "eth") onSetAsset("eth"); }
            else {
              // A picker resolves its clicked network first. Keep the form's
              // source network fixed when selecting from the destination panel.
              const sourcePair: [TokenMeta, TokenMeta] | undefined = chain === sourceSide ? pair : pair ? [pair[1], pair[0]] : undefined;
              if (chain !== sourceSide && !sourcePair) return;
              const sourceAddress = sourcePair?.[0].address ?? address;
              if (asset !== "erc20" || sourceAddress.toLowerCase() !== tokenAddress.toLowerCase()) onSetAsset("erc20");
              onSetTokenAddress(sourceAddress, sourcePair);
            }
            close();
          }}
        />}
        onAmountChange={onSetAmount} onMax={onSetMax}
        recipient={<div className={styles.recipientSection}>
          <div className={styles.recipientHeader}>
            <div>
              <div className={styles.sectionTitle}>Recipient</div>
              {!editingRecipient && !destinationAddress && <div className={styles.recipientWallet}>
                Your wallet <span title={walletAddress || undefined}>{walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : "Connect a wallet"}</span>
              </div>}
            </div>
            <button className={styles.recipientToggle} disabled={busy}
              aria-expanded={editingRecipient || !!destinationAddress} aria-controls="bridge-recipient"
              onClick={() => {
                if (editingRecipient || destinationAddress) { onSetDestination(""); setEditingRecipient(false); }
                else setEditingRecipient(true);
              }}>
              {editingRecipient || destinationAddress ? "Use my wallet" : "Change recipient"}
            </button>
          </div>
          {(editingRecipient || destinationAddress) && <div id="bridge-recipient">
            <input type="text" className={styles.input} aria-label="Recipient address"
              value={destinationAddress} onChange={(e) => onSetDestination(e.target.value)}
              placeholder={walletAddress || "0x... (defaults to your wallet)"} disabled={busy} />
            <div className={styles.sectionHint}>Leave empty to use your connected wallet.</div>
            {invalidRecipient && <div className={styles.validationHint} role="status">Enter a valid recipient address.</div>}
          </div>}
      </div>}
      />

      {asset === "erc20" && tokenMeta?.predicted && <p className={styles.sectionHint}>This token will be deployed when it is first bridged to this network.</p>}

      {/* Gas settings are already collapsed; keep estimation errors visible. */}
      {gas.status === "unsupported" && gas.errorMessage && <div className={styles.validationHint} role="status">{gas.errorMessage}</div>}
      {!needsApproval && phase !== "confirmed" && gas.status === "error" && gas.errorMessage && (
        <div className={styles.errorBar} role="alert">Gas estimation failed: {gas.errorMessage}</div>
      )}
      {feesEnabled && phase !== "confirmed" && !needsApproval && amount && rawAmount > 0n && sourceBridgeReady && (
        <BridgeFeeQuote fees={state.fees} sentToWallet={phase === "sending" || phase === "tx-pending"}
          disabled={busy || gas.status !== "estimated" && !state.gasOverrideHex || needsApproval}
          onRefresh={onRefreshFees} />
      )}
      {amount && rawAmount > 0n && sourceBridgeReady && (
        <details className={styles.gasSettings}>
          <summary>Gas settings</summary>
          <GasLimitEditor
            estimatedGas={gas.estimate}
            estimatedGasWithBuffer={gas.gasLimit}
            estimating={gas.status === "estimating"}
            onGasOverride={onGasOverride}
            disabled={busy}
          />
          {feesEnabled && <div className={styles.feeGuidance} role="note" aria-label="Wallet fee guidance">
            <p>The quoted network fee includes settlement on {direction === "l1-to-l2" ? "L2" : "L1"}. Changing the gas limit does not set the priority fee (tip).</p>
            {ethereumSource && <>
              <p><strong>MetaMask:</strong> Keep <strong>Site suggested</strong> fees and review the gas limit, max fee and priority fee before confirming.</p>
              <p><strong>Rabby:</strong> It may replace the quoted fees with its own estimate. A lower tip can prevent the bridge from being accepted. If you cannot verify the quoted fees in Rabby, use MetaMask with Site suggested fees.</p>
            </>}
            <p>Your wallet must submit through this network’s Composer RPC. Receiving a fee quote does not change the wallet’s RPC.</p>
          </div>}
        </details>
      )}

      {/* Approval button (ERC20 step 1) */}
      {needsApproval && !busy && (
        <>
          <div className={styles.approveNote}>Step 1 of 2 — Approve token spending</div>
          <button
            className="btn btn-solid btn-accent btn-block"
            onClick={onApprove}
          >
            Approve {tokenMeta?.symbol || "Token"}
          </button>
        </>
      )}

      {disabledReason && <div className={!walletAddress ? styles.sectionHint : styles.validationHint} role="status">{disabledReason}</div>}

      {choosingWallet && <div className={styles.walletPicker} role="group" aria-label="Choose a wallet"
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setChoosingWallet(false); connectButton.current?.focus(); } }}>
        {walletOptions.length ? walletOptions.map((option, index) => <button key={option.id}
          ref={index === 0 ? firstWallet : undefined} className="btn btn-outline" type="button"
          onClick={() => { onConnect(option.id); setChoosingWallet(false); connectButton.current?.focus(); }}>
          <WalletIcon name={option.name} className={styles.walletIcon} />{option.name}
        </button>) : <p className={styles.sectionHint}>Install or unlock Rabby or MetaMask to connect.</p>}
      </div>}

      {/* Bridge button */}
      <button
        className="btn btn-solid btn-green btn-block"
        ref={connectButton}
        onClick={walletAddress ? onBridge : () => setChoosingWallet(!choosingWallet)}
        aria-expanded={!walletAddress ? choosingWallet : undefined}
        disabled={!!walletAddress && !canBridge}
      >
        {!walletAddress ? "Connect wallet" : busy ? (
          <><span className="btn-spinner" /> Bridging...</>
        ) : (
          actionLabel
        )}
      </button>

      <BridgeTransactionDialog state={state} onDismiss={onDismiss} />
    </div>
  );
}
