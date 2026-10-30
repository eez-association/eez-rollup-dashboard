// Reproduce the deployed EEZBridge factory before packaging its CREATE2 child.
// Run with solc 0.8.34; no transactions are sent.
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { keccak256 } from 'viem';
const explorer = 'https://eez.dev/explorer/api/v2/smart-contracts/0xe993715bE7a0F60d484C5D19c4f008Ba79df1D4E';
const expectedHash = '0xb7d5c139683ac64486723ba6eb674b4dc6cf39ee4ea9f0cdd3a304d11e740e24';
const verified = await (await fetch(explorer)).json();
const sources = Object.fromEntries([{file_path:verified.file_path,source_code:verified.source_code},...verified.additional_sources]
  .map(s => [s.file_path,{content:s.source_code}]));
const settings = {...verified.compiler_settings,outputSelection:{'*':{'*':['evm.bytecode.object','evm.deployedBytecode.object']}}};
const solc = process.env.BRIDGE_SOLC || `${os.homedir()}/.local/share/svm/0.8.34/solc-0.8.34`;
const output = JSON.parse(execFileSync(solc,['--standard-json'],{input:JSON.stringify({language:'Solidity',sources,settings}),maxBuffer:32*1024*1024}));
const bridge = output.contracts?.['src/periphery/EEZBridge.sol']?.EEZBridge;
if (!bridge || keccak256('0x'+bridge.evm.deployedBytecode.object) !== expectedHash) throw new Error('Verified bridge does not reproduce the pinned deployed runtime');
const entries = [{kind:'eez',runtimeHash:expectedHash,creationCode:'0x'+output.contracts['src/periphery/EEZBridgedToken.sol'].EEZBridgedToken.evm.bytecode.object,source:explorer}];
for (const file of fs.readdirSync('src/lib/treasury/builds')) {
  const {contracts}=JSON.parse(fs.readFileSync(`src/lib/treasury/builds/${file}`));
  if (!contracts.Bridge || !contracts.WrappedToken) continue;
  const runtimeHash=keccak256(contracts.Bridge.runtime);
  if (!entries.some(e=>e.runtimeHash===runtimeHash)) entries.push({kind:'standard',runtimeHash,creationCode:contracts.WrappedToken.bytecode,source:`treasury/builds/${file}`});
}
fs.writeFileSync('src/lib/bridge-token-artifacts.json',JSON.stringify(entries,null,2)+'\n');
console.log(`Packaged ${entries.length} verified bridge token factories`);
