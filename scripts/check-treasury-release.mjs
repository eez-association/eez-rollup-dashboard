import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const read = p => JSON.parse(readFileSync(p));
const current = read('src/lib/treasury/current-build.json').build;
const shared = read('src/lib/treasury/shared-build.json').build;
const sharedBundle = read(`src/lib/treasury/builds/${shared}.json`);
assert.equal(sharedBundle.build, shared);
assert.equal(sharedBundle.contracts.TreasuryPolicy.abi.find(item => item.type === 'constructor').inputs.length, 8,
  'Chiado setup requires its compatible retained policy release');
assert(sharedBundle.contracts.SharedTreasuryBridge && sharedBundle.contracts.SharedTestUSDC);
let count = 0;
for (const build of readdirSync('verification/builds').filter(n => /^[a-f\d]{64}$/.test(n))) {
  const m = read(`verification/builds/${build}/manifest.json`), b = read(`src/lib/treasury/builds/${build}.json`);
  assert.equal(sha(m.identity), build); assert.equal(m.build, build); assert.equal(b.build, build);
  assert.equal(sha(b), m.bundleSha256);
  const artifacts = Object.fromEntries(Object.entries(m.contracts).map(([n, {input, ...a}]) => [n,a]));
  assert.equal(sha(artifacts), m.identity.artifacts, 'Compiler output identity changed');
  if (m.dependencies) assert.equal(sha(m.dependencies), m.identity.dependencies);
  for (const [id, input] of Object.entries(m.inputs)) assert.equal(sha(input), id);
  for (const [name, artifact] of Object.entries(b.contracts)) {
    const v = m.contracts[name]; assert(v && m.inputs[v.input]);
    assert.equal(artifact.bytecode, v.bytecode); assert.equal(artifact.runtime, v.runtime);
    assert.deepEqual(artifact.immutableGroups, v.immutableGroups);
    assert.equal(artifact.verification, v.input);
    assert(/^[\w./-]+:\w+$/.test(v.target) && /^0\.\d+\.\d+\+commit\.[\da-f]{8}$/.test(v.compiler));
  }
  if (build === current) count++;
}
assert.equal(count, 1, 'Current source build is missing');
console.log('Immutable treasury deployment and verification bundles agree');
