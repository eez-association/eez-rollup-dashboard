import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { falcon512padded } from '@noble/post-quantum/falcon.js';
import { fromHex, verifySignature } from '../../src/lib/falcon/falcon.ts';

test('the browser library accepts all ten independent public KATs used by Solidity', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/nist-kat.json', import.meta.url), 'utf8'));
  assert.equal(vectors.length, 10);
  for (const vector of vectors) {
    const message = fromHex(vector.message);
    const signature = fromHex(vector.signature, 666);
    const publicKey = fromHex(vector.publicKey, 897);
    assert.equal(falcon512padded.verify(signature, message, publicKey), true, `KAT ${vector.count}`);
    message[0] ^= 1;
    assert.equal(falcon512padded.verify(signature, message, publicKey), false, `modified KAT ${vector.count}`);
  }
});

test('the frozen browser fixture remains valid for both browser and contract regressions', () => {
  const vector = JSON.parse(readFileSync(new URL('./fixtures/browser.json', import.meta.url), 'utf8'));
  const message = fromHex(vector.message, 32);
  const signature = fromHex(vector.signature, 666);
  const publicKey = fromHex(vector.publicKey, 897);
  assert.equal(verifySignature(message, signature, publicKey), true);
  message[0] ^= 1;
  assert.equal(verifySignature(message, signature, publicKey), false);
});
