import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workBuddyModel } from '../src/connection.mjs';
import { Auth } from '../src/auth.mjs';
import { writeJSON } from '../src/common.mjs';

const key = 'fixture-bridge-key-at-least-32-characters';
const auth = { status: async () => ({ connected: true, plan_usage_enabled: true }), init: async () => ({ local_key: key }) };
let server, api, replies, seen;
const endpoint = { url: 'https://fixture-bridge.ngrok.example', upstream: { url: 'http://bridge:8787' } };
before(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(replies.length > 1 ? replies.shift() : replies[0]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test('configuration requires account authorization and plan permission', async () => {
  for (const [status, code] of [[{ connected: false }, 'login_required'], [{ connected: true, plan_usage_enabled: false }, 'plan_usage_not_granted']]) {
    await assert.rejects(workBuddyModel({ status: async () => status }, { ngrokAPI: '', publicURL: '' }), error => error.code === code);
  }
});
test('local and configured public modes produce ready-to-paste model objects with only the bridge key', async () => {
  const local = await workBuddyModel(auth, { ngrokAPI: '', publicURL: '', port: 8788 });
  assert.equal(local.url, 'http://127.0.0.1:8788/v1/chat/completions');
  assert.equal(local.apiKey, key);
  assert.equal(local.id, 'gpt-6.1-sol-bridge');
  assert.equal(local.api, 'openai-completions');
  assert.equal(local.useCustomProtocol, true);
  const configured = await workBuddyModel(auth, { ngrokAPI: '', publicURL: endpoint.url, requirePublic: true });
  assert.equal(configured.url, `${endpoint.url}/v1/chat/completions`);
  assert.equal(configured.reasoning.summary, undefined);
  for (const bad of ['http://example.com', 'https://user:password@example.com', 'https://example.com/v1', 'https://example.com/?secret=x']) {
    await assert.rejects(workBuddyModel(auth, { ngrokAPI: '', publicURL: bad }), error => error.code === 'invalid_public_url');
  }
});
test('actual agent HTTP discovery selects the HTTPS bridge endpoint and sends no bearer credentials', async () => {
  seen = []; replies = [{ endpoints: [{ url: 'https://other.example', upstream: { url: 'http://other:80' } }, { ...endpoint, url: 'http://insecure.example' }, endpoint] }];
  const result = await workBuddyModel(auth, { ngrokAPI: api, publicURL: '', requirePublic: true });
  assert.equal(result.url, `${endpoint.url}/v1/chat/completions`);
  assert.deepEqual(seen, [{ path: '/api/endpoints', authorization: undefined }]);
});
test('public mode waits for agent readiness and never silently returns localhost or a mismatched endpoint', async () => {
  seen = []; replies = [{ endpoints: [] }, { endpoints: [endpoint] }];
  const result = await workBuddyModel(auth, { ngrokAPI: api, publicURL: '', requirePublic: true, pollMs: 1, timeoutMs: 500 });
  assert.equal(result.url, `${endpoint.url}/v1/chat/completions`);
  assert.equal(seen.length, 2);
  replies = [{ endpoints: [endpoint] }];
  await assert.rejects(workBuddyModel(auth, { ngrokAPI: api, publicURL: 'https://expected.example', requirePublic: true, pollMs: 1, timeoutMs: 20 }), error => error.code === 'public_endpoint_unavailable');
  replies = [{ endpoints: [] }];
  await assert.rejects(workBuddyModel(auth, { ngrokAPI: api, publicURL: '', requirePublic: true, timeoutMs: 20, pollMs: 1 }), error => error.code === 'public_endpoint_unavailable');
});
test('CLI connection prints valid JSON from saved credentials without exposing OAuth or ngrok tokens', async () => {
  seen = []; replies = [{ endpoints: [endpoint] }];
  const dir = await mkdtemp(join(tmpdir(), 'bridge-connection-'));
  try {
    const stored = new Auth(dir), settings = await stored.init();
    await writeJSON(stored.credentialsPath, { access_token: 'fixture-oauth-access-token', refresh_token: 'fixture-oauth-refresh-token', scopes: ['chatgpt.tokens.use.direct'], expires_at: Date.now() + 60000 });
    const { stdout } = await promisify(execFile)(process.execPath, ['src/cli.mjs', 'connection', '--data-dir', dir, '--require-public'], {
      env: { ...process.env, BRIDGE_NGROK_API_URL: api, BRIDGE_PUBLIC_URL: '' },
    });
    const model = JSON.parse(stdout);
    assert.equal(model.url, `${endpoint.url}/v1/chat/completions`);
    assert.equal(model.apiKey, settings.local_key);
    assert.doesNotMatch(stdout, /fixture-oauth|access_token|refresh_token|NGROK_AUTHTOKEN/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
