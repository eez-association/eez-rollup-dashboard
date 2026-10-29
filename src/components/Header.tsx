import { useState, useRef, useEffect } from "react";
import type { WalletState } from "../types";
import { L1_CHAIN, L2_CHAIN, config } from "../config";
import { ExplorerLink } from "./ExplorerLink";
import styles from "./Header.module.css";
import { NetworkIcon } from "./NetworkIcon";
import { WalletIcon } from "./WalletIcon";
import { ComposerStatus } from "./ComposerStatus";
import type { ComposerDetection } from "../lib/composerDiscovery";
import eezLogo from "../styles/brand/eez-logo.svg";
import eezLogoLight from "../styles/brand/eez-logo-light.svg";

interface Props {
  wallet: WalletState;
  walletName: string | null;
  walletOptions: { id: string; name: string }[];
  onConnect: (providerId?: string) => void;
  onDisconnect: () => void;
  onNavigate?: (view: string) => void;
  currentView?: string;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  currentChainId?: string | null;
  onSwitchL1?: () => void;
  onSwitchL2?: () => void;
  composerConnection?: ComposerDetection;
  checkingComposer?: boolean;
  onRecheckComposer?: () => void;
  onConnectComposer?: () => Promise<void>;
  connectingComposer?: boolean;
  composerSetupMessage?: string;
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "monitor", label: "Monitor" },
  { id: "visualizer", label: "Visualizer" },
  { id: "debug", label: "Debug" },
];

export function Header({
  wallet,
  walletName,
  walletOptions,
  onConnect,
  onDisconnect,
  onNavigate,
  currentView,
  theme,
  onToggleTheme,
  currentChainId,
  onSwitchL1,
  onSwitchL2,
  composerConnection,
  checkingComposer = false,
  onRecheckComposer,
  onConnectComposer,
  connectingComposer,
  composerSetupMessage,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const l1Active = wallet.isConnected && currentChainId === L1_CHAIN.chainId;
  const l2Active = wallet.isConnected && currentChainId === L2_CHAIN.chainId;
  const showChainSwitcher = onSwitchL1 && onSwitchL2;

  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  const ThemeIcon = () =>
    theme === "dark" ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
      </svg>
    );

  const shortAddr = wallet.address
    ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
    : "";

  return (
      <header className={styles.header}>
        {/* ── Left: logo + desktop nav ── */}
        <div className={styles.left}>
          <a className={styles.logo} href="#" aria-label="EEZ rollup dashboard" onClick={(event) => { event.preventDefault(); onNavigate?.("dashboard"); }}>
            <img
              src={theme === "light" ? eezLogoLight : eezLogo}
              alt="EEZ"
              className={styles.logoIcon}
            />
            <span className={styles.productName} title={config.rollupName}>{config.rollupName}</span>
          </a>

          <div className={styles.sep} />

          {onNavigate && (
            <nav className={styles.nav} aria-label="Main navigation">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  className={`${styles.navLink} ${currentView === item.id ? styles.navActive : ""}`}
                  aria-current={currentView === item.id ? "page" : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          )}

        </div>

        {/* ── Right: chain selector + wallet dropdown ── */}
        <div className={styles.right}>
          {showChainSwitcher && wallet.isConnected && (
            <div className={styles.chainSwitcher} role="group" aria-label="Network balances">
              {(["l1", "l2"] as const).map(chain => {
                const l1 = chain === "l1";
                const name = l1 ? config.l1NetworkName : config.rollupName;
                const symbol = (l1 ? L1_CHAIN : L2_CHAIN).nativeCurrency.symbol;
                const balance = l1 ? wallet.l1Balance : wallet.l2Balance;
                const active = l1 ? l1Active : l2Active;
                return <button key={chain} className={`${styles.chainBtn} ${active ? styles.chainBtnActive : ""}`}
                  onClick={l1 ? onSwitchL1 : onSwitchL2} aria-label={`Switch wallet to ${name}`} aria-describedby={`header-balance-${chain}`} aria-pressed={active}
                  title={`${name}: ${balance ?? "—"} ${symbol} · switch wallet network`}>
                  <NetworkIcon chain={chain} className={styles.balanceIcon} decorative />
                  <span id={`header-balance-${chain}`} className={styles.chainBal}>{balance ?? "—"} <span className={styles.balanceUnit}>{symbol}</span></span>
                </button>;
              })}
            </div>
          )}

          {/* Wallet pill + dropdown */}
          <div className={styles.walletArea} ref={dropdownRef}>
            {wallet.isConnected && wallet.address ? (
              <>
                <button
                  className={styles.walletPill}
                  aria-label={walletName ? `${walletName} · ${shortAddr}` : shortAddr}
                  aria-expanded={dropdownOpen}
                  title={walletName ? `${walletName} · ${shortAddr}` : shortAddr}
                  onClick={() => setDropdownOpen((v) => !v)}
                >
                  <WalletIcon name={walletName} className={styles.walletIcon} />
                  <span className={styles.walletLabel}>{walletName ? `${walletName} · ${shortAddr}` : shortAddr}</span>
                  <svg className={`${styles.walletPillChevron} ${dropdownOpen ? styles.walletPillChevronOpen : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {dropdownOpen && (
                  <div className={styles.dropdown}>
                    <div className={styles.ddHeader}>
                      <ExplorerLink
                        value={wallet.address}
                        chain="l2"
                        className={styles.ddAddr}
                        label={shortAddr}
                      />
                    </div>

                    {composerConnection && onRecheckComposer && <ComposerStatus
                      connection={composerConnection} checking={checkingComposer} onRecheck={onRecheckComposer} walletName={walletName}
                      onConnectNetwork={onConnectComposer} connectingNetwork={connectingComposer} setupMessage={composerSetupMessage} />}

                    {onToggleTheme && (
                      <div className={styles.ddSection}>
                        <button className={styles.ddRow} onClick={onToggleTheme}>
                          <ThemeIcon />
                          <span>{theme === "dark" ? "Light" : "Dark"} mode</span>
                        </button>
                      </div>
                    )}

                    {walletOptions.length > 0 && (
                      <div className={styles.ddSection}>
                        {walletOptions.map((option) => (
                          <button key={option.id} className={styles.ddRow} onClick={() => {
                            onConnect(option.id);
                            setDropdownOpen(false);
                          }}>
                            <WalletIcon name={option.name} className={styles.walletIcon} />
                            {option.name === walletName ? `Reconnect ${option.name}` : `Switch to ${option.name}`}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className={styles.ddSection}>
                      <button
                        className={`${styles.ddRow} ${styles.ddRowDanger}`}
                        onClick={() => { onDisconnect(); setDropdownOpen(false); }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                          <polyline points="16 17 21 12 16 7" />
                          <line x1="21" y1="12" x2="9" y2="12" />
                        </svg>
                        <span>Disconnect</span>
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <button className="btn btn-solid btn-sm" onClick={() => {
                  if (walletOptions.length > 0) setDropdownOpen((open) => !open);
                  else onConnect();
                }}>
                  Connect Wallet
                </button>
                {dropdownOpen && walletOptions.length > 0 && (
                  <div className={styles.dropdown}>
                    {walletOptions.map((option) => (
                      <button key={option.id} className={styles.ddRow} onClick={() => {
                        onConnect(option.id);
                        setDropdownOpen(false);
                      }}>
                        <WalletIcon name={option.name} className={styles.walletIcon} />
                        {option.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Hamburger — mobile only */}
          <button
            className={`${styles.hamburger} ${menuOpen ? styles.hamburgerOpen : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
          >
            <span className={styles.hamburgerBar} />
            <span className={styles.hamburgerBar} />
            <span className={styles.hamburgerBar} />
          </button>
        </div>

        {/* ── Mobile slide-down menu ── */}
        {menuOpen && (
          <div className={styles.mobileMenu} role="dialog" aria-modal="true">
            <div className={styles.mobileBackdrop} onClick={() => setMenuOpen(false)} />

            <div className={styles.mobileMenuInner}>
              {onNavigate && (
                <div className={styles.mobileSection}>
                  <span className={styles.mobileSectionLabel}>Navigation</span>
                  {NAV_ITEMS.map((item) => (
                    <button
                      key={item.id}
                      className={`${styles.mobileNavItem} ${currentView === item.id ? styles.mobileNavActive : ""}`}
                      onClick={() => { onNavigate(item.id); setMenuOpen(false); }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}

              {showChainSwitcher && (
                <div className={styles.mobileSection}>
                  <span className={styles.mobileSectionLabel}>Switch Chain</span>
                  <div className={styles.mobileChainRow}>
                    <button
                      className={`${styles.mobileChainBtn} ${styles.mobileChainBtnL1} ${l1Active ? styles.mobileChainActive : ""}`}
                      onClick={() => { onSwitchL1!(); setMenuOpen(false); }}
                    >
                      <span className={styles.chainBtnDot} />
                      L1 &middot; {L1_CHAIN.chainName}
                    </button>
                    <button
                      className={`${styles.mobileChainBtn} ${styles.mobileChainBtnL2} ${l2Active ? styles.mobileChainActive : ""}`}
                      onClick={() => { onSwitchL2!(); setMenuOpen(false); }}
                    >
                      <span className={styles.chainBtnDot} />
                      L2 &middot; {L2_CHAIN.chainName}
                    </button>
                  </div>
                </div>
              )}

              <div className={styles.mobileSection}>
                <span className={styles.mobileSectionLabel}>Wallet</span>
                {wallet.isConnected && wallet.address ? (
                  <div className={styles.mobileWallet}>
                    <div className={styles.mobileWalletRow}>
                      {walletName && <><WalletIcon name={walletName} className={styles.walletIcon} /><span>{walletName}</span></>}
                      <ExplorerLink
                        value={wallet.address}
                        chain="l2"
                        className={styles.ddAddr}
                        label={`${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`}
                      />
                      <button className="btn btn-sm btn-ghost btn-red" onClick={() => { onDisconnect(); setMenuOpen(false); }}>
                        Disconnect
                      </button>
                    </div>
                    {walletOptions.map((option) => (
                      <button key={option.id} className="btn btn-sm btn-ghost" onClick={() => {
                        onConnect(option.id);
                        setMenuOpen(false);
                      }}>
                        <WalletIcon name={option.name} className={styles.walletIcon} />
                        {option.name === walletName ? `Reconnect ${option.name}` : `Switch to ${option.name}`}
                      </button>
                    ))}
                  </div>
                ) : (
                  walletOptions.length > 0 ? walletOptions.map((option) => (
                    <button key={option.id} className="btn btn-solid btn-sm" onClick={() => {
                      onConnect(option.id);
                      setMenuOpen(false);
                    }} style={{ width: "100%" }}>
                      <WalletIcon name={option.name} className={styles.walletIcon} />
                      Connect {option.name}
                    </button>
                  )) : (
                    <button className="btn btn-solid btn-sm" onClick={() => {
                      onConnect();
                      setMenuOpen(false);
                    }} style={{ width: "100%" }}>
                      Connect Wallet
                    </button>
                  )
                )}
              </div>

              {onToggleTheme && (
                <div className={styles.mobileSection}>
                  <button
                    className={`btn btn-sm btn-ghost ${styles.mobileThemeBtn}`}
                    onClick={() => { onToggleTheme(); }}
                  >
                    <ThemeIcon />
                    Switch to {theme === "dark" ? "Light" : "Dark"} Mode
                  </button>
                </div>
              )}

            </div>
          </div>
        )}
      </header>
  );
}
