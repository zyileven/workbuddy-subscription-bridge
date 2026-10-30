import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Auth, login } from '../src/auth.mjs';
import { readJSON, writeJSON } from '../src/common.mjs';
const { createMock } = createRequire(import.meta.url)('./upstream.cjs');
let mock, base, dir, auth;
before(async () => { mock = createMock(); base = await mock.start(); });
after(async () => { await mock.close(); });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workbuddy-bridge-test-')); auth = new Auth(dir, { issuer: base });
  mock.controls.scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  mock.controls.refreshes = 0;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function authorize() {
  const attempt = await auth.beginLogin('http://127.0.0.1:1455/auth/callback'); mock.controls.nonce = attempt.nonce;
  return auth.completeLogin(attempt, new URLSearchParams({ code: 'fixture-code', state: attempt.state, client_id: 'oaiapp_fixture' }));
}
test('first login uses dynamic registration and fresh state, nonce and S256; host ID persists', async () => {
  const a = await auth.beginLogin('http://127.0.0.1:1455/auth/callback'), b = await auth.beginLogin(a.redirectUri);
  const params = new URL(a.url).searchParams;
  assert.equal(params.get('client_id'), 'dynamic_agent_client'); assert.equal(params.get('code_challenge_method'), 'S256');
  assert.match(params.get('ext_agent_host_id'), /^urn:uuid:/); assert.equal(params.get('ext_agent_host_id'), new URL(b.url).searchParams.get('ext_agent_host_id'));
  assert.notEqual(a.state, b.state); assert.notEqual(a.verifier, b.verifier); assert.notEqual(a.nonce, b.nonce);
});
test('valid signed ID token activates an independent session and private files', async () => {
  assert.deepEqual(await authorize(), { connected: true, plan_usage_enabled: true });
  assert.match(await auth.getToken(), /^fixture-access/);
  const record = await readJSON(auth.credentialsPath); assert.equal(record.client_id, 'oaiapp_fixture');
  assert.equal((await stat(auth.credentialsPath)).mode & 0o777, 0o600);
  const returning = await auth.beginLogin('http://127.0.0.1:1455/auth/callback');
  assert.equal(returning.clientId, 'oaiapp_fixture'); assert.equal(new URL(returning.url).searchParams.has('agent_name_hint'), false);
  assert.equal(JSON.stringify(await auth.status()).includes('fixture-access'), false);
});
test('bad state is rejected before exchanging a code', async () => {
  const attempt = await auth.beginLogin('http://127.0.0.1:1455/auth/callback'), count = mock.records.length;
  await assert.rejects(auth.completeLogin(attempt, new URLSearchParams({ code: 'x', state: 'wrong', client_id: 'oaiapp_fixture' })), /state mismatch/);
  assert.equal(mock.records.length, count); assert.equal((await auth.status()).connected, false);
});
test('signed tokens with wrong nonce, audience or expired claims and forged signatures are rejected', async () => {
  mock.controls.nonce = 'expected';
  const parts = mock.jwt().split('.'); parts[2] = `${parts[2][0] === 'a' ? 'b' : 'a'}${parts[2].slice(1)}`;
  for (const token of [mock.jwt({ nonce: 'wrong' }), mock.jwt({ aud: 'wrong' }), mock.jwt({ exp: 1 }), parts.join('.')]) {
    await assert.rejects(auth.verifyIdentity(token, 'oaiapp_fixture', 'expected'), /validation failed/);
  }
});
test('the issued registration survives a failed identity check, without activating credentials', async () => {
  const attempt = await auth.beginLogin('http://127.0.0.1:1455/auth/callback'); mock.controls.nonce = 'wrong';
  await assert.rejects(auth.completeLogin(attempt, new URLSearchParams({ code: 'x', state: attempt.state, client_id: 'oaiapp_fixture' })), /validation failed/);
  assert.equal((await readJSON(auth.settingsPath)).client_id, 'oaiapp_fixture'); assert.equal((await auth.status()).connected, false);
});
test('identity sign-in without plan scope cannot call inference', async () => {
  mock.controls.scope = 'openid profile email offline_access';
  assert.deepEqual(await authorize(), { connected: true, plan_usage_enabled: false });
  await assert.rejects(auth.getToken(), e => e.code === 'plan_usage_not_granted');
});
test('concurrent refreshers rotate the same session exactly once, including across Auth instances', async () => {
  await authorize(); const record = await readJSON(auth.credentialsPath);
  await writeJSON(auth.credentialsPath, { ...record, expires_at: 0 });
  const other = new Auth(dir, { issuer: base });
  const tokens = await Promise.all([auth.getToken(), other.getToken(), auth.getToken(), other.getToken()]);
  assert.deepEqual([...new Set(tokens)], ['fixture-access-1']); assert.equal(mock.controls.refreshes, 1);
  assert.equal((await readJSON(auth.credentialsPath)).refresh_token, 'fixture-refresh-1');
  const request = mock.records.filter(r => r.path.endsWith('/oauth/token')).at(-1);
  assert.equal(new URLSearchParams(request.body).get('client_id'), 'oaiapp_fixture');
});
test('refresh that removes plan permission blocks subsequent use', async () => {
  await authorize(); const record = await readJSON(auth.credentialsPath); await writeJSON(auth.credentialsPath, { ...record, expires_at: 0 });
  mock.controls.scope = 'openid';
  await assert.rejects(auth.getToken(), e => e.code === 'plan_usage_not_granted');
  assert.equal((await auth.status()).plan_usage_enabled, false);
});
for (const host of ['127.0.0.1', '0.0.0.0']) {
  test(`callback on ${host} keeps a loopback redirect, rejects invalid state and completes login`, async () => {
    const result = await login(auth, { port: 0, host, onReady: async url => {
      const params = new URL(url).searchParams; mock.controls.nonce = params.get('nonce');
      const callback = new URL(params.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      callback.search = new URLSearchParams({ code: 'fixture-code', state: 'bad', client_id: 'oaiapp_fixture' });
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', params.get('state'));
      assert.equal((await fetch(callback)).status, 200);
    } });
    assert.equal(result.plan_usage_enabled, true);
  });
}
test('logout revokes refresh token before deleting credentials, preserving the registration', async () => {
  await authorize(); await auth.logout();
  assert.equal((await auth.status()).connected, false); assert.equal((await readJSON(auth.settingsPath)).client_id, 'oaiapp_fixture');
  assert.ok(mock.records.some(r => r.path === '/revoke'));
});
