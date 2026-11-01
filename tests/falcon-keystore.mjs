import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fixture, origin, visibilityKey } from './falcon/fixture.mjs';
import { chromium } from 'playwright';
import { decryptKeystore } from '../src/lib/falcon/keystore.ts';
import { toHex } from '../src/lib/falcon/falcon.ts';
import { BROWSER_KEYSTORE_KEY } from '../src/lib/falcon/browserKeystore.ts';

const browser = await chromium.launch({ headless: true, chromiumSandbox: process.env.TREASURY_BROWSER_SANDBOX !== '0' });
try {
  const { context, page, errors, requests, open } = await fixture(browser);
  let downloads = 0;
  page.on('download', () => downloads++);
  // Gate real Web Crypto derivations to exercise locking during work without timing-dependent sleeps.
  await page.addInitScript(() => {
    const derive = SubtleCrypto.prototype.deriveKey;
    const decrypt = SubtleCrypto.prototype.decrypt;
    const encrypt = SubtleCrypto.prototype.encrypt;
    window.cryptoTest = { hold: false, entered: false, completed: false, release: () => {} };
    SubtleCrypto.prototype.deriveKey = async function (...args) {
      if (window.cryptoTest.hold) {
        window.cryptoTest.entered = true;
        await new Promise(resolve => { window.cryptoTest.release = resolve; });
        window.cryptoTest.hold = false;
      }
      return Reflect.apply(derive, this, args);
    };
    for (const [name, original] of [['decrypt', decrypt], ['encrypt', encrypt]]) {
      SubtleCrypto.prototype[name] = async function (...args) {
        try { return await Reflect.apply(original, this, args); }
        finally { window.cryptoTest.completed = true; }
      };
    }
  });
  await open();
  await page.locator('#signature-playground > summary').click();
  const waitResult = (id, kind) => page.waitForFunction(([id, kind]) => document.getElementById(id)?.dataset.result === kind, [id, kind]);
  const waitText = (id, text) => page.waitForFunction(([id, text]) => document.getElementById(id)?.textContent.includes(text), [id, text]);
  const password = 'browser test password — disposable';
  const backupPassword = () => page.getByLabel('Backup password', { exact: true });
  const confirmPassword = () => page.getByLabel('Confirm password', { exact: true });
  const keyValue = () => page.getByTestId('public-key').inputValue();
  const fillBackup = async () => {
    await backupPassword().fill(password);
    await confirmPassword().fill(password);
  };
  const readDownload = async download => {
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  assert.equal(await page.locator('#sign').isDisabled(), true);
  assert(await page.getByRole('heading', { name: 'Your Falcon Safe' }).isVisible());
  assert.equal(await page.getByRole('button', { name: /L[12] counter/ }).count(), 0);
  await page.locator('#generate').click();
  await waitText('key-status', 'Key generated');
  const originalPublicKey = await keyValue();
  assert.equal(originalPublicKey.length, 897 * 2);
  assert.equal(await page.locator('#generate').isDisabled(), true);
  await page.locator('#sign').click();
  await waitText('signature-status', 'Signature ready');
  await page.locator('#verify').click();
  await waitResult('signature-status', 'valid');
  const originalMessage = await page.getByTestId('message').inputValue();
  const originalSignature = await page.getByTestId('signature').inputValue();
  const publicDownloadPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const publicSample = JSON.parse((await readDownload(await publicDownloadPromise)).toString());
  assert.equal(publicSample.expectedValid, true);
  assert.deepEqual(Object.keys(publicSample).sort(), ['schema', 'scheme', 'signatureEncoding', 'messageHex', 'publicKeyHex', 'signatureHex', 'expectedValid'].sort());
  await waitText('signature-status', 'Public sample');

  await fillBackup();
  await confirmPassword().fill('a different test password');
  await page.locator('#backup').click();
  await waitResult('key-status', 'error');
  assert.match(await page.locator('#key-status').textContent(), /Passwords do not match/);
  assert.equal(await keyValue(), originalPublicKey);
  assert.equal(await backupPassword().inputValue(), '');

  await fillBackup();
  const backupPromise = page.waitForEvent('download');
  await page.locator('#backup').click();
  const backupDownload = await backupPromise;
  assert.equal(backupDownload.suggestedFilename(), 'falcom-devcon-poc.keystore.json');
  const backupBytes = await readDownload(backupDownload);
  const decoded = await decryptKeystore(backupBytes.toString(), password);
  try {
    assert.equal(toHex(decoded.publicKey), originalPublicKey);
    assert.equal(backupBytes.toString().includes(toHex(decoded.secretKey)), false);
  } finally { decoded.secretKey.fill(0); }
  await waitResult('key-status', 'valid');
  assert.equal(await backupPassword().inputValue(), '');
  assert.equal(await confirmPassword().inputValue(), '');
  await mkdir('.runtime/falcon-integration/browser', { recursive: true });
  await page.screenshot({ path: '.runtime/falcon-integration/browser/desktop.png', fullPage: true });

  // Reload loses the plaintext session; the encrypted download restores the same public key.
  await page.reload();
  await page.locator('#signature-playground > summary').click();
  assert.equal(await page.locator('#sign').isDisabled(), true);
  const chooseBackup = async (buffer = backupBytes, remember = false) => {
    await page.getByLabel('Encrypted key file', { exact: true }).setInputFiles({ name: 'test.keystore.json', mimeType: 'application/json', buffer });
    await page.getByLabel('Remember this key in this browser', { exact: true }).setChecked(remember);
  };
  await chooseBackup();
  await backupPassword().fill('incorrect test password');
  await page.locator('#restore').click();
  await waitResult('key-status', 'error');
  assert.match(await page.locator('#key-status').textContent(), /Could not unlock/);
  assert.equal(await page.locator('#sign').isDisabled(), true);
  assert.equal(await backupPassword().inputValue(), '');
  await backupPassword().fill(password);
  await page.locator('#restore').click();
  await waitText('key-status', 'Key restored');
  assert.equal(await keyValue(), originalPublicKey);
  await page.getByTestId('signature').fill(originalSignature);
  await page.locator('#verify').click();
  await waitResult('signature-status', 'valid');
  await page.locator('#sign').click();
  await waitText('signature-status', 'Signature ready');
  await page.locator('#verify').click();
  await waitResult('signature-status', 'valid');
  await page.getByTestId('message').fill('ff' + originalMessage.slice(2));
  await page.locator('#verify').click();
  await waitResult('signature-status', 'invalid');
  await page.getByTestId('message').fill(originalMessage);
  await page.getByTestId('signature').fill('00');
  await page.locator('#verify').click();
  await waitResult('signature-status', 'error');

  await page.locator('#lock').click();
  await chooseBackup(Buffer.alloc(16 * 1024 + 1, 32));
  await backupPassword().fill(password);
  await page.locator('#restore').click();
  await waitResult('key-status', 'error');
  assert.match(await page.locator('#key-status').textContent(), /16 KiB/);
  const tampered = JSON.parse(backupBytes.toString());
  tampered.ciphertextHex = (tampered.ciphertextHex.startsWith('00') ? '01' : '00') + tampered.ciphertextHex.slice(2);
  await chooseBackup(Buffer.from(JSON.stringify(tampered)));
  await backupPassword().fill(password);
  await page.locator('#restore').click();
  await waitResult('key-status', 'error');
  assert.match(await page.locator('#key-status').textContent(), /Could not unlock/);

  await chooseBackup();
  await backupPassword().fill(password);
  await page.evaluate(() => Object.assign(window.cryptoTest, { hold: true, entered: false, completed: false }));
  await page.locator('#restore').click();
  await page.waitForFunction(() => window.cryptoTest.entered);
  await page.locator('#lock').click();
  await page.locator('#generate').click();
  await waitText('key-status', 'Key generated');
  const replacementKey = await keyValue();
  assert.notEqual(replacementKey, originalPublicKey);
  await page.evaluate(() => window.cryptoTest.release());
  await page.waitForFunction(() => window.cryptoTest.completed);
  assert.equal(await keyValue(), replacementKey, 'a canceled import must not replace a newer key');

  await fillBackup();
  const replacementDownload = page.waitForEvent('download');
  await page.locator('#backup').click();
  const replacementBackupBytes = await readDownload(await replacementDownload);
  await waitResult('key-status', 'valid');

  await fillBackup();
  await page.evaluate(() => Object.assign(window.cryptoTest, { hold: true, entered: false, completed: false }));
  const beforeCancel = downloads;
  await page.locator('#backup').click();
  await page.waitForFunction(() => window.cryptoTest.entered);
  await page.locator('#lock').click();
  await page.evaluate(() => window.cryptoTest.release());
  await page.waitForFunction(() => window.cryptoTest.completed);
  assert.equal(downloads, beforeCancel, 'locking must suppress a pending backup download');
  assert.equal(await page.locator('#sign').isDisabled(), true);
  assert.equal(await page.getByTestId('public-key').count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.runtime/falcon-integration/browser/mobile.png', fullPage: true });
  const controls = await page.getByRole('region', { name: 'Falcon Safe demo', exact: true }).locator('button:visible').evaluateAll(elements => elements.map(element => ({ height: element.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(element).fontSize) })));
  assert(controls.length > 0 && controls.every(control => control.height >= 44 && control.fontSize >= 12));
  assert.equal(await page.locator('#generate').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  await page.locator('#generate').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'generate');
  assert.equal(await page.locator('#generate').evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 1]);

  // Import remembers the encrypted file by default, without changing its password or key.
  await page.reload();
  await page.locator('#signature-playground > summary').click();
  assert.equal(await page.getByLabel('Remember this key in this browser', { exact: true }).isChecked(), true);
  await chooseBackup(backupBytes, true);
  await backupPassword().fill(password);
  await page.locator('#restore').click();
  await waitText('key-status', 'Key restored and saved');
  const savedText = () => page.evaluate(key => localStorage.getItem(key), BROWSER_KEYSTORE_KEY);
  const importedText = await savedText();
  assert.deepEqual(JSON.parse(importedText), JSON.parse(backupBytes.toString()));
  assert.equal(await keyValue(), originalPublicKey);

  await page.reload();
  await page.locator('#signature-playground > summary').click();
  await page.locator('#unlock-saved').waitFor();
  assert.equal(await page.getByLabel('Encrypted key file', { exact: true }).isVisible(), false);
  assert.equal(await page.locator('#sign').isDisabled(), true);
  const savedPassword = () => page.getByLabel('Saved key password', { exact: true });
  await savedPassword().fill('incorrect test password');
  await page.locator('#unlock-saved').click();
  await waitResult('key-status', 'error');
  assert.match(await page.locator('#key-status').textContent(), /Could not unlock/);
  assert.equal(await savedText(), importedText);
  assert.equal(await savedPassword().inputValue(), '');
  await savedPassword().fill(password);
  await page.locator('#unlock-saved').click();
  await waitText('key-status', 'Saved key unlocked');
  assert.equal(await keyValue(), originalPublicKey);
  await page.getByTestId('signature').fill(originalSignature);
  await page.locator('#verify').click();
  await waitResult('signature-status', 'valid');
  await page.locator('#sign').click();
  await waitText('signature-status', 'Signature ready');
  await page.locator('#verify').click();
  await waitResult('signature-status', 'valid');

  await page.locator('#lock').click();
  assert.equal(await savedText(), importedText, 'locking retains only the encrypted copy');
  const savedDownloadPromise = page.waitForEvent('download');
  await page.locator('#download-saved').click();
  assert.deepEqual(JSON.parse((await readDownload(await savedDownloadPromise)).toString()), JSON.parse(importedText));
  await waitText('key-status', 'Saved encrypted backup download requested');

  // Switching can use another browser-generated key without replacing the saved copy.
  await page.locator('#import-options > summary').click();
  assert.equal(await page.getByLabel('Remember this key in this browser', { exact: true }).count(), 0);
  await page.getByLabel('Encrypted key file', { exact: true }).setInputFiles({ name: 'other.keystore.json', mimeType: 'application/json', buffer: replacementBackupBytes });
  await backupPassword().fill(password);
  await page.locator('#restore').click();
  await waitText('key-status', 'Key restored and unlocked');
  assert.equal(await keyValue(), replacementKey);
  assert.equal(await savedText(), importedText);
  await page.getByTestId('signature').fill(originalSignature);
  await page.locator('#verify').click();
  await waitResult('signature-status', 'invalid');
  await page.locator('#sign').click();
  await waitText('signature-status', 'Signature ready');
  await page.locator('#verify').click();
  await waitResult('signature-status', 'valid');
  await page.getByRole('button', { name: 'Switch key', exact: true }).click();
  await savedPassword().fill(password);
  await page.locator('#unlock-saved').click();
  await waitText('key-status', 'Saved key unlocked');
  assert.equal(await keyValue(), originalPublicKey);
  assert.equal(await savedText(), importedText);
  await page.getByRole('button', { name: 'Switch key', exact: true }).click();

  // Removing the saved copy in another tab cancels an in-flight unlock in this tab.
  const peer = await context.newPage();
  await open(peer);
  await peer.locator('#unlock-saved').waitFor();
  await page.evaluate(() => Object.assign(window.cryptoTest, { hold: true, entered: false, completed: false }));
  await savedPassword().fill(password);
  await page.locator('#unlock-saved').click();
  await page.waitForFunction(() => window.cryptoTest.entered);
  await peer.locator('#remove-saved').click();
  await peer.locator('#confirm-remove').click();
  await peer.waitForFunction(() => document.getElementById('key-status')?.textContent.includes('Saved key removed'));
  await page.locator('#restore').waitFor();
  await page.evaluate(() => window.cryptoTest.release());
  await page.waitForFunction(() => window.cryptoTest.completed);
  assert.equal(await page.locator('#sign').isDisabled(), true);
  assert.equal(await page.getByTestId('public-key').count(), 0);
  assert.equal(await savedText(), null);
  await peer.close();

  // A failed save keeps the active key available for downloading a backup.
  await page.locator('#generate').click();
  await waitText('key-status', 'Key generated');
  const unsavedPublicKey = await keyValue();
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    window.restoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Test quota exceeded', 'QuotaExceededError');
      return Reflect.apply(original, this, [name, value]);
    };
  }, BROWSER_KEYSTORE_KEY);
  await fillBackup();
  await page.locator('#remember').click();
  await waitResult('key-status', 'error');
  assert.match(await page.locator('#key-status').textContent(), /Could not save/);
  assert.equal(await keyValue(), unsavedPublicKey);
  assert.equal(await savedText(), null);
  await fillBackup();
  const fallbackDownload = page.waitForEvent('download');
  await page.locator('#backup').click();
  assert.equal(JSON.parse((await readDownload(await fallbackDownload)).toString()).publicKeyHex, unsavedPublicKey);
  await waitResult('key-status', 'valid');
  await page.evaluate(() => window.restoreStorage());

  // A competing origin lock cannot race a read/check/write; the user can retry.
  await page.evaluate(key => {
    window.storageLockTest = { entered: false, completed: false, release: () => {} };
    void navigator.locks.request(key, () => {
      window.storageLockTest.entered = true;
      return new Promise(resolve => { window.storageLockTest.release = resolve; });
    }).finally(() => { window.storageLockTest.completed = true; });
  }, BROWSER_KEYSTORE_KEY);
  await page.waitForFunction(() => window.storageLockTest.entered);
  await fillBackup();
  await page.locator('#remember').click();
  await waitResult('key-status', 'error');
  assert.match(await page.locator('#key-status').textContent(), /Another tab/);
  assert.equal(await savedText(), null);
  assert.equal(await keyValue(), unsavedPublicKey);
  await page.evaluate(() => window.storageLockTest.release());
  await page.waitForFunction(() => window.storageLockTest.completed);

  await fillBackup();
  await page.evaluate(() => Object.assign(window.cryptoTest, { hold: true, entered: false, completed: false }));
  await page.locator('#remember').click();
  await page.waitForFunction(() => window.cryptoTest.entered);
  await page.locator('#lock').click();
  await page.evaluate(() => window.cryptoTest.release());
  await page.waitForFunction(() => window.cryptoTest.completed);
  assert.equal(await savedText(), null, 'locking suppresses a pending browser save');

  await page.locator('#generate').click();
  await waitText('key-status', 'Key generated');
  const rememberedPublicKey = await keyValue();
  await fillBackup();
  const beforeRemember = downloads;
  await page.locator('#remember').click();
  await waitText('key-status', 'Encrypted key saved');
  assert.equal(downloads, beforeRemember);
  const rememberedText = await savedText();
  const remembered = await decryptKeystore(rememberedText, password);
  try {
    assert.equal(toHex(remembered.publicKey), rememberedPublicKey);
    assert.equal(rememberedText.includes(toHex(remembered.secretKey)), false);
    assert.equal(rememberedText.includes(password), false);
  } finally { remembered.secretKey.fill(0); }
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [BROWSER_KEYSTORE_KEY]);
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), [visibilityKey]);
  await page.reload();
  await page.locator('#signature-playground > summary').click();
  await page.locator('#unlock-saved').waitFor();
  assert.equal(await page.locator('#sign').isDisabled(), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.runtime/falcon-integration/browser/saved-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.runtime/falcon-integration/browser/saved-mobile.png', fullPage: true });

  // Removal is explicit, cancellable, and confined to the app's own storage entry.
  await page.evaluate(() => localStorage.setItem('dashboard-preference-test', 'keep'));
  await page.locator('#remove-saved').click();
  assert.equal(await savedText(), rememberedText);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await savedText(), rememberedText);
  const removeSaved = async () => {
    await page.locator('#remove-saved').click();
    await page.locator('#confirm-remove').click();
    await waitText('key-status', 'Saved key removed');
  };
  await removeSaved();
  assert.equal(await savedText(), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('dashboard-preference-test')), 'keep');
  await page.evaluate(() => localStorage.removeItem('dashboard-preference-test'));

  await page.evaluate(key => localStorage.setItem(key, '{broken'), BROWSER_KEYSTORE_KEY);
  await page.reload();
  await page.locator('#signature-playground > summary').click();
  await waitResult('key-status', 'error');
  assert.match(await page.locator('#key-status').textContent(), /saved key could not be read/);
  assert.equal(await savedText(), '{broken');
  assert.equal(await page.locator('#generate').isDisabled(), true);
  assert.equal(await page.locator('#restore').isVisible(), false);
  await page.locator('#import-options > summary').click();
  await page.getByLabel('Encrypted key file', { exact: true }).setInputFiles({ name: 'test.keystore.json', mimeType: 'application/json', buffer: backupBytes });
  await backupPassword().fill(password);
  await page.locator('#restore').click();
  await waitText('key-status', 'Key restored and unlocked');
  assert.equal(await keyValue(), originalPublicKey);
  assert.equal(await savedText(), '{broken', 'a session import preserves even an unreadable saved copy');
  await removeSaved();
  assert.equal(await savedText(), null);

  const blocked = await context.newPage();
  await blocked.addInitScript(() => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'falcom-devcon-poc:keystore:v1') throw new DOMException('Test storage blocked', 'SecurityError');
      return Reflect.apply(get, this, [key]);
    };
  });
  await open(blocked);
  await blocked.waitForFunction(() => document.getElementById('key-status')?.textContent.includes('Browser storage is unavailable'));
  assert.equal(await blocked.getByLabel('Remember this key in this browser', { exact: true }).isDisabled(), true);
  await blocked.getByLabel('Encrypted key file', { exact: true }).setInputFiles({ name: 'test.keystore.json', mimeType: 'application/json', buffer: backupBytes });
  await blocked.getByLabel('Backup password', { exact: true }).fill(password);
  await blocked.locator('#restore').click();
  await blocked.waitForFunction(() => document.getElementById('key-status')?.textContent.includes('Key restored and unlocked'));
  assert.equal(await blocked.getByTestId('public-key').inputValue(), originalPublicKey);
  assert.equal(await blocked.locator('#remember').isDisabled(), true);
  await blocked.close();

  assert.deepEqual(errors, []);
  assert(requests.every(request => request.url.startsWith(new URL(origin).origin + '/')));
  assert(requests.every(request => !/send|sign|eez_quoteFee/i.test(request.body ?? '')), 'key operations cause no transaction or signing RPC');
  console.log(`Browser checks passed in Chromium ${await browser.version()}: signing, encrypted files, saved-key reload/unlock, session key switching, storage failures, cross-tab cancellation, removal, responsive layout and local-only asset requests.`);
} finally {
  await browser.close();
}
