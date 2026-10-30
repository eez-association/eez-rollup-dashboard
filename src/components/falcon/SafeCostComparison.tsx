import { useId, useState } from 'react';
import { formatUnits } from 'viem';
import { COST_REFERENCE, estimateSafeCosts, formatCostUsd, parseCostPrices, type CostPrices, type SafeCostEvidence } from '../../lib/falcon/safeCosts.ts';
import shared from './FalconPanel.module.css';
import styles from './SafeCostComparison.module.css';

const integer = (value: bigint | number) => value.toLocaleString('en-US');
/** Receives only public, receipt-bound measurements. No provider, signer or secret key is needed. */
export function SafeCostComparison({ evidence, l1Name, l1Symbol, l2Symbol, checking, checkDisabled, onCheckL1 }: {
  evidence: SafeCostEvidence; l1Name: string; l1Symbol: string; l2Symbol: string; checking: boolean; checkDisabled: boolean; onCheckL1: () => void;
}) {
  const id = useId();
  const [input, setInput] = useState<CostPrices>({ l1Gwei: COST_REFERENCE.l1Gwei, blobGwei: COST_REFERENCE.blobGwei, ethUsd: COST_REFERENCE.ethUsd });
  const prices = parseCostPrices(input), { source, settlement } = evidence;
  const costs = source && prices ? estimateSafeCosts(source, settlement, prices) : null;
  const money = (wei: bigint | null | undefined) => wei == null || !prices ? '—'
    : <span className={styles.money} title={`${formatUnits(wei * prices.usdMicros, 24)} USD`}>{formatCostUsd(wei, prices.usdMicros)}</span>;
  const range = (values: bigint[] | undefined) => values
    ? <span className={styles.range}>{values.map((value, index) => <span key={index}>{index > 0 && ' – '}{money(value)}</span>)}</span> : '—';
  const missingL1 = checking ? 'Checking…' : evidence.l1Verified ? 'Unavailable' : 'Needs L1 check';
  const l1Cost = (wei: bigint | null | undefined) => settlement ? money(wei) : <span className={styles.muted}>{missingL1}</span>;
  const custom = input.l1Gwei !== COST_REFERENCE.l1Gwei || input.blobGwei !== COST_REFERENCE.blobGwei || input.ethUsd !== COST_REFERENCE.ethUsd;
  const share = source ? (100 * source.encodedBlobBytes / Number(COST_REFERENCE.blobCapacity)).toFixed(3) : '';
  return <section id="safe-cost-comparison" className={styles.comparison} aria-labelledby={`${id}-heading`} aria-busy={checking} data-stage={checking ? 'checking' : !source || (evidence.l1Verified && !settlement) ? 'unavailable' : settlement ? 'settled' : 'pending-l1'} data-source-hash={evidence.sourceHash}>
    <div className={styles.heading}>
      <h3 id={`${id}-heading`}>Cost comparison</h3>
      <span className={shared.badge}>{checking ? 'Checking receipts' : evidence.l1Verified ? 'L1 verified' : source ? 'L1 check needed' : 'Data unavailable'}</span>
    </div>
    <p className={shared.hint}>Resource cost model · Ethereum prices · Shared blob</p>
    {source && <p className={shared.hint}>Wallet fee paid: <strong>{formatUnits(source.gasUsed * source.gasPrice, 18)} {l2Symbol}</strong>. Settlement is included; the comparison models resource costs separately.</p>}
    <div className={styles.totals}>
      <div className={styles.total}>
        <span className={`${shared.label} ${styles.ethereum}`}>Ethereum</span>
        <strong data-testid="cost-ethereum">{range(costs?.ethereum)}</strong>
        <span className={shared.hint}>Direct execution estimate</span>
      </div>
      <div className={styles.total}>
        <span className={`${shared.label} ${styles.eez}`}>EEZ-X</span>
        <strong data-testid="cost-eez">{checking ? 'Checking…' : source && !settlement ? evidence.l1Verified ? 'Cost unavailable' : 'Check L1' : money(costs?.eezTotal)}</strong>
        <span className={shared.hint}>{settlement ? 'Receipt gas + proportional blob' : source
          ? <>L2 only: {money(costs?.l2Total)}<br />{evidence.l1Verified ? 'L1 execution verified · fees unavailable' : 'Total requires an L1 check'}</>
          : checking ? 'Reading transaction data…' : 'Recheck the L2 receipt'}</span>
      </div>
    </div>
    {source && !settlement && <div className={styles.check}>
      <p className={shared.hint}>{evidence.l1Verified ? 'Retry to load the missing L1 fees.' : 'Check L1 execution to complete the total.'} This only reads data; your wallet may ask to switch networks.</p>
      <button id="cost-check-l1" className={`btn btn-outline ${shared.action}`} disabled={checkDisabled || checking} onClick={onCheckL1}>
        {checking ? 'Checking…' : evidence.l1Verified ? 'Retry cost lookup' : 'Check L1 execution'}
      </button>
    </div>}
    {evidence.problem && <p className={styles.problem} role="status">{evidence.problem}</p>}
    <details className={shared.details}>
      <summary>View breakdown &amp; assumptions</summary>
      {source && <>
        <table className={styles.table}>
          <caption className={styles.caption}>Estimated USD costs · very small amounts use scientific notation</caption>
          <thead><tr><th scope="col">Component</th><th scope="col">Ethereum</th><th scope="col">EEZ-X</th></tr></thead>
          <tbody>
            <tr><th scope="row">L1 execution &amp; overhead</th><td>{range(costs?.ethereumExecution)}</td><td>{l1Cost(costs?.l1Execution)}{settlement && <small>{integer(settlement.gasUsed - settlement.calldata.gas)} gas</small>}</td></tr>
            <tr><th scope="row">L1 calldata</th><td>{money(costs?.ethereumCalldata)}<small>{integer(source.calldata.bytes)} bytes · {integer(source.calldata.gas)} gas</small></td><td>{l1Cost(costs?.l1Calldata)}{settlement && <small>{integer(settlement.calldata.bytes)} bytes · {integer(settlement.calldata.gas)} gas</small>}</td></tr>
            <tr><th scope="row">L2 execution &amp; overhead <small>Base fee only</small></th><td className={styles.muted}>Not used</td><td data-testid="cost-l2-execution">{money(costs?.l2Execution)}<small>{integer(source.gasUsed - source.calldata.gas)} gas</small></td></tr>
            <tr><th scope="row">L2 calldata <small>Base fee only</small></th><td className={styles.muted}>Not used</td><td data-testid="cost-l2-calldata">{money(costs?.l2Calldata)}<small>{integer(source.calldata.bytes)} bytes · {integer(source.calldata.gas)} gas</small></td></tr>
            <tr><th scope="row">L1 blob data <small>Proportional estimate</small></th><td className={styles.muted}>Not used</td><td data-testid="cost-blob">{l1Cost(costs?.blob)}{settlement && <small>{integer(source.encodedBlobBytes)} estimated bytes · {share}% of capacity</small>}</td></tr>
          </tbody>
        </table>
        <p className={shared.hint}>The blob estimate assumes full shared capacity: {integer(source.encodedBlobBytes)} encoded bytes / {integer(COST_REFERENCE.blobCapacity)} useful bytes per blob. This includes the signed transaction, Safe call, return and reference batch overhead. Actual batch metadata and unused capacity can increase the cost.</p>
        <p className={shared.hint}>EEZ-X uses this transfer’s L2 receipt and the whole L1 settlement receipt. L1 settlement gas is not divided between transactions. Ethereum uses a local three-key benchmark plus this transfer’s calldata; it is an estimate, not a mainnet simulation.</p>
        <p className={shared.hint}>The current L1 is {l1Name}. Dollar totals reprice its gas as Ethereum and value L2 base fees as ETH. Collected L2 priority fees are excluded because they already pay for settlement. The wallet quote includes whole blobs and the operator margin; this shared-capacity model excludes the margin and deployment.</p>
        <div className={styles.observed}>
          <span className={shared.label}>Observed network fees</span>
          <p>L2 wallet fee paid: {formatUnits(source.gasUsed * source.gasPrice, 18)} {l2Symbol} · {integer(source.gasPrice)} wei/gas ({formatUnits(source.gasPrice, 9)} gwei).</p>
          <p>Base fee: {formatUnits(source.gasUsed * source.baseFeePerGas, 18)} {l2Symbol} · Priority fee: {formatUnits(source.gasUsed * (source.gasPrice - source.baseFeePerGas), 18)} {l2Symbol}. The operator’s L1 settlement is not added to your wallet fee.</p>
          {settlement && <p>L1 settlement, including whole blobs: {formatUnits(settlement.gasUsed * settlement.gasPrice + settlement.blobGasUsed * settlement.blobGasPrice, 18)} {l1Symbol}.</p>}
        </div>
      </>}
      <fieldset className={styles.prices} aria-describedby={!prices ? `${id}-price-error` : undefined}>
        <legend>{custom ? 'Custom prices' : 'Reference prices'}</legend>
        {([['l1Gwei', 'Ethereum gas · gwei'], ['blobGwei', 'Blob gas · gwei'], ['ethUsd', 'ETH price · USD']] as const).map(([key, label]) => <label key={key} className={styles.price}>
          <span>{label}</span>
          <input className={shared.input} inputMode="decimal" value={input[key]} maxLength={20} onChange={event => setInput(before => ({ ...before, [key]: event.target.value }))} />
        </label>)}
      </fieldset>
      {!prices && <p id={`${id}-price-error`} className={styles.problem}>Enter nonnegative gas prices and a positive ETH price using decimal numbers.</p>}
      <p className={shared.hint}>Reference snapshot: {new Date(COST_REFERENCE.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. These prices do not refresh automatically. Ethereum gas is the assumed effective price, including any tip you enter.</p>
      <p className={shared.hint}>Calldata is charged at 4 gas per zero byte and 16 per nonzero byte. The Ethereum estimate also checks the transaction-level calldata floor; calldata is never added twice.</p>
    </details>
  </section>;
}
