import { falcon512padded } from '@noble/post-quantum/falcon.js';

export const MESSAGE_BYTES = 32;
export const PUBLIC_KEY_BYTES = 897;
export const SECRET_KEY_BYTES = 1281;
export const SIGNATURE_BYTES = 666;
export const SCHEME = 'falcon-512-round3-shake256';

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

/** Parses hex without silently truncating malformed input or changing the signed bytes. */
export function fromHex(input: string, expectedBytes?: number): Uint8Array {
  const hex = input.trim().replace(/^0x/i, '');
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('Enter complete hexadecimal bytes (two characters per byte).');
  }
  if (expectedBytes !== undefined && hex.length !== expectedBytes * 2) {
    throw new Error(`Expected exactly ${expectedBytes} bytes (${expectedBytes * 2} hex characters).`);
  }
  return Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createKeyPair(): KeyPair {
  // Use the library's default system randomness for both key generation and signing.
  return falcon512padded.keygen();
}

export function derivePublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== SECRET_KEY_BYTES) throw new Error('Invalid Falcon private key.');
  return falcon512padded.getPublicKey(secretKey);
}

export function signMessage(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (message.length !== MESSAGE_BYTES) throw new Error('The demo signs exactly 32 message bytes.');
  return falcon512padded.sign(message, secretKey);
}

export function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (
    message.length !== MESSAGE_BYTES ||
    signature.length !== SIGNATURE_BYTES ||
    publicKey.length !== PUBLIC_KEY_BYTES
  ) return false;
  try {
    return falcon512padded.verify(signature, message, publicKey);
  } catch {
    // Malformed external encodings are failed verification, not a successful empty result.
    return false;
  }
}

/** Contains only public material for browser/Solidity compatibility tests. */
export function publicSample(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) {
  return {
    // Keep this identifier readable by samples exported before the repository rename.
    schema: 'falcon-browser-demo/public-sample-v1',
    scheme: SCHEME,
    signatureEncoding: 'padded-detached',
    messageHex: toHex(message),
    publicKeyHex: toHex(publicKey),
    signatureHex: toHex(signature),
    expectedValid: verifySignature(message, signature, publicKey),
  };
}
