import { decodeEventLog, encodeDeployData, encodeFunctionData, getContractAddress, isAddress, keccak256, toHex, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { DeploymentIO } from './deploymentIO.ts';
import type { DeploymentArtifacts, DeploymentPending } from './deployment.ts';
import { MainnetSetup } from './mainnetSetup.ts';
import type { MainnetTarget, SetupNetwork } from './mainnetSetup.ts';
import { findIncomingCallEvidence } from './mainnetSetupRelay.ts';
import { transferAbi } from './transfers.ts';
import { probeComposer } from '../composerDiscovery.ts';
import { discoverToken, validateInfrastructure } from './networkDiscovery.ts';
import { readBridgeManager } from '../bridgeManager.ts';
import { quoteCrossChainFees } from '../fees/payment.mjs';
import defaultProfile from './paired-testnet-network.json' with { type: 'json' };

export const CLAIM_AMOUNT = 1_000_000_000n;
export type AssetPending = DeploymentPending & { kind: 'deploy' | 'l1' | 'l2'; token?: Address; recipient: Address; l2StartBlock: Hex; build: string };
export type AssetFailure = { request: AssetPending; blockNumber: Hex; blockHash: Hex };
export type AssetJournal = { token?: Address; pending?: AssetPending; failed?: AssetFailure; last?: { hash: Hex; destination: 'l1' | 'l2' } };
type Log = { address: Address; data: Hex; topics: [Hex, ...Hex[]] };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function testnetAssetKey(bridgeL1: string, bridgeL2: string) {
  return `eez:treasury:paired-asset:${defaultProfile.registry}:${bridgeL1.toLowerCase()}:${bridgeL2.toLowerCase()}`;
}
export function readAssetJournal(raw: string | null): AssetJournal {
  if (!raw) return {};
  const s = JSON.parse(raw) as AssetJournal, p = s.pending;
  check(!s.token || isAddress(s.token), 'Invalid saved Test USDC address');
  if (p) check(['deploy', 'l1', 'l2'].includes(p.kind) && p.chain === 'l1' && isAddress(p.sender) && isAddress(p.recipient)
    && /^0x[\da-f]+$/i.test(p.nonce) && /^0x[\da-f]+$/i.test(p.l2StartBlock) && /^0x(?:[\da-f]{2})+$/i.test(p.data)
    && /^[\da-f]{64}$/.test(p.build) && (!p.hash || /^0x[\da-f]{64}$/i.test(p.hash))
    && (p.kind === 'deploy' ? !p.to && !p.token : isAddress(p.token!) && same(p.to ?? '', p.token!) && same(s.token ?? '', p.token!)),
    'Invalid saved test-token request; preserve it for recovery');
  if (s.failed) {
    check(!p && s.failed.request && /^0x[\da-f]{64}$/i.test(s.failed.request.hash ?? '')
      && /^0x[\da-f]+$/i.test(s.failed.blockNumber) && /^0x[\da-f]{64}$/i.test(s.failed.blockHash), 'Invalid failed test-token request');
    readAssetJournal(JSON.stringify({ token: s.failed.request.token, pending: s.failed.request }));
  }
  return s;
}

/** The configured normal bridges are reused; no custom bridge or dispenser is deployed. */
export class TestnetAsset extends DeploymentIO {
  readonly setupTarget: MainnetTarget;
  readonly bridgeL1: Address;
  readonly bridgeL2: Address;
  readonly profile: Pick<typeof defaultProfile, 'registry' | 'manager' | 'rollupId' | 'protocolCommit' | 'chains' | 'bridges'>;
  readonly discoveredNetwork?: SetupNetwork;
  constructor(setupTarget: MainnetTarget, artifacts: DeploymentArtifacts, bridgeL1: Address, bridgeL2: Address, network?: SetupNetwork) {
    super(setupTarget, artifacts);
    this.discoveredNetwork = network;
    this.profile = network ? { ...defaultProfile, registry: network.registry, manager: network.manager, rollupId: network.rollupId,
      chains: Object.fromEntries((['l1', 'l2'] as const).map(chain => [chain, { ...defaultProfile.chains[chain], chainId: network.chains[chain].chainId,
        checkpoint: { number: network.chains[chain].number, hash: network.chains[chain].hash } }])) as typeof defaultProfile.chains } : defaultProfile;
    this.setupTarget = setupTarget; this.bridgeL1 = bridgeL1; this.bridgeL2 = bridgeL2;
    check(isAddress(bridgeL1) && isAddress(bridgeL2), 'Configure both normal bridge addresses first');
  }
  async validate() {
    if (this.discoveredNetwork) return validateInfrastructure(this, this.discoveredNetwork);
    for (const chain of ['l1', 'l2'] as const) {
      const expected = this.profile.chains[chain], bridge = chain === 'l1' ? this.bridgeL1 : this.bridgeL2;
      const [id, reference, code, manager, rollup, peer] = await Promise.all([
        this.rpc<Hex>(chain, 'eth_chainId'), this.rpc<{ hash: Hex }>(chain, 'eth_getBlockByNumber', [expected.checkpoint.number, false]),
        this.rpc<Hex>(chain, 'eth_getCode', [bridge, 'latest']),
        readBridgeManager(data => this.rpc(chain, 'eth_call', [{ to: bridge, data }, 'latest'])),
        this.read<bigint>(chain, bridge, 'Bridge', 'rollupId'), this.read<Address>(chain, bridge, 'Bridge', 'canonicalBridgeAddress'),
      ]);
      check(BigInt(id) === BigInt(expected.chainId) && reference?.hash === expected.checkpoint.hash, 'Testnet identity changed');
      check(same(bridge, this.profile.bridges[chain].address) && keccak256(code) === this.profile.bridges[chain].codeHash
        && same(manager, chain === 'l1' ? this.profile.registry : this.profile.manager)
        && rollup === (chain === 'l1' ? 0n : BigInt(this.profile.rollupId))
        && same(same(peer, zeroAddress) ? bridge : peer, chain === 'l1' ? this.bridgeL2 : this.bridgeL1),
        'Use the configured normal bridge pair; retired treasury bridges are unsupported');
      const p = expected.protocol;
      const [slot, proxyCode, implementationCode] = await Promise.all([
        this.rpc<Hex>(chain, 'eth_getStorageAt', [p.proxy, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']),
        this.rpc<Hex>(chain, 'eth_getCode', [p.proxy, 'latest']), this.rpc<Hex>(chain, 'eth_getCode', [p.implementation, 'latest']),
      ]);
      check(same(`0x${slot.slice(-40)}`, p.implementation) && keccak256(proxyCode) === p.proxyCodeHash
        && keccak256(implementationCode) === p.implementationCodeHash, 'The reviewed testnet protocol changed');
    }
  }
  async validateToken(token: Address) {
    check(isAddress(token) && token !== zeroAddress, 'Choose a Test USDC contract');
    const [code, bridge, rollup, amount] = await Promise.all([
      this.rpc<Hex>('l1', 'eth_getCode', [token, 'latest']), this.read<Address>('l1', token, 'TestUSDC', 'bridgeL1'),
      this.read<bigint>('l1', token, 'TestUSDC', 'destinationRollup'), this.read<bigint>('l1', token, 'TestUSDC', 'MAX_REQUEST_AMOUNT'),
    ]);
    check(this.runtimeMatches(code, 'TestUSDC') && same(bridge, this.bridgeL1) && rollup === BigInt(this.profile.rollupId) && amount === CLAIM_AMOUNT,
      'This is not the current fixed 1,000-token TestUSDC contract');
  }
  async wallet(provider: EthereumProvider, expected?: Address) {
    const [accounts, id] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]);
    const sender = (accounts as Address[])[0];
    check(sender && isAddress(sender) && (!expected || same(expected, sender)) && BigInt(id as string) === BigInt(this.profile.chains.l1.chainId), 'Connect the selected wallet on L1');
    const found = await probeComposer(provider, { l1ChainId: toHex(this.profile.chains.l1.chainId), l2ChainId: toHex(this.profile.chains.l2.chainId), registryAddress: this.profile.registry, l2Address: this.profile.manager });
    check(found.status === 'detected', found.detail);
    return sender;
  }
  data(kind: AssetPending['kind'], recipient: Address) {
    check(['deploy', 'l1', 'l2'].includes(kind), 'Unsupported test-token operation');
    const artifact = this.artifacts.contracts.TestUSDC!;
    return kind === 'deploy' ? encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [this.bridgeL1, BigInt(this.profile.rollupId)] })
      : encodeFunctionData({ abi: artifact.abi, functionName: kind === 'l1' ? 'claim' : 'claimOnL2', args: [recipient] });
  }
  async prepare(kind: AssetPending['kind'], token: Address | undefined, recipient: Address, provider: EthereumProvider) {
    check(isAddress(recipient) && recipient !== zeroAddress, 'Enter a valid recipient');
    await Promise.all([this.validate(), kind !== 'deploy' ? this.validateToken(token!) : undefined]);
    const sender = await this.wallet(provider), nonce = await this.rpc<Hex>('l1', 'eth_getTransactionCount', [sender, 'pending']);
    const pending: AssetPending = { id: kind, kind, chain: 'l1', sender, nonce, recipient, data: this.data(kind, recipient),
      ...(kind === 'deploy' ? {} : { token, to: token }), build: this.artifacts.build!, l2StartBlock: await this.rpc<Hex>('l2', 'eth_blockNumber') };
    let request: Record<string, string> = { from: sender, chainId: toHex(this.profile.chains.l1.chainId), nonce, data: pending.data, value: '0x0', ...(pending.to ? { to: pending.to } : {}) };
    let expiresAt: string | undefined;
    if (kind === 'l2') {
      const quote = await quoteCrossChainFees({ tx: request, from: sender, chainId: request.chainId!, wallet: provider,
        rpc: (method, params) => this.rpc('l1', method, params, true), maxTotalFee: BigInt(this.target.fees.l1) });
      request = quote.transaction; expiresAt = quote.expiresAt;
    } else request.gas = toHex(BigInt(await this.rpc<Hex>('l1', 'eth_estimateGas', [request], true)) * 120n / 100n);
    await this.wallet(provider, sender);
    return { pending, request, expiresAt };
  }
  async reconcile(state: AssetJournal, options: { recordFailure?: boolean } = {}): Promise<AssetJournal> {
    if (!state.pending) return state;
    const tracked = await this.trackPending(state), p = tracked.pending!;
    check(p.build === this.artifacts.build && p.data === this.data(p.kind, p.recipient), 'Saved request belongs to another contract release');
    if (!p.hash) return tracked;
    type Receipt = { status: Hex; blockHash: Hex; blockNumber: Hex; contractAddress: Address | null; logs: Log[] };
    const receipt = await this.rpc<Receipt | null>('l1', 'eth_getTransactionReceipt', [p.hash]);
    if (!receipt) return tracked;
    const [tx, block] = await Promise.all([
      this.rpc<{ from: Address; to: Address | null; input: Hex; nonce: Hex; value: Hex }>('l1', 'eth_getTransactionByHash', [p.hash]),
      this.rpc<{ hash: Hex }>('l1', 'eth_getBlockByNumber', [receipt.blockNumber, false]),
    ]);
    check(tx && same(tx.from, p.sender) && (p.to ? same(tx.to ?? '', p.to) : tx.to === null) && same(tx.input, p.data)
      && BigInt(tx.nonce) === BigInt(p.nonce) && BigInt(tx.value) === 0n, 'The wallet request was replaced with different work');
    if (block?.hash !== receipt.blockHash) return tracked;
    if (receipt.status === '0x0' && options.recordFailure) {
      return { ...tracked, pending: undefined, failed: { request: p, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } };
    }
    check(receipt.status === '0x1', 'The test-token transaction reverted; preserve its record');
    if (p.kind === 'deploy') {
      const token = getContractAddress({ from: p.sender, nonce: BigInt(p.nonce) });
      check(receipt.contractAddress && same(receipt.contractAddress, token), 'Unexpected TestUSDC deployment');
      await this.validateToken(token); return { ...tracked, token, pending: undefined };
    }
    let logs = receipt.logs, token = p.token!;
    if (p.kind === 'l2') {
      const calls = receipt.logs.flatMap(log => { try {
        const e = decodeEventLog({ abi: transferAbi, ...log });
        return same(log.address, this.profile.registry) && e.eventName === 'CrossChainCallExecuted' && same(e.args.sourceAddress, this.bridgeL1) ? [e.args] : [];
      } catch { return []; } });
      check(calls.length === 1, 'Missing unique normal-bridge call');
      const call = calls[0]!;
      const incoming = await findIncomingCallEvidence(this, this.bridgeL2, { ...p, sender: this.bridgeL1, to: call.proxy, data: call.callData }, receipt, this.profile, p.l2StartBlock);
      if (!incoming) return tracked;
      logs = incoming.logs;
      token = await this.read<Address>('l2', this.bridgeL2, 'Bridge', 'getWrappedToken', [p.token!, 0n]);
    }
    check(logs.some(log => { try {
      const e = decodeEventLog({ abi: this.abi('TestUSDC'), ...log });
      const a = e.args as { from?: Address; to?: Address; value?: bigint };
      return same(log.address, token) && e.eventName === 'Transfer' && a.from === zeroAddress && same(a.to ?? '', p.recipient) && a.value === CLAIM_AMOUNT;
    } catch { return false; } }), 'Missing exact 1,000-token mint');
    return { ...tracked, pending: undefined, last: { hash: p.hash, destination: p.kind } };
  }
  /** An explicit retry must recheck the exact failed transaction, since its
   * receipt may have been reorganized since the last observation. */
  async confirmFailure(state: AssetJournal) {
    check(state.failed && !state.pending, 'No failed token transaction is selected');
    const current = await this.reconcile({ token: state.failed.request.token, pending: state.failed.request }, { recordFailure: true });
    check(current.failed, 'The previous transaction is no longer confirmed as failed. Keep its record and check again before retrying.');
    return current.failed;
  }
  async network(token: Address): Promise<SetupNetwork> {
    if (this.discoveredNetwork) { await this.validate(); return discoverToken(this, this.discoveredNetwork, token); }
    await this.validate(); await this.validateToken(token);
    const wrapped = await this.read<Address>('l2', this.bridgeL2, 'Bridge', 'getWrappedToken', [token, 0n]);
    check(wrapped !== zeroAddress, 'The configured token has no wrapped representation on EEZ-X. Initialize the normal bridge asset before configuring this treasury.');
    const code = async (chain: 'l1' | 'l2', address: Address) => ({ chain, address, hash: keccak256(await this.rpc<Hex>(chain, 'eth_getCode', [address, 'latest'])) });
    const asset = await code('l1', token);
    const selected: SetupNetwork = { source: 'paired-testnet', protocolCommit: this.profile.protocolCommit, testnet: true,
      registry: this.profile.registry, manager: this.profile.manager, rollupId: this.profile.rollupId,
      chains: { l1: { chainId: this.profile.chains.l1.chainId, ...this.profile.chains.l1.checkpoint }, l2: { chainId: this.profile.chains.l2.chainId, ...this.profile.chains.l2.checkpoint } },
      protocol: (['l1', 'l2'] as const).map(chain => { const p = this.profile.chains[chain].protocol; return { chain, proxy: p.proxy, implementation: p.implementation, proxyHash: p.proxyCodeHash, implementationHash: p.implementationCodeHash }; }),
      contracts: { usdcProxy: asset, usdcImplementation: asset, wrappedUSDC: await code('l2', wrapped),
        bridgeL1: { ...await code('l1', this.bridgeL1), bindings: { manager: this.profile.registry, counterpart: this.bridgeL2, rollupId: '0' } },
        bridgeL2: { ...await code('l2', this.bridgeL2), bindings: { manager: this.profile.manager, counterpart: this.bridgeL1, rollupId: String(this.profile.rollupId) } } },
    };
    await new MainnetSetup(this.setupTarget, this.artifacts, selected).validate();
    return selected;
  }
}
