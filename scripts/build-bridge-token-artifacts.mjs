// Reproduce the supported bridge factories before packaging their CREATE2 children.
// Run with solc 0.8.34; no transactions are sent.
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { keccak256 } from 'viem';
const explorer = 'https://eez.dev/explorer/api/v2/smart-contracts/0xe993715bE7a0F60d484C5D19c4f008Ba79df1D4E';
const expectedHash = '0xb7d5c139683ac64486723ba6eb674b4dc6cf39ee4ea9f0cdd3a304d11e740e24';
async function compileVerified(explorer, contractPath, name, expectedHash, immutable = false) {
  const response = await fetch(explorer);
  if (!response.ok) throw new Error(`Explorer unavailable: ${response.status}`);
  const verified = await response.json();
  if (!verified.is_verified || verified.is_partially_verified || keccak256(verified.deployed_bytecode) !== expectedHash) throw new Error('Explorer runtime does not match the pinned deployment');
  const sources = Object.fromEntries([{file_path:verified.file_path,source_code:verified.source_code},...verified.additional_sources]
    .map(s => [s.file_path,{content:s.source_code}]));
  const settings = {...verified.compiler_settings,outputSelection:{'*':{'*':['evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}};
  const solc = process.env.BRIDGE_SOLC || `${os.homedir()}/.local/share/svm/0.8.34/solc-0.8.34`;
  const output = JSON.parse(execFileSync(solc,['--standard-json'],{input:JSON.stringify({language:'Solidity',sources,settings}),maxBuffer:32*1024*1024}));
  const contract = output.contracts?.[contractPath]?.[name];
  if (!contract) throw new Error(`Verified contract did not compile: ${JSON.stringify(output.errors)}`);
  let runtime = contract.evm.deployedBytecode.object;
  // Transparent proxies embed their constructor-selected admin. Only compiler-
  // declared immutable positions may differ from the reproduced runtime.
  if (immutable) for (const {start,length} of Object.values(contract.evm.deployedBytecode.immutableReferences).flat()) {
    runtime = runtime.slice(0,start*2) + verified.deployed_bytecode.slice(2+start*2,2+(start+length)*2) + runtime.slice((start+length)*2);
  }
  if (keccak256('0x'+runtime) !== expectedHash) throw new Error('Verified contract does not reproduce the pinned deployed runtime');
  return { output, runtime: '0x'+runtime };
}
const { output } = await compileVerified(explorer,'src/periphery/EEZBridge.sol','EEZBridge',expectedHash);
const entries = [{kind:'eez',runtimeHash:expectedHash,creationCode:'0x'+output.contracts['src/periphery/EEZBridgedToken.sol'].EEZBridgedToken.evm.bytecode.object,source:explorer}];
for (const file of fs.readdirSync('src/lib/treasury/builds')) {
  const {contracts}=JSON.parse(fs.readFileSync(`src/lib/treasury/builds/${file}`));
  if (!contracts.Bridge || !contracts.WrappedToken) continue;
  const runtimeHash=keccak256(contracts.Bridge.runtime);
  if (!entries.some(e=>e.runtimeHash===runtimeHash)) entries.push({kind:'standard',runtimeHash,creationCode:contracts.WrappedToken.bytecode,source:`treasury/builds/${file}`});
}
const network = JSON.parse(fs.readFileSync('src/lib/treasury/rollupx-mainnet-network.json'));
const implementationUrl = `https://rollupx.eez.dev/explorer/api/v2/smart-contracts/${network.bridgeImplementations.l2.address}`;
const implementation = await compileVerified(implementationUrl,'src/periphery/Bridge.sol','Bridge',network.bridgeImplementations.l2.hash);
const proxyUrl = `https://rollupx.eez.dev/explorer/api/v2/smart-contracts/${network.contracts.bridgeL2.address}`;
const proxy = await compileVerified(proxyUrl,'lib/openzeppelin-contracts/contracts/proxy/transparent/TransparentUpgradeableProxy.sol','TransparentUpgradeableProxy',network.contracts.bridgeL2.hash,true);
entries.push({kind:'standard',runtimeHash:network.bridgeImplementations.l2.hash,proxyRuntimeHashes:[network.contracts.bridgeL2.hash],
  creationCode:'0x'+implementation.output.contracts['src/periphery/WrappedToken.sol'].WrappedToken.evm.bytecode.object,source:implementationUrl});
fs.writeFileSync('src/lib/bridge-token-artifacts.json',JSON.stringify(entries,null,2)+'\n');
fs.writeFileSync('tests/fixtures/bridge-token-factories.json',JSON.stringify({proxy:proxy.runtime,implementation:implementation.runtime},null,2)+'\n');
console.log(`Packaged ${entries.length} verified bridge token factories`);
