import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createKeyPair, fromHex, publicSample, PUBLIC_KEY_BYTES, SIGNATURE_BYTES,
  signMessage, toHex, verifySignature,
} from '../../src/lib/falcon/falcon.ts';

const message = Uint8Array.from({ length: 32 }, (_, i) => i);
const keys = createKeyPair();
const signature = signMessage(message, keys.secretKey);

test('signs exact message bytes and verifies a padded Falcon-512 signature', () => {
  assert.equal(keys.publicKey.length, PUBLIC_KEY_BYTES);
  assert.equal(signature.length, SIGNATURE_BYTES);
  assert.equal(verifySignature(message, signature, keys.publicKey), true);
  assert.deepEqual(fromHex(toHex(message), 32), message);
});

test('rejects an altered message and a signature from a different key', () => {
  const altered = message.slice();
  altered[0] ^= 1;
  assert.equal(verifySignature(altered, signature, keys.publicKey), false);
  const other = createKeyPair();
  assert.equal(verifySignature(message, signature, other.publicKey), false);
  other.secretKey.fill(0);
});

test('rejects an altered signature salt and malformed signature encodings', () => {
  const altered = signature.slice();
  altered[1] ^= 1;
  assert.equal(verifySignature(message, altered, keys.publicKey), false);
  assert.equal(verifySignature(message, signature.slice(1), keys.publicKey), false);
  assert.equal(verifySignature(message, new Uint8Array(SIGNATURE_BYTES), keys.publicKey), false);
});

test('rejects malformed hex and requires exactly 32 message bytes', () => {
  for (const input of ['', '0x', '0', 'zz', '00 11', '001q']) {
    assert.throws(() => fromHex(input));
  }
  assert.throws(() => fromHex('00', 32));
  assert.throws(() => signMessage(new Uint8Array(31), keys.secretKey));
  assert.deepEqual(fromHex(' 0xABcd '), Uint8Array.of(0xab, 0xcd));
});

test('exports public material and records whether the current message is valid', () => {
  const sample = publicSample(message, signature, keys.publicKey);
  assert.deepEqual(Object.keys(sample).sort(), [
    'schema', 'scheme', 'signatureEncoding', 'messageHex', 'publicKeyHex', 'signatureHex', 'expectedValid',
  ].sort());
  assert.equal(sample.expectedValid, true);
  assert.equal(JSON.stringify(sample).includes(toHex(keys.secretKey)), false);
  const altered = message.slice();
  altered[31] ^= 1;
  assert.equal(publicSample(altered, signature, keys.publicKey).expectedValid, false);
});
