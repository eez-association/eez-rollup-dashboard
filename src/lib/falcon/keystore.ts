import {
  derivePublicKey, fromHex, PUBLIC_KEY_BYTES, SCHEME, SECRET_KEY_BYTES, toHex, type KeyPair,
} from './falcon.ts';

export const KEYSTORE_SCHEMA = 'falcom-devcon-poc/keystore';
export const MAX_KEYSTORE_BYTES = 16 * 1024;
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_CHARACTERS = 12;
const MAX_PASSWORD_BYTES = 1024;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BITS = 128;
const encoder = new TextEncoder();

export type Keystore = {
  schema: typeof KEYSTORE_SCHEMA;
  version: 1;
  scheme: typeof SCHEME;
  publicKeyHex: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; saltHex: string };
  cipher: { name: 'AES-GCM'; bits: 256; ivHex: string; tagBits: 128 };
  ciphertextHex: string;
};

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new Error('Key backups require HTTPS or localhost.');
  return globalThis.crypto.subtle;
}

function passwordBytes(password: string): Uint8Array {
  if (password.length > MAX_PASSWORD_BYTES) throw new Error('Password is too long.');
  if (Array.from(password).length < MIN_PASSWORD_CHARACTERS) {
    throw new Error(`Use a password with at least ${MIN_PASSWORD_CHARACTERS} characters.`);
  }
  // Password bytes are exact UTF-8: no trimming or Unicode normalization.
  const bytes = encoder.encode(password);
  if (bytes.length > MAX_PASSWORD_BYTES) {
    bytes.fill(0);
    throw new Error('Password is too long.');
  }
  return bytes;
}

async function deriveEncryptionKey(password: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', new Uint8Array(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: new Uint8Array(salt) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid encrypted key file.');
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(field => Object.prototype.hasOwnProperty.call(value, field))) {
    throw new Error('Unexpected fields in encrypted key file.');
  }
  return value as Record<string, unknown>;
}

function hex(value: unknown, length: number): string {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error('Invalid encoding in encrypted key file.');
  }
  return value;
}

/** Rejects oversized, unsupported and noncanonical input before performing any expensive KDF. */
export function parseKeystore(text: string): Keystore {
  if (text.length > MAX_KEYSTORE_BYTES || encoder.encode(text).length > MAX_KEYSTORE_BYTES) {
    throw new Error('Encrypted key file exceeds the 16 KiB limit.');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Choose a valid encrypted key JSON file.'); }
  const item = record(value, ['schema', 'version', 'scheme', 'publicKeyHex', 'kdf', 'cipher', 'ciphertextHex']);
  const kdf = record(item.kdf, ['name', 'hash', 'iterations', 'saltHex']);
  const cipher = record(item.cipher, ['name', 'bits', 'ivHex', 'tagBits']);
  if (item.schema !== KEYSTORE_SCHEMA || item.version !== 1 || item.scheme !== SCHEME) {
    throw new Error('Unsupported encrypted key format or signature scheme.');
  }
  // v1 has one fixed cost profile. Imported files cannot select unbounded or weaker KDF work.
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || kdf.iterations !== PBKDF2_ITERATIONS ||
      cipher.name !== 'AES-GCM' || cipher.bits !== 256 || cipher.tagBits !== TAG_BITS) {
    throw new Error('Unsupported encrypted key protection settings.');
  }
  return {
    schema: KEYSTORE_SCHEMA, version: 1, scheme: SCHEME,
    publicKeyHex: hex(item.publicKeyHex, PUBLIC_KEY_BYTES),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, saltHex: hex(kdf.saltHex, SALT_BYTES) },
    cipher: { name: 'AES-GCM', bits: 256, ivHex: hex(cipher.ivHex, IV_BYTES), tagBits: TAG_BITS },
    ciphertextHex: hex(item.ciphertextHex, SECRET_KEY_BYTES + TAG_BITS / 8),
  };
}

/** Stable v1 authenticated metadata; order is part of the file format. */
function authenticatedData(item: Omit<Keystore, 'ciphertextHex'>): Uint8Array {
  return encoder.encode(JSON.stringify([
    item.schema, item.version, item.scheme, item.publicKeyHex,
    item.kdf.name, item.kdf.hash, item.kdf.iterations, item.kdf.saltHex,
    item.cipher.name, item.cipher.bits, item.cipher.ivHex, item.cipher.tagBits,
  ]));
}

/** Produces an encrypted backup with fresh salt and IV; never serializes a plaintext private key. */
export async function encryptKeystore(keys: KeyPair, password: string): Promise<Keystore> {
  subtle();
  const pass = passwordBytes(password);
  // Own a snapshot so locking the active key during PBKDF2 cannot encrypt a cleared key.
  const secret = new Uint8Array(keys.secretKey);
  try {
    const publicKeyHex = toHex(derivePublicKey(secret));
    if (publicKeyHex !== toHex(keys.publicKey)) throw new Error('Falcon key pair does not match.');
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const header: Omit<Keystore, 'ciphertextHex'> = {
      schema: KEYSTORE_SCHEMA, version: 1, scheme: SCHEME, publicKeyHex,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, saltHex: toHex(salt) },
      cipher: { name: 'AES-GCM', bits: 256, ivHex: toHex(iv), tagBits: TAG_BITS },
    };
    const key = await deriveEncryptionKey(pass, salt);
    const encrypted = await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: new Uint8Array(authenticatedData(header)), tagLength: TAG_BITS },
      key, secret,
    );
    return { ...header, ciphertextHex: toHex(new Uint8Array(encrypted)) };
  } finally {
    pass.fill(0);
    secret.fill(0);
  }
}

/** Authenticates the entire backup and checks key correspondence before returning an unlocked key. */
export async function decryptKeystore(text: string, password: string): Promise<KeyPair> {
  subtle();
  const item = parseKeystore(text);
  const pass = passwordBytes(password);
  let secret: Uint8Array | undefined;
  try {
    const key = await deriveEncryptionKey(pass, fromHex(item.kdf.saltHex));
    const decrypted = await subtle().decrypt(
      {
        name: 'AES-GCM', iv: new Uint8Array(fromHex(item.cipher.ivHex)),
        additionalData: new Uint8Array(authenticatedData(item)), tagLength: TAG_BITS,
      },
      key, new Uint8Array(fromHex(item.ciphertextHex)),
    );
    secret = new Uint8Array(decrypted);
    const publicKey = derivePublicKey(secret);
    if (toHex(publicKey) !== item.publicKeyHex) throw new Error('Key mismatch.');
    const keys = { secretKey: secret, publicKey };
    secret = undefined; // Ownership passes to the caller, which must clear it when locking.
    return keys;
  } catch {
    // Authentication failures must not expose decrypted bytes or lower-level key diagnostics.
    throw new Error('Could not unlock this key. Check the password and backup file.');
  } finally {
    pass.fill(0);
    secret?.fill(0);
  }
}
