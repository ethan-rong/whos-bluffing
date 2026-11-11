import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeCtx, worker } from './helpers.js';

test('rate denial precedes body parsing and trusts only the Cloudflare client IP', async () => {
  const env = makeEnv();
  let key;
  env.REQUEST_LIMITER.limit = async (input) => { key = input.key; return { success: false }; };
  const request = new Request('https://worker.test/interactions', { method: 'POST', body: '{}', headers: { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.2' } });
  request.text = () => { throw Error('Body must not be read'); };
  const response = await worker.fetch(request, env, makeCtx());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(key, '192.0.2.1');
});

test('presence burst denial does not invoke the Durable Object', async () => {
  const env = makeEnv();
  env.PRESENCE_LIMITER.limit = async ({ key }) => { assert.equal(key, 'presence'); return { success: false }; };
  env.PRESENCE = { idFromName() { throw Error('Must not invoke presence'); } };
  assert.equal((await worker.fetch(new Request('https://worker.test/presence'), env, makeCtx())).status, 429);
});

test('allowed presence requests keep using the single existing object', async () => {
  const env = makeEnv();
  env.PRESENCE = {
    idFromName(name) { assert.equal(name, 'main'); return 'existing'; },
    get(id) { assert.equal(id, 'existing'); return { fetch: async () => Response.json({ connected: true }) }; },
  };
  const response = await worker.fetch(new Request('https://worker.test/presence'), env, makeCtx());
  assert.deepEqual(await response.json(), { connected: true });
});
