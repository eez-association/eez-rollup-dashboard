import { keccak256, toHex } from 'viem';
import { loadMainnetManifest } from './mainnetSetup.ts';
import type { MainnetTarget, SetupNetwork } from './mainnetSetup.ts';
import profile from './paired-testnet-network.json' with { type: 'json' };

export function savedNetworkKey(target: MainnetTarget, bridgeL1: string, bridgeL2: string, token: string) {
  return `eez:treasury:network-selection:${keccak256(toHex(JSON.stringify([profile, target, bridgeL1.toLowerCase(), bridgeL2.toLowerCase(), token.toLowerCase()])))}`;
}

/** An untrusted display hint only. The caller must validate the live network
 * before wallet actions; no balances, nonces or approvals are cached here. */
export function savedNetwork(storage: Pick<Storage, 'getItem'>, key: string, bridgeL1: string, bridgeL2: string, token: string, target: MainnetTarget): SetupNetwork | null {
  try {
    const network = JSON.parse(storage.getItem(key) ?? 'null') as SetupNetwork | null;
    if (!network?.testnet || network.registry.toLowerCase() !== profile.registry.toLowerCase()
      || network.manager.toLowerCase() !== profile.manager.toLowerCase()
      || network.chains.l1.chainId !== profile.chains.l1.chainId || network.chains.l2.chainId !== profile.chains.l2.chainId) return null;
    const manifest = loadMainnetManifest(storage, network), payment = manifest?.payments;
    if (!manifest || manifest.environment !== 'dashboard-testnet' || manifest.registry.toLowerCase() !== profile.registry.toLowerCase()
      || manifest.manager.toLowerCase() !== profile.manager.toLowerCase() || !payment?.pair || payment.tokenL1.toLowerCase() !== token.toLowerCase()
      || payment.bridgeL1.toLowerCase() !== bridgeL1.toLowerCase() || payment.bridgeL2.toLowerCase() !== bridgeL2.toLowerCase()) return null;
    const resolved = (url: string) => new URL(url, globalThis.location?.href ?? 'http://127.0.0.1').href;
    for (const chain of ['l1', 'l2'] as const) if (manifest[chain].chainId !== profile.chains[chain].chainId
      || resolved(manifest[chain].rpc) !== resolved(target[chain].rpc) || !manifest[chain].front
      || resolved(manifest[chain].front!) !== resolved(target[chain].front)) return null;
    return network;
  } catch { return null; }
}
