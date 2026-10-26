import { useEffect, useState } from "react";
import { DISCOVERED_CHAIN_IDS } from "../config";

const demoPath = `${import.meta.env.BASE_URL}cowdemo/`;

/** Reuse the original standalone UI, served by the selected network's API. */
export function CowLightDemo({ ready }: { ready: boolean }) {
  const [available, setAvailable] = useState(false);
  const [message, setMessage] = useState("Checking CoW Light availability…");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setAvailable(false);
    setMessage("Checking CoW Light availability…");
    void (async () => {
      try {
        const response = await fetch(`${demoPath}api/config`, { signal: controller.signal });
        if (!response.ok) throw new Error("unavailable");
        const demo = await response.json() as { l1ChainId: number; l2ChainId: number };
        if (!active) return;
        if (!DISCOVERED_CHAIN_IDS.l1 || !DISCOVERED_CHAIN_IDS.l2
            || BigInt(demo.l1ChainId) !== BigInt(DISCOVERED_CHAIN_IDS.l1)
            || BigInt(demo.l2ChainId) !== BigInt(DISCOVERED_CHAIN_IDS.l2)) {
          setMessage("CoW Light is configured for a different network. It cannot be opened on this dashboard.");
          return;
        }
        setAvailable(true);
      } catch {
        if (active) setMessage("CoW Light is not available for this network yet.");
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [ready, attempt]);

  return <section aria-label="CoW Light demo">
    {available
      ? <iframe title="CoW Light trading" src={demoPath} style={{ width: "100%", minHeight: "80vh", border: 0 }}
          onLoad={event => {
            // Same-origin embedded UI: keep the dashboard shortcut working
            // when focus is inside the demo, while preserving text entry.
            event.currentTarget.contentDocument?.addEventListener("keydown", key => {
              const target = key.target as HTMLElement | null;
              if (key.defaultPrevented || key.repeat || key.isComposing || key.code !== "KeyT"
                  || !(key.ctrlKey || key.metaKey) || !key.altKey || !key.shiftKey
                  || target?.isContentEditable || target?.closest("input, textarea, select, [role='textbox']")) return;
              const forwarded = new KeyboardEvent("keydown", { code: key.code, key: key.key,
                ctrlKey: key.ctrlKey, metaKey: key.metaKey, altKey: true, shiftKey: true, cancelable: true });
              if (!window.dispatchEvent(forwarded)) key.preventDefault();
            });
          }} />
      : <><p role="status">{message}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></>}
  </section>;
}
