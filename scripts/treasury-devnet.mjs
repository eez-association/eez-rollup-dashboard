// Owns only this invocation's devnet UI. Keys remain in the Node test/operator
// process; the browser application always requests signatures from a wallet.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { startComposerAdapter } from './treasury-composer.mjs';
import { createServer } from 'vite';
import { keccak256, stringToHex, toHex } from 'viem';
import { invoiceFixture } from './treasury-invoices.mjs';
import { setupPayments } from '../tests/integration/treasury-payments.mjs';
import { runFixture } from '../tests/integration/treasury-owners.mjs';

const [networkFile, evidenceFile] = process.argv.slice(2);
const directory = dirname(evidenceFile);
let server;
const adapters = [];
try {
  const fixture = await runFixture(networkFile, evidenceFile, { setupOnly: true });
  const { network, rpc, send, A, B, C } = fixture;
  for (const chain of [network.l1, network.l2])
    for (const owner of [A, B, C]) await send(chain, owner.address, '0x', 10n ** 18n);
  const paymentFixture = await setupPayments(fixture);
  fixture.paymentFixture = paymentFixture;
  const code = [...paymentFixture.code];
  for (const [chain, address] of [['l1', fixture.safeL1], ['l1', fixture.singletonL1], ['l1', network.registry],
    ['l2', fixture.safeL2], ['l2', fixture.singletonL2], ['l2', fixture.adapter], ['l2', fixture.action], ['l2', fixture.manager]]) {
    code.push({ chain, address, hash: keccak256(await rpc(network[chain].rpc, 'eth_getCode', [address, 'latest'])) });
  }
  const l1Genesis = (await rpc(network.l1.rpc, 'eth_getBlockByNumber', ['0x0', false])).hash;
  const l2Genesis = (await rpc(network.l2.rpc, 'eth_getBlockByNumber', ['0x0', false])).hash;
  const treasury = { version: 1, environment: 'isolated-devnet',
    instance: keccak256(stringToHex(`${l1Genesis}:${l2Genesis}:${fixture.safeL2}`)),
    l1: { chainId: network.l1.chainId, rpc: network.l1.rpc, front: network.l1.front, genesis: l1Genesis },
    l2: { chainId: network.l2.chainId, rpc: network.l2.rpc, front: network.l2.front, genesis: l2Genesis },
    registry: network.registry, manager: fixture.manager, safeL1: fixture.safeL1, safeL2: fixture.safeL2,
    adapter: fixture.adapter, action: fixture.action, code,
    payments: paymentFixture.payments,
    ownerLabels: Object.fromEntries([A, B, C].map((a, i) => [a.address.toLowerCase(), `Owner ${'ABC'[i]}`])),
  };
  const info = await rpc(network.l2.front, 'eez_composerInfo');
  for (const chain of ['l1', 'l2']) adapters.push(await startComposerAdapter(network[chain].front, {
    chainId: network[chain].chainId, genesis: treasury[chain].genesis, statusRpc: network.l2.rpc,
    l1ChainId: network.l1.chainId, l2ChainId: network.l2.chainId, registry: network.registry, manager: fixture.manager,
  }));
  const runtime = { browser: { treasury, networkName: 'Treasury EEZ-X Devnet', l1NetworkName: 'Treasury L1 Devnet',
    l1RpcUrl: '/rpc/l1', l2RpcUrl: '/rpc/l2', l1FrontUrl: '/composer/l1', l2FrontUrl: '/composer/l2',
    l1ContractAddress: network.registry, l2ContractAddress: fixture.manager, rollupId: String(network.rollupId),
    rollupManagerAddress: info.eezContracts.eezRollupManagerAddress, l1FeesEnabled: false, l2FeesEnabled: false },
    proxy: { l1Rpc: network.l1.rpc, l2Rpc: network.l2.rpc, l1Front: adapters[0].url, l2Front: adapters[1].url } };
  const configPath = resolve(directory, 'ui-config.json');
  writeFileSync(configPath, JSON.stringify(runtime, null, 2));
  process.env.EEZ_UI_RUNTIME_CONFIG = configPath;
  // Vite interprets port 0 as its default, so reserve a free port explicitly.
  // strictPort makes a competing bind fail instead of taking someone else's port.
  const reservation = createNetServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const invoices = invoiceFixture(fixture, treasury, directory);
  fixture.invoices = invoices;
  // A frozen browser rehearsal must not reload when local HMR websockets are
  // unavailable. Interactive devnets retain normal development hot reload.
  server = await createServer({ plugins: [invoices.plugin], configFile: resolve('vite.config.ts'), envDir: false, cacheDir: resolve(directory, 'node_modules/.vite'),
    server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['127.0.0.1'], hmr: process.env.TREASURY_UI_MODE === 'test' ? false : undefined }, logLevel: 'warn', clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  treasury.payments.invoiceControl = `${origin}/treasury-fixture/invoices`;
  treasury.l1.rpc = `${origin}/rpc/l1`;
  treasury.l1.front = `${origin}/composer/l1`;
  treasury.l2.rpc = `${origin}/rpc/l2`;
  treasury.l2.front = `${origin}/composer/l2`;
  writeFileSync(configPath, JSON.stringify(runtime, null, 2));
  const session = { url: `${origin}/dashboard/#/treasury-demo`, stopFile: resolve(directory, 'stop'), treasury };
  writeFileSync(resolve(directory, 'ui-session.json'), JSON.stringify(session, null, 2) + '\n');
  writeFileSync(resolve(directory, 'public-test-wallets.json'), JSON.stringify([A, B, C].map((owner, i) => ({
    label: `Owner ${'ABC'[i]}`, address: owner.address, publicTestPrivateKey: toHex([0xa11cen, 0xb0bn, 0xc0cn][i], { size: 32 }),
  })), null, 2) + '\n');
  console.log(`Treasury UI ready: ${session.url}`);
  if (process.env.TREASURY_UI_MODE === 'serve') {
    while (!existsSync(session.stopFile)) await new Promise(resolve => setTimeout(resolve, 1000));
    // The common native harness still checks final safe-prefix convergence and
    // the attestation. This manual session is never reported as a UI test pass.
    const settled = await rpc(network.l2.rpc, 'eth_getBlockByNumber', ['safe', false]);
    fixture.evidence.lastSuccessfulL2Block = Number(BigInt(settled.number));
    fixture.evidence.mode = 'manual-devnet';
    fixture.checkpoint();
  } else {
    const { browserScenario } = await import('../tests/integration/treasury-browser.mjs');
    await browserScenario(fixture, session, directory);
  }
} catch (error) {
  const evidence = existsSync(evidenceFile) ? JSON.parse(readFileSync(evidenceFile)) : {};
  evidence.verified = false; evidence.failure = String(error.stack || error);
  writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  await Promise.all(adapters.map(adapter => adapter.close()));
}
