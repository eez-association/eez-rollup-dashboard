// Keep wallet initcode and source-verification inputs tied to the same compiler output.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

execFileSync('forge', ['build', '--root', 'contracts/falcon'], { stdio: 'inherit' });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contracts = {};
for (const name of ['FalconVerifier', 'FalconL1ControllerFactory', 'OwnedSafeFactory']) {
  const compiled = JSON.parse(fs.readFileSync(`contracts/falcon/out/${name}.sol/${name}.json`));
  const { compilationTarget, ...settings } = compiled.metadata.settings;
  const sources = Object.fromEntries(Object.keys(compiled.metadata.sources).sort().map(path => [path,
    { content: fs.readFileSync(`contracts/falcon/${path}`, 'utf8') }]));
  const input = { language: 'Solidity', sources, settings };
  const declarations = compiled.ast.nodes.flatMap(node => node.nodes ?? []);
  const immutables = Object.fromEntries(Object.entries(compiled.deployedBytecode.immutableReferences ?? {}).map(([id, ranges]) => {
    const declaration = declarations.find(node => node.id === Number(id));
    if (declaration?.mutability !== 'immutable') throw new Error(`Unknown immutable ${id}`);
    return [declaration.name, ranges];
  }));
  contracts[name] = { compiler: compiled.metadata.compiler.version, inputHash: hash(input),
    bytecode: compiled.bytecode.object, runtime: compiled.deployedBytecode.object, immutables };
}
const output = JSON.stringify({ version: 1, contracts }, null, 2) + '\n';
const destination = 'src/lib/falcon/setup-artifacts.json';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== output) throw new Error('Rebuild Falcon wallet deployment artifacts');
} else fs.writeFileSync(destination, output);
console.log('Falcon wallet deployment artifacts match their pinned sources');
