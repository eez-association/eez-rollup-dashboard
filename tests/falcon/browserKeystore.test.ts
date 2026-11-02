import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createKeyPair, toHex } from '../../src/lib/falcon/falcon.ts';
import { encryptKeystore } from '../../src/lib/falcon/keystore.ts';
import {
  BROWSER_KEYSTORE_KEY, readBrowserKeystore, removeBrowserKeystore, saveBrowserKeystore, type KeyStorage,
} from '../../src/lib/falcon/browserKeystore.ts';

const keys = createKeyPair();
const password = 'browser storage test password';
const encrypted = await encryptKeystore(keys, password);
after(() => keys.secretKey.fill(0));

function memoryStorage() {
  const entries = new Map<string, string>();
  const storage: KeyStorage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); },
  };
  return { storage, entries };
}

test('stores only the encrypted keystore and reads it back unchanged', () => {
  const { storage, entries } = memoryStorage();
  assert.equal(readBrowserKeystore(storage), null);
  saveBrowserKeystore(storage, encrypted);
  assert.deepEqual(readBrowserKeystore(storage), encrypted);
  assert.deepEqual([...entries.keys()], [BROWSER_KEYSTORE_KEY]);
  const text = storage.getItem(BROWSER_KEYSTORE_KEY)!;
  assert.equal(text.includes(password), false);
  assert.equal(text.includes(toHex(keys.secretKey)), false);
});

test('never overwrites an existing or malformed saved copy', () => {
  const { storage } = memoryStorage();
  for (const prior of [JSON.stringify(encrypted), '{broken']) {
    storage.setItem(BROWSER_KEYSTORE_KEY, prior);
    assert.throws(() => saveBrowserKeystore(storage, encrypted), /already saved/);
    assert.equal(storage.getItem(BROWSER_KEYSTORE_KEY), prior);
  }
});

test('rejects malformed saved data and never serializes extra private fields', () => {
  const { storage } = memoryStorage();
  assert.throws(() => saveBrowserKeystore(storage, { ...encrypted, secretKey: toHex(keys.secretKey) }), /Unexpected fields/);
  assert.equal(storage.getItem(BROWSER_KEYSTORE_KEY), null);
  storage.setItem(BROWSER_KEYSTORE_KEY, '{broken');
  assert.throws(() => readBrowserKeystore(storage), /valid encrypted key JSON/);
  assert.equal(storage.getItem(BROWSER_KEYSTORE_KEY), '{broken');
});

test('write failure or silent storage failure cannot be reported as a successful save', () => {
  const { storage } = memoryStorage();
  for (const setItem of [() => { throw new Error('quota'); }, () => {}]) {
    assert.throws(() => saveBrowserKeystore({ ...storage, setItem }, encrypted), /Could not save/);
    assert.equal(storage.getItem(BROWSER_KEYSTORE_KEY), null);
  }
});

test('removal clears only the confirmed saved copy and preserves dashboard preferences', () => {
  const { storage } = memoryStorage();
  storage.setItem('dashboard-preference', 'keep');
  saveBrowserKeystore(storage, encrypted);
  removeBrowserKeystore(storage, storage.getItem(BROWSER_KEYSTORE_KEY)!);
  assert.equal(readBrowserKeystore(storage), null);
  assert.equal(storage.getItem('dashboard-preference'), 'keep');
});

test('a stale removal confirmation cannot delete a changed saved copy', () => {
  const { storage } = memoryStorage();
  saveBrowserKeystore(storage, encrypted);
  assert.throws(() => removeBrowserKeystore(storage, 'previous copy'), /saved key changed/);
  assert.deepEqual(readBrowserKeystore(storage), encrypted);
});

test('failed deletion is observable and leaves the saved copy intact', () => {
  const { storage } = memoryStorage();
  saveBrowserKeystore(storage, encrypted);
  const text = storage.getItem(BROWSER_KEYSTORE_KEY)!;
  assert.throws(() => removeBrowserKeystore({ ...storage, removeItem: () => {} }, text), /Could not remove/);
  assert.equal(storage.getItem(BROWSER_KEYSTORE_KEY), text);
});
