import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { after, test } from 'node:test';
import { createKeyPair, signMessage, toHex, verifySignature } from '../../src/lib/falcon/falcon.ts';
import {
  decryptKeystore, encryptKeystore, MAX_KEYSTORE_BYTES, parseKeystore, PBKDF2_ITERATIONS,
  type Keystore,
} from '../../src/lib/falcon/keystore.ts';

const password = 'devcon test password — only a fixture';
const keys = createKeyPair();
const stored = await encryptKeystore(keys, password);
const serialized = JSON.stringify(stored);
after(() => keys.secretKey.fill(0));

// Independent Node cipher API checks the documented v1 wire format, not a second call to our wrapper.
function aad(item: Keystore): Buffer {
  return Buffer.from(JSON.stringify([
    item.schema, item.version, item.scheme, item.publicKeyHex,
    item.kdf.name, item.kdf.hash, item.kdf.iterations, item.kdf.saltHex,
    item.cipher.name, item.cipher.bits, item.cipher.ivHex, item.cipher.tagBits,
  ]), 'utf8');
}

function referenceKey(item: Keystore): Buffer {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(item.kdf.saltHex, 'hex'), 600_000, 32, 'sha256');
}

test('backup restores the same identity and can sign after restoring', async () => {
  const restored = await decryptKeystore(serialized, password);
  try {
    assert.deepEqual(restored.publicKey, keys.publicKey);
    assert.deepEqual(restored.secretKey, keys.secretKey);
    const message = new Uint8Array(32).fill(19);
    assert.equal(verifySignature(message, signMessage(message, restored.secretKey), keys.publicKey), true);
  } finally { restored.secretKey.fill(0); }
});

test('export is independently decryptable using Node PBKDF2 and AES-GCM', () => {
  const key = referenceKey(stored);
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.cipher.ivHex, 'hex'));
  cipher.setAAD(aad(stored));
  const combined = Buffer.from(stored.ciphertextHex, 'hex');
  cipher.setAuthTag(combined.subarray(-16));
  const plaintext = Buffer.concat([cipher.update(combined.subarray(0, -16)), cipher.final()]);
  try { assert.equal(plaintext.toString('hex'), toHex(keys.secretKey)); }
  finally { key.fill(0); plaintext.fill(0); }
});

test('wrong password and modified ciphertext, public key, salt or IV cannot unlock', async () => {
  await assert.rejects(decryptKeystore(serialized, 'different test password'), /Could not unlock/);
  const variants = [
    { ...stored, ciphertextHex: flip(stored.ciphertextHex) },
    { ...stored, publicKeyHex: flip(stored.publicKeyHex) },
    { ...stored, kdf: { ...stored.kdf, saltHex: flip(stored.kdf.saltHex) } },
    { ...stored, cipher: { ...stored.cipher, ivHex: flip(stored.cipher.ivHex) } },
  ];
  for (const item of variants) await assert.rejects(decryptKeystore(JSON.stringify(item), password), /Could not unlock/);
});

function flip(hex: string): string {
  return (parseInt(hex.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + hex.slice(2);
}

test('even authenticated ciphertext must contain a matching private key', async () => {
  const other = createKeyPair();
  const key = referenceKey(stored);
  const item = { ...stored, publicKeyHex: toHex(other.publicKey) };
  try {
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(item.cipher.ivHex, 'hex'));
    cipher.setAAD(aad(item));
    item.ciphertextHex = Buffer.concat([cipher.update(keys.secretKey), cipher.final(), cipher.getAuthTag()]).toString('hex');
    await assert.rejects(decryptKeystore(JSON.stringify(item), password), /Could not unlock/);
  } finally { key.fill(0); other.secretKey.fill(0); }
});

test('exports use fresh salt, IV and ciphertext without plaintext private fields', async () => {
  const again = await encryptKeystore(keys, password);
  assert.notEqual(again.kdf.saltHex, stored.kdf.saltHex);
  assert.notEqual(again.cipher.ivHex, stored.cipher.ivHex);
  assert.notEqual(again.ciphertextHex, stored.ciphertextHex);
  assert.deepEqual(Object.keys(stored).sort(), ['schema', 'version', 'scheme', 'publicKeyHex', 'kdf', 'cipher', 'ciphertextHex'].sort());
  assert.equal(serialized.includes(toHex(keys.secretKey)), false);
  assert.equal(serialized.includes(password), false);
});

test('encryption snapshots the key before awaiting the password derivation', async () => {
  const temporary = { publicKey: keys.publicKey.slice(), secretKey: keys.secretKey.slice() };
  const pending = encryptKeystore(temporary, password);
  temporary.secretKey.fill(0);
  const recovered = await decryptKeystore(JSON.stringify(await pending), password);
  try { assert.deepEqual(recovered.secretKey, keys.secretKey); }
  finally { recovered.secretKey.fill(0); }
});

test('rejects malformed, oversized, unknown-version and unsupported protection profiles', () => {
  for (const value of ['', 'null', '[]', '{', ' '.repeat(MAX_KEYSTORE_BYTES + 1), 'é'.repeat(MAX_KEYSTORE_BYTES)]) {
    assert.throws(() => parseKeystore(value));
  }
  const variants = [
    { ...stored, version: 2 },
    { ...stored, scheme: 'different-scheme' },
    { ...stored, secretKey: 'unexpected private field' },
    { ...stored, kdf: { ...stored.kdf, iterations: 1 } },
    { ...stored, kdf: { ...stored.kdf, iterations: PBKDF2_ITERATIONS + 1 } },
    { ...stored, kdf: { ...stored.kdf, iterations: 2 ** 50 } },
    { ...stored, kdf: { ...stored.kdf, hash: 'SHA-1' } },
    { ...stored, cipher: { ...stored.cipher, tagBits: 32 } },
    { ...stored, cipher: { ...stored.cipher, ivHex: '00' } },
    { ...stored, publicKeyHex: stored.publicKeyHex.toUpperCase() },
    { ...stored, ciphertextHex: stored.ciphertextHex.slice(2) },
  ];
  for (const value of variants) assert.throws(() => parseKeystore(JSON.stringify(value)));
  assert.deepEqual(parseKeystore(JSON.stringify(stored, null, 2)), stored);
});

test('rejects short or oversized passwords and mismatched input key pairs', async () => {
  for (const invalid of ['', 'short', 'a'.repeat(1025), '🔐'.repeat(300)]) {
    await assert.rejects(encryptKeystore(keys, invalid), /password/i);
  }
  const other = createKeyPair();
  try {
    await assert.rejects(encryptKeystore({ ...keys, publicKey: other.publicKey }, password), /does not match/);
  } finally { other.secretKey.fill(0); }
});

test('password whitespace is significant and is not silently trimmed', async () => {
  const spaced = await encryptKeystore(keys, ` ${password} `);
  await assert.rejects(decryptKeystore(JSON.stringify(spaced), password), /Could not unlock/);
  const restored = await decryptKeystore(JSON.stringify(spaced), ` ${password} `);
  restored.secretKey.fill(0);
});
