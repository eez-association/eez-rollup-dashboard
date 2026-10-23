#!/usr/bin/env python3
"""Build and run the dashboard's Safe scenario using EEZ's existing native testkit.

A generated Cargo package keeps the runtime checkout unchanged. Its dependency
lock is derived from, and checked against, that checkout's lockfile. Source,
artifact and executable identities plus failed-run diagnostics stay in .runtime.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import tomllib

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_REVISION = 'fa916b13254a36423cad130080dde367bb18a7d6'
PROTOCOL_REVISION = '855fe0602484750861b4c31502a1a91355d33ed6'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


def source_identity(runtime):
    # Include uncommitted implementation files without collecting operator config.
    names = subprocess.check_output(['git', '-C', str(runtime), 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'crates', 'contracts/src', 'Cargo.toml', 'Cargo.lock', 'scripts/builder-stub.py', 'contracts/foundry.toml']).decode().split('\0')
    files = {name: digest(runtime / name) for name in sorted(set(names)) if name and (runtime / name).is_file()}
    return {'head': git(runtime, 'rev-parse', 'HEAD'), 'files': files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True, help='runtime checkout at the proposal pin; sources are read, not edited')
    parser.add_argument('--cargo-target-dir', type=Path, help='optional existing Cargo compilation cache')
    parser.add_argument("--ui", choices=("test", "serve"), help="run the connected browser scenario or keep an isolated UI devnet running")
    parser.add_argument("--reuse-run", type=Path, help="reuse exact verified native binaries/harness from a previous successful run; source and executable hashes must match")
    parser.add_argument('--safe-version', choices=('1.4.1', '1.3.0'), default='1.4.1', help='Safe contracts for the isolated scenario; 1.3.0 uses the published L2 variant on both chains')
    parser.add_argument('--standard-bridge-snapshot', type=Path, help='read-only mainnet runtime snapshot for the isolated standard-bridge rehearsal')
    args = parser.parse_args()
    if args.standard_bridge_snapshot:
        assert not args.ui, 'the standard bridge scenario owns its browser rehearsal'
        args.standard_bridge_snapshot = args.standard_bridge_snapshot.resolve()
    runtime = args.runtime.resolve()
    assert git(runtime, 'rev-parse', 'HEAD') == RUNTIME_REVISION, 'runtime must match proposal revision'
    for core in (runtime / 'eez-core-protocol', ROOT / 'contracts/lib/eez-core-protocol'):
        assert git(core, 'rev-parse', 'HEAD') == PROTOCOL_REVISION, 'protocol pin mismatch'
        assert not git(core, 'diff', '--name-only'), 'tracked protocol edits are unsupported'
    assert '1.7.1' in subprocess.check_output(['forge', '--version'], text=True), 'Foundry 1.7.1 required'
    state = ROOT / '.runtime/treasury-integration'
    state.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%S-'), dir=state))
    print(f'Evidence: {run}', flush=True)
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'CC', 'CXX', 'LIBCLANG_PATH') if key in os.environ}
    env.update({'LLVM_SYS_221_PREFIX': '/usr/lib/llvm-22', 'CARGO_BUILD_JOBS': '4', 'NO_COLOR': '1'})
    env['PATH'] = '/usr/lib/llvm-22/bin:' + env['PATH']
    target = (args.cargo_target_dir or state / 'cargo-target').resolve()
    env['CARGO_TARGET_DIR'] = str(target)
    # Keep testkit/Chromium temporary files with this owned run, independent of
    # an operator's shared /tmp quota or other running devnets.
    (run / 'tmp').mkdir()
    env['TMPDIR'] = str(run / 'tmp')
    original = source_identity(runtime)
    (run / 'runtime-sources.json').write_text(json.dumps(original, indent=2) + '\n')
    app_paths = ['scripts/treasury-relay.py', 'scripts/run-treasury-integration.py', 'tests/integration/treasury_owners.rs', 'tests/integration/treasury-owners.mjs', 'src/lib/treasury/safeTransactions.ts', 'contracts/src/l2/L1Owners.sol', 'contracts/test/fixtures/TreasuryOwnerAction.sol', 'contracts/foundry.toml', 'contracts/legacy/foundry.toml']
    if args.ui:
        app_paths += ['scripts/treasury-relay.py', 'scripts/treasury-invoices.mjs', 'src/lib/treasury/invoices.ts', 'tests/treasury-invoices.test.mjs', 'tests/integration/treasury-invoice-browser.mjs', 'contracts/test/fixtures/InvoiceMerchant.sol', 'contracts/test/fixtures/InvoiceTreasuryPolicy.sol', 'contracts/test/TreasuryInvoice.t.sol', 'contracts/src/chiado/TreasuryBridge.sol', 'contracts/src/chiado/TreasuryPolicy.sol', 'contracts/src/l2/TreasuryPolicyBase.sol', 'contracts/src/chiado/TreasuryAliasReader.sol', 'contracts/test/TreasuryPolicy.t.sol', 'contracts/test/helpers/OwnerFixture.sol', 'contracts/test/fixtures/DevnetUSDC.sol', 'tests/integration/treasury-payments.mjs', 'tests/integration/treasury-payment-browser.mjs', 'src/lib/treasury/payments.ts', 'tests/treasury-payments.test.mjs', 'scripts/treasury-composer.mjs', 'tests/treasury-composer.test.mjs', 'src/lib/composerDiscovery.ts', 'scripts/treasury-devnet.mjs', 'scripts/treasury-owner.mjs', 'tests/integration/treasury-browser.mjs', 'tests/treasury-client.test.mjs', 'src/lib/treasury/client.ts', 'src/components/TreasuryConnected.tsx', 'src/components/TreasuryDemo.tsx', 'src/components/TreasuryDemo.module.css', 'src/hooks/useWallet.ts', 'src/hooks/useConfig.ts', 'src/config.ts', 'src/App.tsx', 'vite.config.ts']
    app_paths += ['src/lib/treasury/owners.ts', 'src/components/TreasuryOwners.tsx', 'src/lib/fees/payment.mjs', 'src/lib/fees/l2-fees.mjs', 'src/lib/treasury/history.ts', 'src/hooks/useTreasuryHistory.ts', 'src/components/TreasuryPaymentHistory.tsx', 'src/components/TreasuryOutcomeDetails.tsx', 'tests/treasury-history.test.mjs', 'tests/integration/treasury-history-browser.mjs']
    app_paths += ['contracts/test/SharedTreasuryBridge.t.sol', 'scripts/treasury-network.mjs', 'src/lib/treasury/deployment.ts', 'src/lib/treasury/deployment-artifacts.json', 'src/lib/treasury/shared-network.json', 'src/components/TreasurySetup.tsx', 'tests/treasury-deployment.test.mjs', 'tests/treasury-owners.test.mjs']
    app_paths += ['src/lib/treasury/safeSetup.ts', 'tests/integration/treasury-setup.mjs', 'tests/treasury-shared-browser.mjs', 'contracts/legacy/src/Artifacts.sol', 'tests/treasury-signatures.test.mjs']
    app_paths += ['src/lib/treasury/official-safe-deployments.json', 'tests/fixtures/official-safe-runtime.json', 'tests/fixtures/treasury-policy-v2.json']
    app_paths += ['contracts/src/shared/TreasuryBootstrap.sol', 'contracts/test/TreasuryBootstrap.t.sol', 'src/lib/treasury/deploymentGroups.ts', 'tests/treasury-deployment-batches.test.mjs', 'tests/integration/treasury-deployment-batches.mjs']
    app_paths += ['src/lib/treasury/setupState.ts', 'src/components/TreasuryRestart.tsx', 'tests/treasury-setup-state.test.mjs']
    app_paths += ['contracts/src/chiado/TestUSDCClaim.sol', 'contracts/test/TestUSDCClaim.t.sol', 'tests/treasury-faucet.test.mjs', 'contracts/src/chiado/SharedTestUSDC.sol', 'contracts/src/chiado/SharedTreasuryBridge.sol', 'src/lib/treasury/sharedInfrastructure.ts', 'tests/treasury-shared-infrastructure.test.mjs']
    app_paths += ['src/lib/treasury/assetInfrastructure.ts', 'src/lib/treasury/networkDeployment.ts', 'src/components/TreasuryFaucet.tsx', 'scripts/treasury-infrastructure.mjs', 'tests/treasury-wallet-funding.test.mjs']
    app_paths += ['contracts/test/BidirectionalTreasuryPolicy.t.sol', 'contracts/legacy/artifacts/TreasuryPolicy.json', 'tests/integration/treasury-bidirectional.mjs', 'tests/integration/treasury-bidirectional-browser.mjs', 'tests/treasury-bidirectional.test.mjs', 'src/lib/treasury/l1Payments.ts']
    app_paths += ['contracts/legacy/artifacts/BidirectionalTreasuryPolicy.json', 'src/lib/treasury/upgrade.ts', 'tests/treasury-upgrade.test.mjs', 'tests/integration/treasury-payments.mjs', 'src/lib/treasury/client.ts', 'src/lib/treasury/payments.ts', 'src/lib/treasury/setupTransactions.ts', 'src/components/TreasuryTransactionHistory.tsx']
    app_paths += ['src/lib/treasury/safeEvents.ts', 'tests/fixtures/safe-130-runtime.json', 'tests/treasury-safe-compatibility.test.mjs']
    app_paths += [
                  'contracts/test/TreasurySplit.t.sol', 'contracts/legacy/artifacts/TreasuryPolicyUpgrade.json',
                  'src/components/TreasuryFundingSplit.tsx']
    app_paths += ['contracts/src/chiado/TestUSDCFaucet.sol', 'contracts/test/TestUSDCFaucet.t.sol', 'tests/integration/treasury-faucet.mjs', 'tests/treasury-faucet-browser.mjs', 'tests/fixtures/treasury-faucet-browser.tsx']
    app_paths += ['contracts/src/l1/StandardBridgeDelegate.sol', 'contracts/src/l2/StandardBridgeTreasuryPolicy.sol', 'contracts/src/interfaces/IStandardBridge.sol',
      'contracts/test/fixtures/RuntimeSnapshot.sol', 'tests/integration/treasury-standard-bridge.mjs',
      'scripts/treasury-mainnet-snapshot.mjs', 'tests/integration/treasury-standard-browser.mjs',
      'tests/integration/treasury-standard-rollback.mjs', 'tests/fixtures/treasury-live-browser.tsx',
      'contracts/test/StandardBridgeTreasuryPolicy.t.sol', 'tests/treasury-standard-bridge.test.mjs',
      'src/components/TreasuryPaymentFlow.tsx', 'src/lib/treasury/settlement.ts', 'src/lib/treasury/mirrorRelay.ts', 'src/components/TreasuryConnected.tsx', 'src/lib/treasury/transfers.ts', 'src/lib/treasury/mainnet.ts']
    app_paths += ['src/lib/treasury/safeInfrastructure.ts', 'tests/treasury-safe-infrastructure.test.mjs', 'src/lib/treasury/mainnet-shared-contracts.json', 'src/lib/treasury/mainnetSetup.ts', 'src/lib/treasury/mainnetSetupRelay.ts', 'src/lib/treasury/mainnet-network.json',
                  'src/lib/treasury/mainnet-artifacts.json',
                  'src/components/TreasuryMainnetSetup.tsx', 'tests/treasury-mainnet-setup.test.mjs',
                  'tests/treasury-mainnet-setup-browser.mjs', 'tests/fixtures/treasury-mainnet-setup.tsx', 'src/components/TreasuryDemo.tsx']
    release = json.loads((ROOT / 'src/lib/treasury/current-build.json').read_text())['build']
    app_paths += ['scripts/build-treasury-release.mjs', 'scripts/check-treasury-release.mjs', 'src/lib/treasury/deploymentIO.ts',
                  'src/lib/treasury/release.ts', 'src/lib/treasury/current-build.json',
                  f'src/lib/treasury/builds/{release}.json', f'verification/builds/{release}/manifest.json']
    manifest = json.loads((ROOT / f'verification/builds/{release}/manifest.json').read_text())
    app_paths += [entry['path'] for entry in manifest['sources']]
    app_paths += ['src/lib/treasury/savedDeployment.ts', 'src/lib/treasury/savedPayments.ts', 'src/lib/treasury/runtimeCode.ts', 'src/lib/treasury/saved-shared-bridges.json', 'tests/fixtures/treasury-saved-setups.json', 'tests/treasury-saved-payments.test.mjs']
    app_paths += ['contracts/test/fixtures/InvoiceMerchant.sol', 'contracts/test/fixtures/InvoiceTreasuryPolicy.sol']
    if args.standard_bridge_snapshot:
        shutil.copy2(args.standard_bridge_snapshot, run / 'mainnet-snapshot.json')
        env['TREASURY_STANDARD_BRIDGE_SNAPSHOT'] = str(run / 'mainnet-snapshot.json')
    app_sources = {name: digest(ROOT / name) for name in app_paths}
    summary = {'mainnetSnapshotSha256': digest(run / 'mainnet-snapshot.json') if args.standard_bridge_snapshot else None, 'mode': args.ui or 'scripted', 'safeVersion': args.safe_version, 'applicationSources': app_sources, 'verified': False, 'runtimeRevision': RUNTIME_REVISION, 'protocolRevision': PROTOCOL_REVISION, 'runtimeSourcesSha256': digest(run / 'runtime-sources.json'), 'steps': []}
    (run / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')

    def command(name, argv, cwd=ROOT, extra_env=None):
        print(f'Running {name}', flush=True)
        with (run / f'{name}.log').open('w') as log:
            if name == 'integration' and args.ui == 'serve':
                # Keep Ctrl-C from killing the fixture before its RAII cleanup.
                # The owned server watches this stop file and exits normally.
                with subprocess.Popen([str(a) for a in argv], cwd=cwd, env=env | (extra_env or {}), stdout=log, stderr=subprocess.STDOUT, start_new_session=True) as process:
                    previous = {sig: signal.signal(sig, lambda *_: (run / 'stop').touch()) for sig in (signal.SIGINT, signal.SIGTERM)}
                    announced = False
                    try:
                        while process.poll() is None:
                            if not announced and (run / 'ui-session.json').exists():
                                session = json.loads((run / 'ui-session.json').read_text())
                                print(f"Treasury devnet ready: {session['url']}\nStop: touch {run / 'stop'}", flush=True)
                                announced = True
                            time.sleep(0.5)
                    finally:
                        for sig, handler in previous.items():
                            signal.signal(sig, handler)
                    result = subprocess.CompletedProcess(argv, process.returncode)
            else:
                result = subprocess.run([str(a) for a in argv], cwd=cwd, env=env | (extra_env or {}), stdout=log, stderr=subprocess.STDOUT)
        summary['steps'].append({'name': name, 'exitCode': result.returncode})
        (run / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        if result.returncode:
            if (run / 'scenario.json').exists():
                failure = json.loads((run / 'scenario.json').read_text()).get('failure')
                if failure:
                    print(failure, flush=True)
            print('\n'.join((run / f'{name}.log').read_text(errors='replace').splitlines()[-15:]), flush=True)
            raise SystemExit(f'{name} failed; full evidence retained at {run}')

    # Browser helpers are dynamically imported after settlement scenarios. Parse
    # every owned JS module before spending time deploying the native devnet.
    for name in app_paths:
        if name.endswith('.mjs'):
            command('syntax-' + name.replace('/', '-'), ['node', '--check', name])

    command('dashboard-contracts', ['npm', 'run', 'build:contracts'])
    # Redirect testkit's artifact lookup into an owned fixture directory, including
    # its genesis input; CARGO_MANIFEST_DIR is that library's supported root override.
    fixture = run / 'fixture'
    (fixture / 'crates/eez-testkit').mkdir(parents=True)
    genesis = fixture / 'crates/eez-node-e2e/tests/fixtures/genesis.json'
    genesis.parent.mkdir(parents=True)
    shutil.copy2(runtime / 'crates/eez-node-e2e/tests/fixtures/genesis.json', genesis)
    # Both scripted and browser scenarios validate the dashboard manifest. Keep
    # their owned genesis off chain ID 1, which the UI deliberately rejects.
    content = json.loads(genesis.read_text())
    content['config']['chainId'] = 420691
    genesis.write_text(json.dumps(content) + '\n')
    summary['fixtureGenesisSha256'] = digest(genesis)
    summary['fixtureL2ChainId'] = 420691
    (fixture / 'scripts').mkdir()
    shutil.copy2(runtime / 'scripts/builder-stub.py', fixture / 'scripts/builder-stub-core.py')
    shutil.copy2(ROOT / 'scripts/treasury-relay.py', fixture / 'scripts/builder-stub.py')
    command('runtime-contracts', ['forge', 'build', '--root', runtime / 'contracts', '--out', state / 'protocol-out', '--cache-path', state / 'forge-cache'])
    shutil.copytree(state / 'protocol-out', fixture / 'contracts/out')
    executable = None
    if args.reuse_run:
        previous = args.reuse_run.resolve()
        prior = json.loads((previous / 'summary.json').read_text())
        assert prior.get('verified') is True, 'artifact source must be a successful recorded run'
        assert prior['runtimeRevision'] == RUNTIME_REVISION and prior['protocolRevision'] == PROTOCOL_REVISION, 'artifact pin mismatch'
        inventory = previous / 'runtime-sources.json'
        assert digest(inventory) == prior['runtimeSourcesSha256'] and json.loads(inventory.read_text()) == original, 'runtime source inventory differs from reused artifacts'
        harness_source = 'tests/integration/treasury_owners.rs'
        binaries = run / 'bin'
        binaries.mkdir()
        summary['binaries'] = {}
        for name in ('eez-composer', 'eez-follower', 'eez-proof-signer'):
            source = previous / 'bin' / name
            assert digest(source) == prior['binaries'][name], f'{name}: artifact hash mismatch'
            shutil.copy2(source, binaries / name)
            summary['binaries'][name] = digest(binaries / name)
        if digest(ROOT / harness_source) == prior['applicationSources'][harness_source]:
            if (previous / 'bin/treasury_owners').exists():
                source = previous / 'bin/treasury_owners'
            else:
                artifacts = [json.loads(line) for line in (previous / 'harness-build.log').read_text().splitlines() if line.startswith('{')]
                source = Path(next(a['executable'] for a in artifacts if a.get('reason') == 'compiler-artifact' and a.get('target', {}).get('name') == 'treasury_owners' and a.get('executable')))
            assert digest(source) == prior['testExecutableSha256'], 'native harness executable hash mismatch'
            shutil.copy2(source, binaries / 'treasury_owners')
            executable = str(binaries / 'treasury_owners')
            summary['testExecutableSha256'] = digest(Path(executable))
        summary['reusedArtifacts'] = {'run': previous.name, 'summarySha256': digest(previous / 'summary.json'), 'harnessReused': executable is not None}
        print('Verified exact runtime source and executable identities; reusing recorded runtime artifacts', flush=True)
    else:
        command('runtime-binaries', ['cargo', '+1.95.0', 'build', '--locked', '-p', 'eez-node-e2e', '-p', 'eez-proof-signer', '--bins'], cwd=runtime)
        binaries = run / 'bin'
        binaries.mkdir()
        summary['binaries'] = {}
        for name in ('eez-composer', 'eez-follower', 'eez-proof-signer'):
            shutil.copy2(target / 'debug' / name, binaries / name)
            summary['binaries'][name] = digest(binaries / name)
    # A dashboard-only harness change must be compiled from its current source,
    # while unchanged, verified runtime artifacts remain reusable.
    if executable is None:
        package = run / 'harness'
        package.mkdir()
        # This tiny harness only launches the existing devnet and the JS scenario.
        manifest = f'''[package]
    name = "treasury-integration"
    version = "0.1.0"
    edition = "2024"
    autotests = false
    [workspace]
    resolver = "2"
    [dependencies]
    eez-testkit = {{ path = {json.dumps(str(runtime / 'crates/eez-testkit'))} }}
    tokio = {{ version = "1", features = ["full"] }}
    serde_json = "1"
    [[test]]
    name = "treasury_owners"
    path = {json.dumps(str(ROOT / 'tests/integration/treasury_owners.rs'))}
    [profile.dev]
    debug = "line-tables-only"
    split-debuginfo = "unpacked"
    opt-level = 1
    [profile.dev.package]
    proptest.opt-level = 3
    rand_chacha.opt-level = 3
    rand_xorshift.opt-level = 3
    unarray.opt-level = 3
    '''
        (package / 'Cargo.toml').write_text(manifest)
        shutil.copy2(runtime / 'Cargo.lock', package / 'Cargo.lock')
        command('harness-lock', ['cargo', '+1.95.0', 'metadata', '--offline', '--format-version', '1', '--manifest-path', package / 'Cargo.toml'], cwd=package)
        def external_packages(path):
            return {(p['name'], p['version'], p['source'], p.get('checksum')) for p in tomllib.loads(path.read_text())['package'] if 'source' in p}
        assert external_packages(package / 'Cargo.lock') <= external_packages(runtime / 'Cargo.lock'), 'harness changed pinned external dependencies'
        command('harness-build', ['cargo', '+1.95.0', 'test', '--locked', '--manifest-path', package / 'Cargo.toml', '--test', 'treasury_owners', '--no-run', '--message-format=json'], cwd=package)
        artifacts = [json.loads(line) for line in (run / 'harness-build.log').read_text().splitlines() if line.startswith('{')]
        executable = next(a['executable'] for a in artifacts if a.get('reason') == 'compiler-artifact' and a.get('target', {}).get('name') == 'treasury_owners' and a.get('executable'))
        summary['testExecutableSha256'] = digest(Path(executable))
    assert source_identity(runtime) == original, 'runtime sources changed during compilation'
    command('integration', [executable, '--exact', 'treasury_owner_quorum_settles_and_replays', '--nocapture', '--test-threads=1'], extra_env={
        'CARGO_MANIFEST_DIR': str(fixture / 'crates/eez-testkit'),
        'EEZ_TEST_RUNTIME_BIN_DIR': str(binaries),
        'EEZ_TEST_PROOF_SIGNER_BIN': str(binaries / 'eez-proof-signer'),
        'EEZ_TEST_LOG_DIR': str(run / 'logs'), 'EEZ_TEST_DATADIR_DIR': str(run / 'datadirs'),
        'EEZ_TEST_SAFE_VERSION': args.safe_version,
        'TREASURY_DASHBOARD_ROOT': str(ROOT), 'TREASURY_EVIDENCE_DIR': str(run), 'TREASURY_UI_MODE': args.ui or '',
    })
    if args.ui != 'serve':
        assert source_identity(runtime) == original, 'runtime sources changed during test'
        assert {name: digest(ROOT / name) for name in app_paths} == app_sources, 'application sources changed during test'
    else:
        scenario = json.loads((run / 'scenario.json').read_text())
        scenario['verified'] = False
        scenario['mode'] = 'manual-devnet'
        (run / 'scenario.json').write_text(json.dumps(scenario, indent=2) + '\n')
    summary['verified'] = args.ui != 'serve' and json.loads((run / 'scenario.json').read_text())['verified'] is True
    (run / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(f"{'Devnet stopped' if args.ui == 'serve' else 'Integration passed'}. Evidence: {run}", flush=True)


if __name__ == '__main__':
    main()
