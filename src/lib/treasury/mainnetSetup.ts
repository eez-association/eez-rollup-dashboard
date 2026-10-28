import { discoverSafeInfrastructure } from "./safeInfrastructure.ts";
import { matchingDeployer, matchingDeployerHash, matchingSafePlan } from "./matchingSafes.ts";
import type { MatchingSafePlan } from "./matchingSafes.ts";
import { appendSourceRequest } from "./sourceVerification.ts";
import type { SourceRequest } from "./sourceVerification.ts";
import { concatHex, decodeEventLog, encodeAbiParameters, encodeDeployData, encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256, parseAbi, parseAbiParameters, toHex, zeroAddress, zeroHash } from "viem";
import type { Abi, Address, Hex } from "viem";
import { DeploymentIO } from "./deploymentIO.ts";
import type { Chain, DeploymentArtifacts, DeploymentPending, DeploymentTarget } from "./deployment.ts";
import { inspectSafe, matchingSafeCode, ownerFingerprint, packSafeCalls } from "./safeSetup.ts";
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals, packOwnerApprovals, safeTransactionHash, safeTypedDataJSON } from "./safeTransactions.ts";
import { TreasuryClient, parseTreasuryConfig } from "./client.ts";
import type { Approval, TreasuryConfig } from "./client.ts";
import { decodeSafeExecution } from "./safeEvents.ts";
import { EIP1967_IMPLEMENTATION_SLOT, USDC_IMPLEMENTATION_SLOT } from "./mainnet.ts";
import { quoteCrossChainFees } from "../fees/payment.mjs";
import { probeComposer } from "../composerDiscovery.ts";
import official from "./official-safe-deployments.json" with { type: "json" };
import network from "./mainnet-network.json" with { type: "json" };
import sharedContracts from "./mainnet-shared-contracts.json" with { type: "json" };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function readInBatches<T>(items: readonly T[], read: (item: T) => Promise<void>) {
  for (let offset = 0; offset < items.length; offset += 4) await Promise.all(items.slice(offset, offset + 4).map(read));
}
const digest = (x: unknown): x is Hex => typeof x === "string" && /^0x[\da-f]{64}$/i.test(x);
export type SetupNetwork = typeof network & { testnet?: boolean };
export const setupIdentity = (selected: SetupNetwork) => keccak256(toHex(JSON.stringify(selected)));
const identity = setupIdentity(network);
export const mainnetSetupKey = `eez:treasury:paired-setup:${identity}`;
export const mainnetManifestKey = `${mainnetSetupKey}:manifest`;
export const mainnetSetupSteps = [
  { label: "Prepare Ethereum policy", chain: "l1", details: ["Reuse the selected Ethereum Safe", "Reuse the normal bridge and USDC", "Deploy the local treasury policy"] },
  { label: "Connect your mirror Safe", chain: "l2", details: ["Deploy or reuse the EEZ-X mirror", "Use the Ethereum Safe’s live owners", "Reuse verified Safe infrastructure"] },
  { label: "Prepare EEZ-X policy", chain: "l2", details: ["Deploy the same policy contract on EEZ-X", "Use the existing wrapped USDC and normal bridge", "Prepare the local allowance module"] },
  { label: "Connect Ethereum execution", chain: "l1", details: ["Connect live owner verification", "Prepare the mirror and policy aliases"] },
  { label: "Approve Ethereum setup", chain: "l1", details: ["Connect the EEZ-X peer policy", "Enable the allowance module if needed", "Grant the Ethereum policy 100 USDC per ten minutes"] },
  { label: "Approve EEZ-X setup", chain: "l1", details: ["Connect the Ethereum peer policy", "Grant the EEZ-X policy 100 USDC per ten minutes", "Validate and activate both policies in this batch"] },
] as const;
export function mainnetSetupStepsFor(state?: { version: number; creation?: "create-both"; matching?: MatchingSafePlan } | null) {
  if (state && state.version !== 3) throw new Error("Legacy treasury setup is retired. Start a new paired setup.");
  if (state?.creation === "create-both") return mainnetSetupSteps.map((step, index) => index === 0
    ? { ...step, label: "Create your Ethereum Safe", details: ["Create a Safe owned by your connected wallet (1 of 1)", state.matching ? "Prepare identical Safe infrastructure on both chains" : "Reuse verified Safe deployment contracts", state.matching ? "Use the reserved matching Safe address" : "Deploy the local treasury policy"] }
    : index === 1 ? { ...step, label: "Create your EEZ-X Safe", details: ["Create a Safe with the same wallet owner (1 of 1)", "Prepare the L1Owners adapter", "Ownership handover happens in its first Safe transaction"] }
    : index === 3 && state.matching ? { ...step, label: "Prepare Ethereum execution", details: ["Deploy the Ethereum policy and allowance module", ...step.details] }
    : index === 5 ? { ...step, details: ["Replace the wallet owner with L1Owners", ...step.details] } : step);
  return mainnetSetupSteps;
}
export function pairedSetupAvailable(artifacts: DeploymentArtifacts) {
  const policy = artifacts.contracts.PairedTreasuryPolicy;
  return !!artifacts.build && !!policy && policy.bytecode.length > 2 && policy.runtime.length > 2
    && policy.abi.some(item => item.type === "function" && item.name === "PAIR_VERSION");
}
type Output = { key: string; address: Address; artifact?: string; hash?: Hex };
type Review = { step: number; chain: Chain; nonce: string; owners: Address[]; threshold: number; fingerprint: string; hash: Hex; approvals: Approval[]; moduleEnabled?: boolean };
type Pending = DeploymentPending & { outputs: Output[]; actionsHash?: Hex; executor?: Address; sequence?: string; closed?: boolean; safe?: Address; safeChain?: Chain; l2StartBlock?: Hex };
export type MainnetSetupState = { build?: string; sourceRequests?: SourceRequest[]; version: 3; creation?: "create-both"; matching?: MatchingSafePlan; identity: Hex; salt: Hex; deployer: Address; addresses: Record<string, Address>; code: TreasuryConfig["code"];
  completed: { hash: Hex; chain: Chain; number: Hex; blockHash: Hex }[]; pending?: Pending; review?: Review };
export type MainnetTarget = DeploymentTarget & { l1: DeploymentTarget["l1"] & { explorer: string }; l2: DeploymentTarget["l2"] & { explorer: string } };
export function isMainnetSetupTarget(l1: string, l2: string, registry: string, manager: string, bridgeL1: string, bridgeL2: string) {
  return BigInt(l1) === BigInt(network.chains.l1.chainId) && BigInt(l2) === BigInt(network.chains.l2.chainId)
    && same(registry, network.registry) && same(manager, network.manager)
    && same(bridgeL1, network.contracts.bridgeL1.address) && same(bridgeL2, network.contracts.bridgeL2.address);
}
export function readMainnetSetup(raw: string | null, selected: SetupNetwork = network): MainnetSetupState | null {
  if (!raw) return null;
  const s = JSON.parse(raw) as MainnetSetupState;
  check(s.version === 3 && (s.creation === undefined || s.creation === "create-both") && (s.build === undefined || /^[a-f\d]{64}$/.test(s.build)) && s.identity === setupIdentity(selected) && digest(s.salt) && isAddress(s.deployer) && s.addresses
    && (isAddress(s.addresses.safeL1!) || s.creation === "create-both" && s.completed?.length === 0 && s.addresses.safeL1 === undefined)
    && Object.values(s.addresses).every(a => isAddress(a)) && Array.isArray(s.completed) && s.completed.length <= mainnetSetupSteps.length
    && s.completed.every(x => digest(x.hash) && digest(x.blockHash) && /^0x[\da-f]+$/i.test(x.number) && ["l1", "l2"].includes(x.chain))
    && typeof s.build === "string"
    && Array.isArray(s.code) && s.code.every(x => isAddress(x.address) && digest(x.hash) && ["l1", "l2"].includes(x.chain)), "Invalid Ethereum setup record; preserve it for recovery");
  if (s.pending) check(s.pending.id === String(s.completed.length) && s.pending.chain === mainnetSetupSteps[s.completed.length]?.chain
    && isAddress(s.pending.sender) && /^0x[\da-f]+$/i.test(s.pending.nonce) && /^0x(?:[\da-f]{2})+$/i.test(s.pending.data)
    && (!s.pending.hash || digest(s.pending.hash)) && (!s.pending.to || isAddress(s.pending.to)) && Array.isArray(s.pending.outputs)
    && (s.pending.l2StartBlock === undefined || /^0x[\da-f]+$/i.test(s.pending.l2StartBlock))
    && s.pending.outputs.every(x => isAddress(x.address) && typeof x.key === "string"), "Invalid pending Ethereum setup");
  if (s.review) check(s.review.step === s.completed.length && s.review.owners.every(a => isAddress(a)) && digest(s.review.hash)
    && s.review.threshold > 0 && s.review.threshold <= s.review.owners.length && Array.isArray(s.review.approvals)
    && (s.review.moduleEnabled === undefined || typeof s.review.moduleEnabled === "boolean"), "Invalid setup approvals");
  if (s.matching) check(s.creation === "create-both" && s.matching.version === 1 && [s.matching.safe, s.matching.singleton, s.matching.factory].every(address => isAddress(address))
    && [s.addresses.safeL1, s.addresses.safeL2].every(address => !address || same(address, s.matching!.safe)), "Invalid matching Safe plan; preserve this setup for recovery");
  return s;
}
export function loadMainnetManifest(storage: Pick<Storage, "getItem">, selected: SetupNetwork = network) {
  const key = `eez:treasury:paired-setup:${setupIdentity(selected)}`;
  const state = readMainnetSetup(storage.getItem(key), selected);
  if (!state || state.completed.length !== mainnetSetupSteps.length || state.pending) return null;
  const raw = storage.getItem(`${key}:manifest`); if (!raw) return null;
  const manifest = parseTreasuryConfig(JSON.parse(raw));
  check(!!manifest.payments?.pair === (state.version === 3), "Treasury manifest does not match its saved setup plan");
  return manifest.instance === keccak256(toHex(`${state.salt}:${state.addresses.safeL1}:${state.addresses.safeL2}`)) ? manifest : null;
}

/** Ethereum setup keeps its own journal and network validation. Shared contract
 * reads and receipt discovery do not select or mutate a setup plan. */
const networkDefault = network;
export class MainnetSetup {
  readonly io: DeploymentIO;
  readonly target: MainnetTarget;
  readonly artifacts: DeploymentArtifacts;
  readonly network: SetupNetwork;
  constructor(target: MainnetTarget, artifacts: DeploymentArtifacts, network: SetupNetwork = networkDefault) { this.network = network; this.target = target; this.artifacts = artifacts; this.io = new DeploymentIO(target, artifacts); }
  async validate() {
    await Promise.all((["l1", "l2"] as const).map(async chain => {
      const expected = this.network.chains[chain], protocol = this.network.protocol.find(x => x.chain === chain)!;
      const [id, block, slot] = await Promise.all([this.io.rpc<Hex>(chain, "eth_chainId"),
        this.io.rpc<{ hash: Hex }>(chain, "eth_getBlockByNumber", [expected.number, false]),
        this.io.rpc<Hex>(chain, "eth_getStorageAt", [protocol.proxy, EIP1967_IMPLEMENTATION_SLOT, "latest"])]);
      check(BigInt(id) === BigInt(expected.chainId) && block?.hash === expected.hash && same(`0x${slot.slice(-40)}`, protocol.implementation), "The Ethereum treasury network binding changed");
      await Promise.all([[protocol.proxy, protocol.proxyHash], [protocol.implementation, protocol.implementationHash]].map(async ([address, hash]) => {
        check(keccak256(await this.io.rpc<Hex>(chain, "eth_getCode", [address, "latest"])) === hash, "The protocol implementation changed; review it before setup");
      }));
      const discovery = await probeComposer({ request: ({ method, params }) => this.io.rpc(chain, method, (params ?? []) as unknown[], true) },
        { l1ChainId: toHex(this.network.chains.l1.chainId), l2ChainId: toHex(this.network.chains.l2.chainId), registryAddress: this.network.registry, l2Address: this.network.manager });
      check(discovery.status === "detected", discovery.detail);
    }));
    await readInBatches(Object.values(this.network.contracts), async binding => {
      check(keccak256(await this.io.rpc<Hex>(binding.chain as Chain, "eth_getCode", [binding.address, "latest"])) === binding.hash, "The reviewed USDC or bridge code changed");
    });
    const abi: Abi = parseAbi(["function manager() view returns(address)", "function rollupId() view returns(uint64)", "function canonicalBridgeAddress() view returns(address)", "function getWrappedToken(address,uint64) view returns(address)", "function wrappedTokenInfo(address) view returns(address,uint64)", "function BRIDGE() view returns(address)", "function paused() view returns(bool)"]);
    const read = async (chain: Chain, to: string, name: string, args: unknown[] = []) => {
      const { decodeFunctionResult } = await import("viem");
      return decodeFunctionResult({ abi, functionName: name, data: await this.io.rpc<Hex>(chain, "eth_call", [{ to, data: encodeFunctionData({ abi, functionName: name, args }) }, "latest"]) });
    };
    await Promise.all((["l1", "l2"] as const).map(async chain => {
      const bridge = this.network.contracts[chain === "l1" ? "bridgeL1" : "bridgeL2"];
      const [manager, rollup, counterpart, implementation] = await Promise.all([read(chain, bridge.address, "manager"), read(chain, bridge.address, "rollupId"), read(chain, bridge.address, "canonicalBridgeAddress"),
        this.io.rpc<Hex>(chain, "eth_getStorageAt", [bridge.address, EIP1967_IMPLEMENTATION_SLOT, "latest"])]);
      const remote = same(counterpart as string, zeroAddress) ? bridge.address : counterpart as string;
      check(same(manager as string, bridge.bindings.manager) && rollup === BigInt(bridge.bindings.rollupId) && same(remote, bridge.bindings.counterpart) && BigInt(implementation) === 0n, "The shared bridge connection changed");
    }));
    const [wrapped, origin, authority, paused] = await Promise.all([read("l2", this.network.contracts.bridgeL2.address, "getWrappedToken", [this.network.contracts.usdcProxy.address, 0n]),
      read("l2", this.network.contracts.bridgeL2.address, "wrappedTokenInfo", [this.network.contracts.wrappedUSDC.address]), read("l2", this.network.contracts.wrappedUSDC.address, "BRIDGE"), this.network.testnet ? false : read("l1", this.network.contracts.usdcProxy.address, "paused")]);
    check(same(wrapped as string, this.network.contracts.wrappedUSDC.address) && same((origin as [string, bigint])[0], this.network.contracts.usdcProxy.address)
      && (origin as [string, bigint])[1] === 0n && same(authority as string, this.network.contracts.bridgeL2.address) && paused === false, "USDC origin, bridge authority or transfer availability changed");
    if (!this.network.testnet) {
      const slot = await this.io.rpc<Hex>("l1", "eth_getStorageAt", [this.network.contracts.usdcProxy.address, USDC_IMPLEMENTATION_SLOT, "latest"]);
      check(same(`0x${slot.slice(-40)}`, this.network.contracts.usdcImplementation.address), "USDC implementation changed; review it before setup");
    } else {
      const token = getAddress(this.network.contracts.usdcProxy.address);
      check(this.io.runtimeMatches(await this.io.rpc<Hex>("l1", "eth_getCode", [token, "latest"]), "TestUSDC"), "Use the current TestUSDC contract");
      const [bridge, rollup] = await Promise.all([this.io.read<Address>("l1", token, "TestUSDC", "bridgeL1"),
        this.io.read<bigint>("l1", token, "TestUSDC", "destinationRollup")]);
      check(same(bridge, this.network.contracts.bridgeL1.address) && rollup === BigInt(this.network.rollupId), "TestUSDC bridge binding changed");
    }
  }
  async configure(deployer: Address, safeL1?: Address, safeL2?: Address, progress: (message: string) => void = () => {}, options: { matching?: boolean } = {}): Promise<MainnetSetupState> {
    check(pairedSetupAvailable(this.artifacts), "A current paired-policy release is required");
    check(isAddress(deployer) && BigInt(deployer) > 1n && (!safeL1 || isAddress(safeL1)) && (safeL1 || !safeL2), "Choose an existing Ethereum Safe or create both Safes with your connected wallet");
    progress("Checking network bindings and Safe ownership…");
    const [, l1, l2] = await Promise.all([this.validate(), safeL1 ? inspectSafe(this.io, "l1", safeL1) : undefined,
      safeL2 ? inspectSafe(this.io, "l2", safeL2) : undefined]);
    const addresses: Record<string, Address> = l1 ? { safeL1: l1.address, singletonL1: l1.singleton } : {};
    const code: TreasuryConfig["code"] = l1 ? [{ chain: "l1", address: l1.address, hash: l1.proxyHash }, { chain: "l1", address: l1.singleton, hash: l1.singletonHash }] : [];
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    check(!options.matching || !safeL1 && !safeL2, "Matching addresses require two new Safes");
    const matching = options.matching ? matchingSafePlan(getAddress(deployer), salt, this.artifacts) : undefined;
    if (matching) await Promise.all((["l1", "l2"] as const).map(async chain => {
      const bytes = await this.io.rpc<Hex>(chain, "eth_getCode", [matchingDeployer, "latest"]);
      check(keccak256(bytes) === matchingDeployerHash, "Matching Safe creation requires the verified deterministic deployer on both chains");
      code.push({ chain, address: matchingDeployer, hash: matchingDeployerHash });
      check(await this.io.rpc<Hex>(chain, "eth_getCode", [matching.safe, "latest"]) === "0x", "The planned Safe address is already occupied; start a new setup");
    }));
    if (l2) {
      check(safeL1 && l2.adapter && same(l2.adapter.safeL1, safeL1) && same(l2.adapter.manager, this.network.manager), "Choose a mirror already connected to this Ethereum Safe");
      Object.assign(addresses, { safeL2: l2.address, singletonL2: l2.singleton, adapter: l2.adapter.address });
      code.push(...await Promise.all([l2.address, l2.singleton, l2.adapter.address].map(async address =>
        ({ chain: "l2" as const, address, hash: keccak256(await this.io.rpc<Hex>("l2", "eth_getCode", [address, "latest"])) }))));
    }
    progress("Finding verified Safe contracts to reuse…");
    // Independent contract roles can be inspected together. Within each role,
    // preserve the reviewed candidate order and stop at the first exact match.
    const roles = (["l1", "l2"] as const).flatMap(chain =>
      ["singleton", "factory", "multiSend"].map(kind => ({ chain, kind, key: `${kind}${chain === "l1" ? "L1" : "L2"}` })))
      .filter(({ chain, kind, key }) => !addresses[key] && (!matching || kind === "multiSend") && (!safeL1 || chain !== "l1" || kind === "multiSend"));
    const [infrastructure, officialBindings] = await Promise.all([
      discoverSafeInfrastructure(this.io, this.network.chains.l2.chainId, this.network.chains.l2.number as Hex,
        safeL1 ? { manager: getAddress(this.network.manager), safeL1: addresses.safeL1! } : undefined),
      Promise.all(roles.map(async ({ chain, kind, key }) => {
        for (const item of [...official.deployments, ...(!safeL1 && chain === "l1" ? official.additionalL1Singletons : [])].filter(item => item.kind === kind)) {
          const bytes = await this.io.rpc<Hex>(chain, "eth_getCode", [item.address, "latest"]);
          if (keccak256(bytes) === item.codeHash) return { key, chain, address: getAddress(item.address), hash: item.codeHash as Hex };
        }
      })),
    ]);
    for (const binding of officialBindings) if (binding) {
      const { key, ...entry } = binding; addresses[key] = entry.address; code.push(entry);
    }
    if (!safeL1 && !matching) check(addresses.singletonL1 && addresses.factoryL1,
      "Creating both Safes requires the verified Safe singleton and factory on L1. This network does not have the supported deployment contracts.");
    // Ethereum reuses its pinned shared module. Testnet deploys the current module
    // or discovers current Safe infrastructure on its own network.
    if (!this.network.testnet) {
      check(sharedContracts.chainId === this.network.chains.l1.chainId && same(sharedContracts.registry, this.network.registry), "Shared Ethereum contracts belong to a different network");
      const block = await this.io.rpc<{ number: Hex; hash: Hex }>("l1", "eth_getBlockByNumber", ["latest", false]);
      check(block?.number && block.hash, "Shared Ethereum contracts are unavailable");
      for (const [key, binding] of Object.entries(sharedContracts.contracts)) {
        const address = getAddress(binding.address);
        const bytes = await this.io.rpc<Hex>("l1", "eth_getCode", [address, block.number]);
        check(bytes !== "0x" && keccak256(bytes) === binding.hash, "Shared Ethereum allowance module code is unavailable or changed");
        addresses[key] = address; code.push({ chain: "l1", address, hash: binding.hash as Hex });
      }
      const again = await this.io.rpc<{ hash: Hex }>("l1", "eth_getBlockByNumber", [block.number, false]);
      check(again?.hash === block.hash, "Shared Ethereum contracts changed during inspection; try again");
    }
    for (const [key, binding] of Object.entries(infrastructure)) if (!addresses[key] && (!matching || !["singletonL2", "factoryL2"].includes(key))) {
      addresses[key] = binding.address; code.push({ chain: "l2", ...binding });
    }
    return { ...(this.artifacts.build ? { build: this.artifacts.build } : {}), ...(!safeL1 ? { creation: "create-both" as const } : {}), ...(matching ? { matching } : {}), version: 3, identity: setupIdentity(this.network), salt, deployer: getAddress(deployer), addresses, code, completed: [] };
  }
  async unchanged(s: MainnetSetupState) {
    check(s.version === 3 && s.build === this.artifacts.build && pairedSetupAvailable(this.artifacts), "Legacy treasury setup is retired; start a new paired setup");
    // These are independent reads. All must pass before the snapshot is used;
    // canonical block checks still run inside each Safe inspection.
    const [, , , safe] = await Promise.all([
      this.validate(),
      readInBatches(s.code, async b => { check(keccak256(await this.io.rpc<Hex>(b.chain, "eth_getCode", [b.address, "latest"])) === b.hash, "A selected treasury contract changed"); }),
      readInBatches(s.completed, async r => { check((await this.io.rpc<{ hash: Hex }>(r.chain, "eth_getBlockByNumber", [r.number, false]))?.hash === r.blockHash, "A setup confirmation was reorganized; preserve this setup for reconciliation"); }),
      s.creation === "create-both" && !s.completed.length && !s.addresses.safeL1 ? undefined : inspectSafe(this.io, "l1", s.addresses.safeL1!),
    ]);
    if (safe) check(same(safe.singleton, s.addresses.singletonL1!), "The Ethereum Safe implementation changed");
    return safe;
  }
  async wallet(provider: EthereumProvider, chain: Chain, expected?: Address, verifyComposer = true) {
    const [accounts, id] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
    const sender = (accounts as Address[])[0];
    check(sender && isAddress(sender) && (!expected || same(sender, expected)), "Connect the wallet selected for this setup");
    check(BigInt(id as string) === BigInt(this.network.chains[chain].chainId), `Switch to ${chain === "l1" ? "Ethereum" : "EEZ-X"}`);
    if (!verifyComposer) return sender;
    const discovery = await probeComposer(provider, { l1ChainId: toHex(this.network.chains.l1.chainId), l2ChainId: toHex(this.network.chains.l2.chainId), registryAddress: this.network.registry, l2Address: this.network.manager });
    check(discovery.status === "detected", discovery.detail);
    return sender;
  }
  private tx(s: MainnetSetupState, review: Review) {
    check(s.version === 3 && pairedSetupAvailable(this.artifacts), "Restore this paired setup’s original contract release");
    const chain = review.chain, suffix = chain === "l1" ? "L1" : "L2", a = s.addresses, safe = a[`safe${suffix}`]!, module = a[`module${suffix}`]!;
    const delegate = chain === "l1" ? a.policyL1! : a.policy!, token = chain === "l1" ? this.network.contracts.usdcProxy.address : this.network.contracts.wrappedUSDC.address;
    const call = (to: Address, name: string, method: string, args: unknown[]) => ({ to, data: encodeFunctionData({ abi: this.io.abi(name), functionName: method, args }) });
    // Reusing a shared module on an existing Safe must not try to enable it twice.
    // The observed state changes the signed batch hash and is rechecked before submission.
    const calls = [...(review.moduleEnabled ? [] : [call(safe, "Safe", "enableModule", [module])]), call(module, "AllowanceModule", "addDelegate", [delegate]),
      call(module, "AllowanceModule", "setAllowance", [delegate, token, 100_000_000n, 10, 10])];
    {
      calls.unshift(call(delegate, "PairedTreasuryPolicy", "connectPeer", [chain === "l1" ? a.policy! : a.policyL1!]));
      if (chain === "l2") calls.push(call(delegate, "PairedTreasuryPolicy", "activate", []));
    }
    if (chain === "l2" && s.creation === "create-both")
      calls.unshift(call(safe, "Safe", "swapOwner", [getAddress(toHex(1n, { size: 20 })), s.deployer, a.adapter!]));
    return buildSafeTransaction({ chainId: BigInt(this.network.chains[chain].chainId), safe, to: a[`multiSend${suffix}`]!, operation: 1, nonce: BigInt(review.nonce),
      data: encodeFunctionData({ abi: this.io.abi("MultiSendCallOnly"), functionName: "multiSend", args: [packSafeCalls(calls)] }) });
  }
  async review(s: MainnetSetupState, onProgress: (message: string) => void = () => {}): Promise<Review> {
    check(!s.pending && s.completed.length >= 4 && s.completed.length < 6, "This step does not need owner approvals");
    check(s.version === 3 && s.build === this.artifacts.build && pairedSetupAvailable(this.artifacts), "Restore this paired setup’s original contract release");
    onProgress("Reading the Safe owners, threshold and nonce…");
    const chain = s.completed.length === 4 ? "l1" : "l2";
    const [owners, mirror] = await Promise.all([inspectSafe(this.io, "l1", s.addresses.safeL1!),
      chain === "l2" ? inspectSafe(this.io, "l2", s.addresses.safeL2!) : undefined]);
    const local = mirror ?? owners;
    check(same(owners.singleton, s.addresses.singletonL1!), "The Ethereum Safe implementation changed");
    const handover = chain === "l2" && s.creation === "create-both";
    if (handover) check(local.owners.length === 1 && same(local.owners[0]!, s.deployer) && local.threshold === 1 && BigInt(local.nonce) === 0n
      && same(local.singleton, s.addresses.singletonL2!), "The new EEZ-X Safe must still have its original wallet owner, threshold 1 and nonce 0 before handover");
    else if (chain === "l2") check(local.adapter && same(local.adapter.address, s.addresses.adapter!) && same(local.adapter.safeL1, owners.address), "The mirror’s owner connection changed");
    onProgress("Preparing the exact Safe approval…");
    const authority = handover ? local : owners;
    const r: Review = { step: s.completed.length, chain, nonce: local.nonce, owners: authority.owners, threshold: authority.threshold,
      fingerprint: ownerFingerprint(authority.owners, authority.threshold), hash: zeroHash, approvals: [],
      moduleEnabled: await this.io.read<boolean>(chain, local.address, "Safe", "isModuleEnabled", [s.addresses[chain === "l1" ? "moduleL1" : "moduleL2"]!], local.block) };
    r.hash = safeTransactionHash(this.tx(s, r)); return r;
  }
  async currentReview(s: MainnetSetupState) {
    const fresh = await this.review(s);
    check(s.review && s.review.hash === fresh.hash && s.review.fingerprint === fresh.fingerprint, "Owners, threshold, Safe nonce or module configuration changed. Review this step again");
    return s.review;
  }
  /** Four reads at most, only before granting spending authority. The latest
   * recorded block on each chain anchors its earlier setup confirmations too.
   * This deliberately does not repeat the full code/owner audit while signing.
   */
  async checkSubmission(s: MainnetSetupState) {
    const observations = (["l1", "l2"] as const).map(chain => {
      const protocol = this.network.protocol.find(binding => binding.chain === chain);
      const latest = s.completed.filter(tx => tx.chain === chain)
        .reduce<MainnetSetupState["completed"][number] | undefined>((last, tx) =>
          !last || BigInt(tx.number) > BigInt(last.number) ? tx : last, undefined);
      check(protocol && latest, "Setup verification is incomplete; preserve this setup for recovery");
      return { chain, protocol, latest };
    });
    await Promise.all(observations.flatMap(({ chain, protocol, latest }) => [
      this.io.rpc<Hex>(chain, "eth_getStorageAt", [protocol.proxy, EIP1967_IMPLEMENTATION_SLOT, "latest"]).then(slot => {
        check(digest(slot) && same(`0x${slot.slice(-40)}`, protocol.implementation),
          "The protocol implementation changed; review it before authorizing setup");
      }),
      this.io.rpc<{ hash: Hex } | null>(chain, "eth_getBlockByNumber", [latest.number, false]).then(block => {
        check(block && digest(block.hash) && same(block.hash, latest.blockHash),
          "A setup confirmation changed or is unavailable; preserve this setup and retry verification");
      }),
    ]));
  }
  private savedReview(s: MainnetSetupState) {
    const r = s.review;
    check(!s.pending && s.completed.length >= 4 && s.completed.length < 6 && r
      && r.step === s.completed.length && r.chain === (s.completed.length === 4 ? "l1" : "l2")
      && r.fingerprint === ownerFingerprint(r.owners, r.threshold)
      && r.hash === safeTransactionHash(this.tx(s, r)), "Review this Safe step before signing or submitting");
    if (s.creation === "create-both" && r.chain === "l2") check(r.nonce === "0" && r.threshold === 1 && r.owners.length === 1 && same(r.owners[0]!, s.deployer),
      "The first EEZ-X Safe transaction must be approved by its original wallet owner");
    return r;
  }
  async approve(s: MainnetSetupState, provider: EthereumProvider, onProgress: (message: string) => void = () => {}) {
    const r = this.savedReview(s);
    onProgress("Checking your wallet account and network…");
    const sender = await this.wallet(provider, r.chain, undefined, false), tx = this.tx(s, r);
    check(r.owners.some(a => same(a, sender)) && !r.approvals.some(a => same(a.owner, sender)), "Connect a current owner who has not approved this step");
    onProgress("Waiting for the owner signature in your wallet…");
    const signature = await provider.request({ method: "eth_signTypedData_v4", params: [sender, safeTypedDataJSON(tx)] }) as Hex;
    onProgress("Signature received. Checking the signer and saving your approval…");
    await this.wallet(provider, r.chain, sender, false);
    const approval = { owner: sender, signature }; await packEOAApprovals(tx, r.owners, 1, [approval]); return approval;
  }
  async prepare(s: MainnetSetupState, provider: EthereumProvider, onProgress: (message: string) => void = () => {}) {
    check(!s.build || s.build === this.artifacts.build, "Restore this setup’s original source build");
    check(!s.pending && s.completed.length < 6, "Finish the pending setup transaction first");
    const step = s.completed.length, chain = mainnetSetupSteps[step]!.chain;
    check(s.version === 3 && s.build === this.artifacts.build && pairedSetupAvailable(this.artifacts), "Restore this paired setup’s original contract release");
    onProgress("Checking your wallet connection…");
    const sender = await this.wallet(provider, chain, step < 4 ? s.deployer : undefined);
    const nonce = await this.io.rpc<Hex>(chain, "eth_getTransactionCount", [sender, "pending"]);
    let pending: Pending = { id: String(step), chain, sender, nonce, data: "0x", outputs: [] };
    if (step >= 4) {
      onProgress("Checking collected signatures…");
      const r = this.savedReview(s), tx = this.tx(s, r);
      const signature = r.chain === "l1" || s.creation === "create-both" ? await packEOAApprovals(tx, r.owners, r.threshold, r.approvals)
        : await packOwnerApprovals(tx, s.addresses.adapter!, r.owners, r.threshold, r.approvals);
      pending = { ...pending, safe: tx.domain.verifyingContract, safeChain: r.chain, safeHash: r.hash,
        to: r.chain === "l1" ? s.addresses.safeL1! : s.addresses.safeL2Alias!, data: encodeSafeExecution(tx, signature) };
    } else pending = { ...pending, ...await this.batch(s, nonce) };
    let request: Record<string, string> = { from: sender, chainId: toHex(this.network.chains[chain].chainId), nonce, data: pending.data, value: "0x0", ...(pending.to ? { to: pending.to } : {}) };
    let expiresAt: string | undefined;
    try {
      if (step === 5) {
        onProgress("Quoting cross-chain execution fees with Composer…");
        pending.l2StartBlock = await this.io.rpc<Hex>("l2", "eth_blockNumber");
        const quote = await quoteCrossChainFees({ tx: request, from: sender, chainId: request.chainId!, wallet: provider,
          rpc: (method, params) => this.io.rpc(chain, method, params, true), maxTotalFee: BigInt(this.target.fees.l1) });
        request = quote.transaction; expiresAt = quote.expiresAt;
      } else { onProgress("Estimating transaction gas…"); request.gas = toHex(BigInt(await this.io.rpc<Hex>(chain, "eth_estimateGas", [request], true)) * 120n / 100n); }
    } catch (simulationError) {
      onProgress("Simulation failed. Checking network bindings, Safe state and completed steps…");
      try { await this.unchanged(s); if (step >= 4) await this.currentReview(s); }
      catch (diagnosticError) { throw new Error(`Transaction simulation failed: ${(simulationError as Error).message}. ${(diagnosticError as Error).message}`); }
      throw simulationError;
    }
    if (step >= 4) {
      onProgress("Verifying setup before wallet confirmation…");
      await this.checkSubmission(s);
    }
    onProgress("Rechecking your wallet before opening confirmation…");
    await this.wallet(provider, chain, sender, false); return { pending, request, expiresAt };
  }
  private async batch(s: MainnetSetupState, nonce: Hex) {
    check(s.version === 3 && pairedSetupAvailable(this.artifacts), "Restore this paired setup’s original contract release");
    if (s.matching) {
      const expected = matchingSafePlan(s.deployer, s.salt, this.artifacts);
      check(s.creation === "create-both" && s.matching.version === 1 && same(s.matching.safe, expected.safe)
        && same(s.matching.singleton, expected.singleton) && same(s.matching.factory, expected.factory), "The matching Safe plan changed; preserve this setup for recovery");
    }
    const step = s.completed.length, chain = mainnetSetupSteps[step]!.chain, a = { ...s.addresses };
    const create = step < 2, key = chain === "l1" ? "bootstrapL1" : "bootstrapL2";
    const executor = create ? getContractAddress({ from: s.deployer, nonce: BigInt(nonce) }) : a[key]!;
    let n = create ? 1n : BigInt(await this.io.rpc<Hex>(chain, "eth_getTransactionCount", [executor, "latest"]));
    const sequence = create ? 0n : await this.io.read<bigint>(chain, executor, "TreasuryBootstrap", "sequence");
    if (!create) check(same(await this.io.read<Address>(chain, executor, "TreasuryBootstrap", "owner"), s.deployer)
      && !await this.io.read<boolean>(chain, executor, "TreasuryBootstrap", "closed"), "Deployment batch ownership changed");
    const outputs: Output[] = create ? [{ key, address: executor, artifact: "TreasuryBootstrap" }] : [];
    const actions: { create: boolean; target: Address; data: Hex; returnHash: Hex }[] = [];
    const deploy = (key: string, name: string, args: unknown[] = []) => {
      if (a[key]) return;
      const address = getContractAddress({ from: executor, nonce: n++ }), artifact = this.artifacts.contracts[name]!;
      actions.push({ create: true, target: address, data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }), returnHash: zeroHash });
      a[key] = address; outputs.push({ key, address, artifact: name });
    };
    const call = (target: Address, name: string, method: string, args: unknown[]) => actions.push({ create: false, target,
      data: encodeFunctionData({ abi: this.io.abi(name), functionName: method, args }), returnHash: zeroHash });
    const createSafe = async (suffix: "L1" | "L2", owner: Address) => {
      if (a[`safe${suffix}`]) return;
      if (s.matching) {
        check(keccak256(await this.io.rpc<Hex>(chain, "eth_getCode", [matchingDeployer, "latest"])) === matchingDeployerHash, "The deterministic deployer changed");
        for (const [role, name] of [["singleton", "Safe"], ["factory", "SafeProxyFactory"]] as const) {
          const address = s.matching[role], artifact = this.artifacts.contracts[name]!;
          const bytes = await this.io.rpc<Hex>(chain, "eth_getCode", [address, "latest"]);
          check(bytes === "0x" || bytes === artifact.runtime, "The reserved Safe infrastructure address contains different code");
          if (bytes === "0x") actions.push({ create: false, target: matchingDeployer, data: concatHex([zeroHash, artifact.bytecode]), returnHash: keccak256(address) });
          a[`${role}${suffix}`] = address; outputs.push({ key: `${role}${suffix}`, address, artifact: name });
        }
      } else { deploy(`singleton${suffix}`, "Safe"); deploy(`factory${suffix}`, "SafeProxyFactory"); }
      const singleton = a[`singleton${suffix}`]!, factory = a[`factory${suffix}`]!;
      const initializer = encodeFunctionData({ abi: this.io.abi("Safe"), functionName: "setup", args: [[owner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] });
      const code = outputs.some(o => o.key === `factory${suffix}`) ? this.artifacts.contracts.SafeProxyFactory!.proxyCreationCode! : await this.io.read<Hex>(chain, factory, "SafeProxyFactory", "proxyCreationCode");
      const bytecode = concatHex([code, encodeAbiParameters(parseAbiParameters("address"), [singleton])]);
      const safe = getContractAddress({ opcode: "CREATE2", from: factory, salt: keccak256(concatHex([keccak256(initializer), s.salt])), bytecode });
      if (s.matching) check(same(safe, s.matching.safe) && await this.io.rpc<Hex>(chain, "eth_getCode", [safe, "latest"]) === "0x", "The matching Safe address changed or is already occupied");
      call(factory, "SafeProxyFactory", "createProxyWithNonce", [singleton, initializer, BigInt(s.salt)]);
      a[`safe${suffix}`] = safe; outputs.push({ key: `safe${suffix}`, address: safe, artifact: "SafeProxy" });
    };
    const l1Policy = () => {
      deploy("moduleL1", "AllowanceModule"); deploy("multiSendL1", "MultiSendCallOnly");
      deploy("policyL1", "PairedTreasuryPolicy", [a.safeL1, a.moduleL1, this.network.contracts.usdcProxy.address, this.network.contracts.bridgeL1.address, BigInt(this.network.rollupId)]);
    };
    if (step === 0) {
      if (s.creation === "create-both") await createSafe("L1", s.deployer);
      if (!s.matching) l1Policy();
    } else if (step === 1) {
      call(getAddress(this.network.manager), "Registry", "getOrCreateCrossChainProxy", [a.safeL1, 0n]);
      deploy("adapter", "L1Owners", [this.network.manager, a.safeL1]); deploy("multiSendL2", "MultiSendCallOnly");
      await createSafe("L2", s.creation === "create-both" ? s.deployer : a.adapter!);
    } else if (step === 2) {
      deploy("moduleL2", "AllowanceModule");
      deploy("policy", "PairedTreasuryPolicy", [a.safeL2, a.moduleL2,
        this.network.contracts.wrappedUSDC.address, this.network.contracts.bridgeL2.address, BigInt(this.network.rollupId)]);
    } else {
      if (s.matching) l1Policy();
      for (const [key, original] of [["adapterAlias", a.adapter!], ["safeL2Alias", a.safeL2!], ["alias", a.policy!]]) {
        const address = await this.io.read<Address>("l1", getAddress(this.network.registry), "Registry", "computeCrossChainProxyAddress", [original, BigInt(this.network.rollupId)]);
        call(getAddress(this.network.registry), "Registry", "getOrCreateCrossChainProxy", [original, BigInt(this.network.rollupId)]); outputs.push({ key: key!, address });
      }
    }
    const closed = !create, actionsHash = keccak256(encodeAbiParameters(parseAbiParameters("(bool create,address target,bytes data,bytes32 returnHash)[]"), [actions]));
    const data = create ? encodeDeployData({ abi: this.io.abi("TreasuryBootstrap"), bytecode: this.artifacts.contracts.TreasuryBootstrap!.bytecode, args: this.io.abi("TreasuryBootstrap").find(item => item.type === "constructor")?.inputs.length === 1 ? [actions] : [s.deployer, actions] })
      : encodeFunctionData({ abi: this.io.abi("TreasuryBootstrap"), functionName: "execute", args: [sequence, actions, closed] });
    check(!create || (data.length - 2) / 2 <= 49152, "Deployment batch exceeds the creation size limit");
    return { ...(create ? {} : { to: executor }), data, outputs, executor, actionsHash, sequence: String(sequence), closed };
  }
  async reconcile(s: MainnetSetupState): Promise<MainnetSetupState> {
    check(!s.build || s.build === this.artifacts.build, "Restore this setup’s original source build");
    if (!s.pending) return s;
    // The shared recovery routine only consumes pending identity, never plans.
    const tracked = await this.io.trackPending({ pending: s.pending });
    const p = { ...s.pending, hash: tracked.pending?.hash };
    if (!p.hash) return s;
    type Log = { address: Address; topics: [Hex, ...Hex[]]; data: Hex };
    const receipt = await this.io.rpc<{ status: Hex; blockNumber: Hex; blockHash: Hex; contractAddress: Address | null; logs: Log[] } | null>(p.chain, "eth_getTransactionReceipt", [p.hash]);
    if (!receipt) return { ...s, pending: p };
    const tx = await this.io.rpc<{ from: Address; to: Address | null; input: Hex; value: Hex; nonce: Hex }>(p.chain, "eth_getTransactionByHash", [p.hash]);
    check(same(tx.from, p.sender) && (p.to ? same(tx.to ?? "", p.to) : tx.to === null) && same(tx.input, p.data)
      && BigInt(tx.value) === 0n && BigInt(tx.nonce) === BigInt(p.nonce), "The setup transaction was replaced with different work");
    const canonical = await this.io.rpc<{ hash: Hex }>(p.chain, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (canonical?.hash !== receipt.blockHash) return { ...s, pending: p };
    check(receipt.status === "0x1", "The setup transaction reverted; keep this record for diagnosis");
    if (p.actionsHash) {
      const events = receipt.logs.filter(l => same(l.address, p.executor!)).flatMap(l => { try { return [decodeEventLog({ abi: this.io.abi("TreasuryBootstrap"), ...l })]; } catch { return []; } });
      check(events.some(e => e.eventName === "Executed" && (e.args as any).actionsHash === p.actionsHash && String((e.args as any).sequence) === p.sequence && (e.args as any).closed === p.closed), "Missing exact deployment batch execution");
      if (!p.to) check(same(receipt.contractAddress ?? "", p.executor!), "Unexpected deployment contract");
    }
    if (p.safeHash) {
      let logs = receipt.logs;
      if (p.safeChain === "l2") {
        // The mirror executes as the synthetic incoming transaction. Match its
        // Safe hash and the same Ethereum inclusion before enabling payments.
        const { findIncomingCall } = await import("./mainnetSetupRelay.ts");
        const incoming = await findIncomingCall(this.io, s.addresses.safeL2!, p, receipt, this.network, p.l2StartBlock);
        if (!incoming) return { ...s, pending: p }; logs = incoming;
      }
      check(logs.some(l => same(l.address, p.safe!) && decodeSafeExecution(l)?.eventName === "ExecutionSuccess" && decodeSafeExecution(l)?.args.txHash === p.safeHash), "Missing successful Safe setup execution");
      if (p.safeChain === "l2" && s.creation === "create-both") {
        const mirror = await inspectSafe(this.io, "l2", s.addresses.safeL2!);
        check(mirror.adapter && same(mirror.adapter.address, s.addresses.adapter!) && same(mirror.adapter.safeL1, s.addresses.safeL1!)
          && same(mirror.adapter.manager, this.network.manager), "The EEZ-X ownership handover was not confirmed");
      }
    }
    const addresses = { ...s.addresses }, code = [...s.code];
    for (const o of p.outputs) {
      const bytes = await this.io.rpc<Hex>(p.chain, "eth_getCode", [o.address, receipt.blockNumber]);
      check(bytes !== "0x" && (!o.artifact || (o.artifact === "SafeProxy" ? matchingSafeCode(bytes, this.artifacts.contracts.SafeProxy!.runtime) : this.io.runtimeMatches(bytes, o.artifact))), `Unexpected deployed ${o.key}`);
      addresses[o.key] = o.address; code.push({ chain: p.chain, address: o.address, hash: keccak256(bytes) });
    }
    return { ...s, ...(s.build ? { sourceRequests: appendSourceRequest(s.sourceRequests, s.build, this.network.chains[p.chain].chainId, p.hash) } : {}), addresses, code, completed: [...s.completed, { hash: p.hash, chain: p.chain, number: receipt.blockNumber, blockHash: receipt.blockHash }], pending: undefined, review: undefined };
  }
  async manifest(s: MainnetSetupState) {
    check(s.completed.length === 6 && !s.pending, "Complete setup before opening the treasury"); await this.unchanged(s);
    const a = s.addresses, code = [...s.code];
    let pair: { version: 1; policyL1: Address; peerProxyL2: Address } | undefined;
    if (s.version === 3) {
      const peerProxyL2 = await this.io.read<Address>("l2", a.policy!, "PairedTreasuryPolicy", "peer");
      const bytes = await this.io.rpc<Hex>("l2", "eth_getCode", [peerProxyL2, "latest"]);
      check(bytes !== "0x", "Peer connection is not deployed");
      code.push({ chain: "l2", address: peerProxyL2, hash: keccak256(bytes) });
      pair = { version: 1, policyL1: a.policyL1!, peerProxyL2 };
    }
    for (const b of Object.values(this.network.contracts)) code.push({ chain: b.chain as Chain, address: getAddress(b.address), hash: b.hash as Hex });
    for (const p of this.network.protocol) for (const [address, hash] of [[p.proxy, p.proxyHash], [p.implementation, p.implementationHash]]) code.push({ chain: p.chain as Chain, address: getAddress(address!), hash: hash as Hex });
    const c = parseTreasuryConfig({ version: 1, environment: this.network.testnet ? "dashboard-testnet" : "ethereum-mainnet", instance: keccak256(toHex(`${s.salt}:${a.safeL1}:${a.safeL2}`)),
      l1: { ...this.target.l1, chainId: this.network.chains.l1.chainId, checkpoint: { number: this.network.chains.l1.number, hash: this.network.chains.l1.hash } },
      l2: { ...this.target.l2, chainId: this.network.chains.l2.chainId, checkpoint: { number: this.network.chains.l2.number, hash: this.network.chains.l2.hash } },
      fees: { maxTotalWei: this.target.fees.l2, l1MaxTotalWei: this.target.fees.l1 }, registry: this.network.registry, manager: this.network.manager,
      safeL1: a.safeL1, safeL2: a.safeL2, adapter: a.adapter, safeImplementations: { l1: a.singletonL1, l2: a.singletonL2 }, ownerLabels: {},
      safeAppUrl: `https://app.safe.global/home?safe=${this.network.testnet ? "chiado" : "eth"}:${a.safeL1}`, code: [...new Map(code.map(b => [`${b.chain}:${b.address.toLowerCase()}`, b])).values()],
      protocol: this.network.protocol.map(p => ({ chain: p.chain, proxy: p.proxy, implementation: p.implementation })),
      mainnet: this.network.testnet ? undefined : { rollupId: this.network.rollupId, usdcImplementation: this.network.contracts.usdcImplementation.address, bridgeImplementations: { l1: { kind: "immutable" }, l2: { kind: "immutable" } } },
      payments: { bridgeKind: "standard", policy: a.policy, alias: a.alias, safeL2Alias: a.safeL2Alias,
        pair,
        moduleL1: a.moduleL1, moduleL2: a.moduleL2, tokenL1: this.network.contracts.usdcProxy.address, tokenL2: this.network.contracts.wrappedUSDC.address,
        bridgeL1: this.network.contracts.bridgeL1.address, bridgeL2: this.network.contracts.bridgeL2.address, recipient: s.deployer,
        version: 2, decimals: 6, period: 600, globalLimit: "150000000", assetLabel: this.network.testnet ? "Test USDC" : "USDC" } });
    await new TreasuryClient(c).validate(); return c;
  }
}
