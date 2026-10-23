// A release is immutable: deployment bytes and verifier inputs come from the
// same compiler invocation. Never regenerate the legacy pending-setup bundles.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { keccak256, toHex } from 'viem';
const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const currentPath = 'src/lib/treasury/current-build.json';
const pin = folder => execFileSync('git', ['-C', `contracts/lib/${folder}`, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const pins = { core: pin('eez-core-protocol'), safe: pin('safe'), modules: pin('safe-modules') };
const groups = [
  { root: 'contracts/legacy', names: ['Safe', 'SafeL2', 'SafeProxyFactory', 'SafeProxy', 'AllowanceModule', 'MultiSendCallOnly'] },
  { root: 'contracts', names: ['L1Owners', 'TreasuryOwnerAction', 'TreasuryAliasReader', 'TreasuryPolicy',
    'TreasuryBootstrap', 'SharedTestUSDC', 'SharedTreasuryBridge', 'TestUSDCClaim', 'TestUSDCFaucet', 'WrappedToken',
    'StandardBridgeTreasuryPolicy', 'StandardBridgeDelegate', 'TestUSDC'] },
];
if (process.argv.includes('--check')) {
  const { build } = read(currentPath), manifest = read(`verification/builds/${build}/manifest.json`);
  if (JSON.stringify(pins) !== JSON.stringify(manifest.pins)) throw new Error('Treasury release protocol pins changed');
  for (const { path, hash } of manifest.sources) if (sha(readFileSync(path)) !== hash) throw new Error(`Rebuild treasury release: ${path} changed`);
  const bundle = read(`src/lib/treasury/builds/${build}.json`);
  if (sha(JSON.stringify(manifest.identity)) !== build || sha(JSON.stringify(bundle)) !== manifest.bundleSha256)
    throw new Error('Treasury release identity differs');
  for (const [name, a] of Object.entries(bundle.contracts)) {
    const v = manifest.contracts[name];
    if (!v || a.bytecode !== v.bytecode || a.runtime !== v.runtime || a.verification !== v.input)
      throw new Error(`Missing exact verification input for ${name}`);
  }
  for (const [hash, input] of Object.entries(manifest.inputs)) if (sha(JSON.stringify(input)) !== hash) throw new Error('Verification input hash changed');
  console.log(`Treasury release ${build}: sources, pins and ${Object.keys(bundle.contracts).length} artifacts checked`);
  process.exit(0);
}
const inputs = {}, contracts = {}, sourceFiles = new Map();
for (const group of groups) {
  const sources = {}, targets = {}; let settings, compiler;
  const normalize = path => path.startsWith('/') ? relative(resolve(group.root), path) : path;
  for (const name of group.names) {
    const a = read(`${group.root}/out/${name}.sol/${name}.json`), m = a.metadata;
    const [source] = Object.keys(m.settings.compilationTarget);
    targets[name] = normalize(source);
    compiler ??= m.compiler.version;
    if (compiler !== m.compiler.version) throw new Error('Mixed compiler versions');
    const s = { ...m.settings }; delete s.compilationTarget;
    if (settings && JSON.stringify(settings) !== JSON.stringify(s)) throw new Error('Mixed compiler settings');
    settings = s;
    for (const [path, description] of Object.entries(m.sources)) {
      const absolute = resolve(group.root, path), content = readFileSync(absolute, 'utf8');
      if (keccak256(toHex(content)) !== description.keccak256) throw new Error(`Stale Foundry output: ${path}`);
      const key = normalize(path);
      if (sources[key] && sources[key].content !== content) throw new Error('Conflicting source paths');
      sources[key] = { content }; sourceFiles.set(relative(process.cwd(), absolute), sha(content));
    }
  }
  const input = { language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).sort()), settings: { ...settings,
    outputSelection: { '*': { '*': ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode'] } } } };

  const version = compiler.split('+')[0];
  const candidates = [resolve(homedir(), '.local/share/svm', version, `solc-${version}`), resolve(homedir(), '.svm', version, `solc-${version}`)];
  const solc = candidates.find(existsSync); if (!solc) throw new Error(`Install solc ${version} using forge build before packaging`);
  if (!execFileSync(solc, ['--version'], { encoding: 'utf8' }).includes(compiler)) throw new Error('Wrong compiler binary');
  const output = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  for (const [name, source] of Object.entries(targets)) {
    const a = output.contracts[source][name], metadata = JSON.parse(a.metadata);
    const verificationSettings = { ...metadata.settings }; delete verificationSettings.compilationTarget;
    const targetInput = { language: 'Solidity', sources: Object.fromEntries(Object.keys(metadata.sources).map(path => [path, input.sources[path]])),
      settings: { ...verificationSettings, outputSelection: { '*': { '*': ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode'] } } } };
    const hash = sha(JSON.stringify(targetInput)); inputs[hash] = targetInput;
    // Keep verification requests small, but prove pruning unrelated source units
    // did not change a single deployment byte (including factory child metadata).
    const reproduced = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(targetInput), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const exact = reproduced.contracts?.[source]?.[name];
    if (!exact || exact.evm.bytecode.object !== a.evm.bytecode.object || exact.evm.deployedBytecode.object !== a.evm.deployedBytecode.object)
      throw new Error(`Verification input does not reproduce ${name}`);
    if (!/^[a-f\d]+$/i.test(a.evm.bytecode.object)) throw new Error(`Unlinked bytecode: ${name}`);
    const immutableGroups = Object.values(a.evm.deployedBytecode.immutableReferences ?? {});
    contracts[name] = { abi: a.abi, bytecode: `0x${a.evm.bytecode.object}`, runtime: `0x${a.evm.deployedBytecode.object}`,
      immutables: immutableGroups.flat(), immutableGroups, verification: hash };
  }
  for (const [name, source] of Object.entries(targets)) contracts[name].compiler = compiler, contracts[name].target = `${source}:${name}`;
}
// Factories retained on the network keep their original compiler identity.
// These reviewed inputs cover their children without rewriting factory contracts.
const dependencies = {};
for (const filename of readdirSync('verification/dependencies').filter(n => n.endsWith('.json')).sort()) {
  const path = `verification/dependencies/${filename}`, raw = readFileSync(path, 'utf8'), d = JSON.parse(raw);
  sourceFiles.set(path, sha(raw));
  const version = d.compiler.split('+')[0], solc = [resolve(homedir(), '.local/share/svm', version, `solc-${version}`), resolve(homedir(), '.svm', version, `solc-${version}`)].find(existsSync);
  if (!solc) throw new Error(`Missing solc ${version}`);
  const output = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(d.input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const [source, name] = d.target.split(':'), a = output.contracts?.[source]?.[name];
  if (!a || `0x${a.evm.deployedBytecode.object}` !== d.runtime) throw new Error(`Dependency source does not reproduce ${filename}`);
  const input = sha(JSON.stringify(d.input)); inputs[input] = d.input;
  const immutableGroups = Object.values(a.evm.deployedBytecode.immutableReferences ?? {});
  dependencies[filename] = { input, target: d.target, compiler: d.compiler, runtime: d.runtime, immutables: immutableGroups.flat(), immutableGroups };
}
// The proxy uses the same portable source key as its factory's embedded literal.
// This catches the old standalone-artifact vs embedded-metadata discrepancy.
const factory = contracts.SafeProxyFactory, proxy = contracts.SafeProxy;
if (!factory.runtime.includes(proxy.bytecode.slice(2))) throw new Error('Factory embeds different Safe proxy bytes');
factory.proxyCreationCode = proxy.bytecode;
const identity = { pins, dependencies: sha(JSON.stringify(dependencies)), artifacts: sha(JSON.stringify(contracts)), inputs: Object.keys(inputs), targets: Object.fromEntries(Object.entries(contracts).map(([n,a]) => [n, a.target])) };
const build = sha(JSON.stringify(identity));
const bundle = { version: 1, ...pins, build, contracts: Object.fromEntries(Object.entries(contracts).map(([n,a]) => {
  const { compiler, target, ...artifact } = a; return [n, artifact];
})) };
const manifest = { version: 1, build, identity, pins, inputs, dependencies, contracts: Object.fromEntries(Object.entries(contracts).map(([n,a]) => [n,
  { ...a, input: a.verification }])), sources: [...sourceFiles].sort().map(([path,hash]) => ({path,hash})), bundleSha256: sha(JSON.stringify(bundle)) };
for (const [path, data] of [[`src/lib/treasury/builds/${build}.json`, bundle], [`verification/builds/${build}/manifest.json`, manifest]]) {
  const text = JSON.stringify(data) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') !== text) throw new Error(`Refusing to rewrite immutable build ${build}`);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
}
writeFileSync(currentPath, JSON.stringify({ build }) + '\n');
console.log(`Packaged ${Object.keys(contracts).length} contracts with exact sources: ${build}`);
