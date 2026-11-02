// Build the small standalone demo artifact without changing Treasury releases.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const file = 'src/lib/bridge-test-token-artifact.json';
execFileSync('forge', ['build', '--root', 'contracts', 'src/testnet/BridgeTestToken.sol'], {stdio:'inherit'});
const compiled = JSON.parse(fs.readFileSync('contracts/out/BridgeTestToken.sol/BridgeTestToken.json'));
const sources = Object.fromEntries(Object.keys(compiled.metadata.sources).sort().map(path => [path,
  createHash('sha256').update(fs.readFileSync(`contracts/${path}`)).digest('hex')]));
const artifact = {compiler:compiled.metadata.compiler.version,sources,abi:compiled.abi,
  bytecode:compiled.bytecode.object,runtime:compiled.deployedBytecode.object};
const text = JSON.stringify(artifact,null,2)+'\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file,'utf8') !== text) throw new Error('Rebuild the BridgeTestToken artifact');
} else fs.writeFileSync(file,text);
console.log('BridgeTestToken artifact matches its Solidity source');
