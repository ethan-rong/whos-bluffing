import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeCtx, worker } from './helpers.js';

test('rate denial precedes body parsing and OAuth provider calls', async () => {
  const env = makeEnv();
  const keys = [];
  env.REQUEST_LIMITER.limit = async ({ key }) => { keys.push(key); return { success: false }; };
  for (const path of ['/slack/events', '/slack/oauth/callback?code=test']) {
    const request = new Request('https://worker.test' + path, { method: path === '/slack/events' ? 'POST' : 'GET', ...(path === '/slack/events' ? { body: 'command=%2Fbluff' } : {}), headers: { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.2' } });
    request.text = () => { throw Error('Body must not be read'); };
    const response = await worker.fetch(request, env, makeCtx());
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
  }
  assert.deepEqual(keys, ['192.0.2.1', '192.0.2.1']);
});
