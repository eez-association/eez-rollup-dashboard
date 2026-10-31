import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toHex, type Hex } from 'viem';
import { errorCode, feeAmounts, feeErrorMessage, FeeOptionError, FeeRpcError, fetchFeeQuote, parseFeeLimit, recoverFeeTransaction, retryFeeRead, StaleFeeQuote, submitFeeQuote, walletQuantity, type FeeConfig, type FeeIntent, type FeeQuote, type FeeTransaction, type FeeType, type QuotedFee } from '../../src/lib/falcon/l2Fees.ts';

const config: FeeConfig = { url: 'https://example.invalid/composer/l2', maxTotalFee: 100_000_000n, nativeSymbol: 'xDAI' };
const txHash = `0x${'ab'.repeat(32)}` as Hex;
const signal = () => new AbortController().signal;
const selection = (type: FeeType = '0x2') => ({ chainId: 916969, type });
function fixture(type: FeeType = '0x2', explicit = false): QuotedFee {
  const resolved: Required<FeeIntent> = { type, chainId: '0xdfde9', from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}`, nonce: '0x0', gas: toHex(6_050_247n), value: '0x0', data: '0x1234' };
  const intent: FeeIntent = explicit ? { ...resolved } : { from: resolved.from, to: resolved.to, data: resolved.data, value: resolved.value };
  const fees = type === '0x0' ? { gasPrice: '0xf' as Hex } : { maxFeePerGas: '0xf' as Hex, maxPriorityFeePerGas: '0x5' as Hex };
  const canonical = JSON.stringify({ chainId: resolved.chainId, data: resolved.data, from: resolved.from, gas: resolved.gas,
    nonce: resolved.nonce, to: resolved.to, type: resolved.type, value: resolved.value });
  const quote: FeeQuote = { version: 1, chainId: resolved.chainId, nonce: resolved.nonce, expiresAt: toHex(Math.floor(Date.now() / 1000) + 30),
    options: [{ type, gas: resolved.gas, requestHash: keccak256(toHex(canonical)), estimatedFee: toHex(85_920_615n), ...fees }] };
  return { quote, intent, type, chainId: resolved.chainId, transaction: { ...resolved, ...fees } };
}
function reader(tx: FeeTransaction, overrides: Record<string, unknown> = {}) {
  return { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    const responses = { eth_chainId: 916969, eth_accounts: [tx.from], eth_getTransactionCount: '0x00', eth_getBalance: toHex(config.maxTotalFee), ...overrides };
    assert(method in responses, `Unexpected wallet RPC: ${method}`);
    if (method === 'eth_getTransactionCount') assert.deepEqual(params, [tx.from, 'pending']);
    return responses[method];
  } };
}
const response = (quote: FeeQuote) => Response.json({ jsonrpc: '2.0', id: 1, result: quote });
test('Configured maximum fee never rounds or accepts unsafe decimal input', () => {
  assert.equal(parseFeeLimit('0.1'), 100_000_000_000_000_000n);
  assert.equal(parseFeeLimit('0.000000000000000001'), 1n);
  for (const input of ['', '0', '-1', '0.0000000000000000009', '1e-3', 'Infinity', '01', ' 1']) assert.throws(() => parseFeeLimit(input));
});
test('One compact RPC resolves automatic gas/nonce and preserves explicit fields for both formats', async () => {
  for (const type of ['0x0', '0x2'] as const) for (const explicit of [false, true]) {
    const quoted = fixture(type, explicit); let requests = 0;
    const result = await fetchFeeQuote(quoted.intent, config, selection(type), signal(), async (url, init) => {
      requests++; assert.equal(url, config.url);
      assert.equal(init!.credentials, 'omit'); assert.equal(init!.redirect, 'error');
      assert.deepEqual(JSON.parse(init!.body as string), { jsonrpc: '2.0', id: 1, method: 'eez_quoteFee', params: [quoted.intent, { transactionTypes: [type] }] });
      assert.equal('gas' in quoted.intent, explicit); assert.equal('nonce' in quoted.intent, explicit);
      assert.equal('gasLimit' in quoted.intent, false); assert.equal('gasPrice' in quoted.intent, false);
      return response(quoted.quote);
    });
    assert.deepEqual(result, quoted); assert.equal(requests, 1);
  }
});
test('Malformed or conflicting intents never reach Composer, including creation and forbidden fields', async () => {
  for (const patch of [
    { from: undefined }, { to: undefined }, { to: '0x' }, { gas: '0x005208' }, { nonce: 1 }, { value: '0x00' },
    { gasLimit: '0x5208' }, { gasPrice: '0x1' }, { maxFeePerGas: '0x1' }, { maxPriorityFeePerGas: '0x1' },
    { accessList: [] }, { authorizationList: [] }, { type: '0x0' },
  ]) {
    await assert.rejects(fetchFeeQuote({ ...fixture().intent, ...patch } as FeeIntent, config, selection(), signal(), async () => assert.fail('invalid intent must not be sent')));
  }
});
test('Estimated execution fee is the quoted amount; reservation and wallet fields use the selected option', async () => {
  for (const type of ['0x0', '0x2'] as const) {
    const quoted = fixture(type), amounts = feeAmounts(quoted);
    assert.deepEqual(amounts, { estimated: 85_920_615n, maximum: 90_753_705n });
    let sent = 0;
    const hash = await submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction, { eth_getBalance: toHex(amounts.maximum) }), isCurrent: () => true,
      send: async (tx, validate) => { validate(); sent++; assert.deepEqual(tx, quoted.transaction);
        assert.equal(tx.value, '0x0'); assert.equal('gasLimit' in tx, false); assert.equal('estimatedFee' in tx, false); assert.equal('requestHash' in tx, false); return txHash; } });
    assert.equal(hash, txHash); assert.equal(sent, 1);
  }
});
test('Pending wallet observations may be numeric or padded without relaxing quote quantities', async () => {
  for (const value of [0, '0x00', '0x0']) {
    const quoted = fixture();
    assert.equal(await submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction, { eth_getTransactionCount: value }), isCurrent: () => true,
      send: async (_tx, validate) => { validate(); return txHash; } }), txHash);
  }
  for (const value of [null, -1, NaN, 1.1, Number.MAX_SAFE_INTEGER + 1, '0x', '0x1\n', 0n]) assert.throws(() => walletQuantity(value));
});
test('Chain, selected account, pending nonce and balance changes all prevent a wallet prompt', async () => {
  for (const type of ['0x0', '0x2'] as const) for (const [overrides, error] of [
    [{ eth_chainId: 1 }, /different chain/], [{ eth_accounts: [fixture().intent.to, fixture().intent.from] }, /account changed/],
    [{ eth_getTransactionCount: '0x01' }, StaleFeeQuote], [{ eth_getBalance: toHex(90_753_704n) }, /Insufficient xDAI/],
  ] as const) {
    const quoted = fixture(type); let sends = 0;
    await assert.rejects(submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction, overrides), isCurrent: () => true,
      send: async () => { sends++; return txHash; } }), error);
    assert.equal(sends, 0);
  }
});
test('Binding, explicit gas/nonce, hex quantities, estimated coverage and expiry fail before any wallet prompt', async () => {
  for (const mutate of [
    (q: QuotedFee) => { q.intent.data = '0xabcd'; },
    (q: QuotedFee) => { q.intent.gas = '0x5208'; },
    (q: QuotedFee) => { q.intent.nonce = '0x1'; },
    (q: QuotedFee) => { q.quote.chainId = '0x1'; },
    (q: QuotedFee) => { q.quote.nonce = '0x00'; },
    (q: QuotedFee) => { q.quote.expiresAt = '0x0'; },
    (q: QuotedFee) => { q.quote.expiresAt = toHex(Math.floor(Date.now() / 1000) + 100); },
    (q: QuotedFee) => { Object.assign(q.quote.options[0]!, { estimatedFee: toHex(90_753_706n) }); },
    (q: QuotedFee) => { Object.assign(q.quote.options[0]!, { maxPriorityFeePerGas: '0x10' }); },
    (q: QuotedFee) => { Object.assign(q.quote.options[0]!, { requestHash: txHash }); },
  ]) {
    const quoted = fixture(); mutate(quoted);
    await assert.rejects(submitFeeQuote({ quoted, config, wallet: { request: async () => assert.fail('invalid quote must not reach wallet') },
      isCurrent: () => true, send: async () => assert.fail('must not prompt') }));
  }
});
test('Application ceiling rejects the maximum reservation even when estimatedFee is lower', async () => {
  for (const type of ['0x0', '0x2'] as const) {
    const quoted = fixture(type), capped = { ...config, maxTotalFee: 90_753_704n };
    await assert.rejects(fetchFeeQuote(quoted.intent, capped, selection(type), signal(), async () => response(quoted.quote)), /app limit/);
    await assert.rejects(submitFeeQuote({ quoted, config: capped, wallet: reader(quoted.transaction), isCurrent: () => true,
      send: async () => assert.fail('ceiling') }), /app limit/);
  }
});
test('Superseded intentHash quotes are rejected before reaching the wallet', async () => {
  for (const type of ['0x0', '0x2'] as const) {
    const quoted = fixture(type);
    const option = quoted.quote.options[0]!;
    assert('requestHash' in option);
    const { requestHash, ...fields } = option;
    quoted.quote.options[0] = { ...fields, intentHash: requestHash } as unknown as typeof option;
    await assert.rejects(fetchFeeQuote(quoted.intent, config, selection(type), signal(), async () => response(quoted.quote)), /Unexpected transaction fields/);
    await assert.rejects(submitFeeQuote({ quoted, config, wallet: { request: async () => assert.fail('old quote must not reach wallet') },
      isCurrent: () => true, send: async () => assert.fail('old quote must not send') }), /Unexpected transaction fields/);
  }
});
test('Per-option failures retain the code and never switch formats or fall back', async () => {
  for (const type of ['0x0', '0x2'] as const) {
    const quoted = fixture(type); let requests = 0;
    quoted.quote.options = [{ type, error: { code: 'unsupported_transaction', message: 'This format cannot execute the call' } }];
    await assert.rejects(fetchFeeQuote(quoted.intent, config, selection(type), signal(), async () => {
      requests++; return response(quoted.quote);
    }), (error: unknown) => error instanceof FeeOptionError && errorCode(error) === 'unsupported_transaction' && error.message.includes('This format'));
    assert.equal(requests, 1);
    await assert.rejects(submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction), isCurrent: () => true,
      send: async () => assert.fail('failed option must not send') }), /Fee option unavailable/);
  }
});
test('A failed selected option cannot borrow another format, but an unrelated failed option does not invalidate success', async () => {
  for (const type of ['0x0', '0x2'] as const) {
    const other = type === '0x0' ? '0x2' : '0x0';
    const quoted = fixture(type);
    quoted.quote.options.push({ type: other, error: { code: 'invalid_transaction', message: 'Other format failed' } });
    assert.equal(await submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction), isCurrent: () => true,
      send: async (tx, validate) => { validate(); assert.equal(tx.type, type); return txHash; } }), txHash);
    quoted.type = other;
    await assert.rejects(submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction), isCurrent: () => true,
      send: async () => assert.fail('must not choose the successful but unselected option') }), /Fee option unavailable/);
  }
});
test('Late quotes are discarded after cancellation; foreign chains and malformed RPC envelopes fail closed', async () => {
  const quoted = fixture(), abort = new AbortController();
  await assert.rejects(fetchFeeQuote(quoted.intent, config, selection(), abort.signal, async () => {
    abort.abort(); return response(quoted.quote);
  }), { name: 'AbortError' });
  await assert.rejects(fetchFeeQuote(quoted.intent, config, { chainId: 1, type: '0x2' }, signal(), async () => response(quoted.quote)), /chain mismatch/);
  for (const body of [null, { jsonrpc: '2.0', id: 2, result: quoted.quote }, { jsonrpc: '2.0', id: 1, result: {} }]) {
    await assert.rejects(fetchFeeQuote(quoted.intent, config, selection(), signal(), async () => Response.json(body)));
  }
});
test('Structured RPC errors survive HTTP; only documented transient read errors retry, at most twice', async () => {
  let requests = 0; const quoted = fixture();
  await assert.rejects(fetchFeeQuote(quoted.intent, config, selection(), signal(), async () => {
    requests++; return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32004, message: 'unavailable', data: { code: 'quote_busy', message: 'busy' } } });
  }), (e: unknown) => e instanceof FeeRpcError && e.rpcCode === -32004 && errorCode(e) === 'quote_busy');
  assert.equal(requests, 3);
  for (const code of ['invalid_transaction', 'unsupported_transaction', 'insufficient_funds', 'poster_insufficient_funds', 'quote_limit', 'quotes_disabled', 'l2_tip_underfunded']) {
    let calls = 0;
    await assert.rejects(fetchFeeQuote(quoted.intent, config, selection(), signal(), async () => {
      calls++; return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32004, message: code, data: { code } } });
    }), (error: unknown) => errorCode(error) === code && !!feeErrorMessage(error)?.includes(code));
    assert.equal(calls, 1);
  }
  let cancelledReads = 0; const abort = new AbortController(); abort.abort();
  await assert.rejects(retryFeeRead(async () => { cancelledReads++; }, abort.signal), { name: 'AbortError' });
  assert.equal(cancelledReads, 0);
  assert.match(feeErrorMessage(new FeeRpcError({ code: -32601, message: 'missing' }))!, /Composer L2/);
  assert.equal(errorCode(new FeeRpcError({ code: -32602, message: 'invalid', data: { code: 'invalid_transaction' } })), 'invalid_transaction');
});
test('Key changes and expiry during asynchronous wallet reads never open a prompt', async () => {
  for (const expire of [false, true]) {
    const quoted = fixture(); let current = true;
    const wallet = reader(quoted.transaction);
    await assert.rejects(submitFeeQuote({ quoted, config, wallet: { request: async args => {
      const result = await wallet.request(args);
      if (args.method === 'eth_accounts') { if (expire) quoted.quote.expiresAt = '0x0'; else current = false; }
      return result;
    } }, isCurrent: () => current, send: async () => assert.fail('stale preflight') }), expire ? StaleFeeQuote : /changed/);
  }
});
test('Expired previews are never sent; a new quote is required', async () => {
  const quoted = fixture(); quoted.quote.expiresAt = '0x0';
  await assert.rejects(fetchFeeQuote(quoted.intent, config, selection(), signal(), async () => response(quoted.quote)), StaleFeeQuote);
  await assert.rejects(submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction), isCurrent: () => true,
    send: async () => assert.fail('expired quote') }), StaleFeeQuote);
});
test('No resubmission after wallet errors, even if the prompt outlives expiry; late successful hashes survive', async () => {
  for (const code of [4001, 'l2_tip_underfunded', 'transport_lost']) {
    const quoted = fixture(); let sends = 0; const error = { code };
    await assert.rejects(submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction), isCurrent: () => true,
      send: async (_tx, validate) => { validate(); sends++; quoted.quote.expiresAt = '0x0'; throw error; } }), e => e === error);
    assert.equal(sends, 1);
  }
  const quoted = fixture(); let current = true;
  assert.equal(await submitFeeQuote({ quoted, config, wallet: reader(quoted.transaction), isCurrent: () => current,
    send: async (_tx, validate) => { validate(); current = false; return txHash; } }), txHash);
});
test('Ambiguous submission recovery uses the resolved chain/nonce and exact signed calldata without resending', async () => {
  const { transaction: intent } = fixture();
  const tx = { ...intent, input: intent.data };
  const wallet = (result: unknown) => ({ request: async ({ method }: { method: string }) => { assert.equal(method, 'eth_getTransactionByHash'); return result; } });
  assert.equal(await recoverFeeTransaction(wallet(tx), txHash, intent), txHash);
  for (const patch of [{ nonce: '0x1' }, { chainId: '0x1' }, { value: '0x1' }, { from: intent.to }, { to: intent.from }, { input: '0x12' }]) await assert.rejects(recoverFeeTransaction(wallet({ ...tx, ...patch }), txHash, intent), /does not match/);
  await assert.rejects(recoverFeeTransaction(wallet(null), txHash, intent), /not found/);
});
