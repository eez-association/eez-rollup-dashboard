import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCowResponse } from '../src/lib/cowApi.ts';

test('HTML fallback and proxy errors produce a service message instead of a JSON parse error', async () => {
  for (const status of [200, 404, 502]) {
    await assert.rejects(readCowResponse(new Response('<!DOCTYPE html><title>Dashboard</title>', {
      status, headers: { 'content-type': 'text/html' },
    })), /CoW Light service is unavailable/);
  }
  await assert.rejects(readCowResponse(new Response('', { status: 500 })), /CoW Light service is unavailable/);
});

test('invalid JSON responses are explained without exposing parser errors', async () => {
  for (const body of ['{', 'null', '[]', '"hello"']) {
    await assert.rejects(readCowResponse(new Response(body, { headers: { 'content-type': 'application/json' } })), /CoW Light returned an invalid response/);
  }
});

test('valid responses and deployment or API failures retain their meaning', async () => {
  const config = { network: 'chiado', l1ChainId: 10200 };
  assert.deepEqual(await readCowResponse(Response.json(config)), config);
  await assert.rejects(readCowResponse(Response.json({ status: 'deployment_required' }, { status: 503 })), /needs a verified deployment/);
  await assert.rejects(readCowResponse(Response.json({ error: 'unknown token' }, { status: 404 })), /unknown token/);
  await assert.rejects(readCowResponse(Response.json({}, { status: 503 }), 'Test-token faucet is unavailable.'), /Test-token faucet is unavailable/);
});
