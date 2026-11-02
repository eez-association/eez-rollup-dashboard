import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('public Falcon deployment evidence omits RPC endpoints and private signing settings', () => {
  const record = JSON.parse(readFileSync(new URL('../../docs/falcon/deployments/eez-dev-699169.json', import.meta.url), 'utf8'));
  const inspect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert(!/rpc|private.?key|mnemonic|password|secret|raw.?transaction/i.test(key), key);
      if (typeof child === 'string' && /^https?:/i.test(child)) {
        const url = new URL(child);
        assert.equal(url.username, ''); assert.equal(url.password, '');
        assert(!/\/(rpc|composer)(\/|$)/i.test(url.pathname), 'public evidence needs explorer provenance, not transport endpoints');
      }
      inspect(child);
    }
  };
  inspect(record);
});
