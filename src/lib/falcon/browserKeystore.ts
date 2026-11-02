import { parseKeystore, type Keystore } from './keystore.ts';

export const BROWSER_KEYSTORE_KEY = 'falcom-devcon-poc:keystore:v1';
export type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The same bounded, authenticated keystore format is used for files and browser storage. */
export function readBrowserKeystore(storage: KeyStorage): Keystore | null {
  const text = storage.getItem(BROWSER_KEYSTORE_KEY);
  return text === null ? null : parseKeystore(text);
}

/** Refuses existing copies, including unreadable ones. Caller holds the browser keystore lock. */
export function saveBrowserKeystore(storage: KeyStorage, item: Keystore): void {
  const serialized = JSON.stringify(parseKeystore(JSON.stringify(item)));
  if (storage.getItem(BROWSER_KEYSTORE_KEY) !== null) {
    throw new Error('A key is already saved in this browser. Remove that copy before saving another.');
  }
  try {
    storage.setItem(BROWSER_KEYSTORE_KEY, serialized);
    if (storage.getItem(BROWSER_KEYSTORE_KEY) !== serialized) throw new Error('Write not retained.');
  } catch {
    throw new Error('Could not save the key in this browser. Download an encrypted backup instead.');
  }
}

/** Deletes only the confirmed copy. Caller holds the browser keystore lock; other storage is untouched. */
export function removeBrowserKeystore(storage: KeyStorage, expected: string): void {
  if (storage.getItem(BROWSER_KEYSTORE_KEY) !== expected) {
    throw new Error('The saved key changed. Review the current key before removing it.');
  }
  storage.removeItem(BROWSER_KEYSTORE_KEY);
  if (storage.getItem(BROWSER_KEYSTORE_KEY) !== null) throw new Error('Could not remove the saved key.');
}
