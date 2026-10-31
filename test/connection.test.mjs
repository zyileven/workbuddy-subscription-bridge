import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workBuddyModels } from '../src/connection.mjs';
import { latestFamilyModels, upstreamModelId, modelReasoning } from '../src/models.mjs';
import { Auth } from '../src/auth.mjs';
import { writeJSON } from '../src/common.mjs';

const key = 'fixture-bridge-key-at-least-32-characters';
const auth = { status: async () => ({ connected: true, plan_usage_enabled: true }), init: async () => ({ local_key: key }), getToken: async () => 'fixture-catalog-access-token' };
const familyCatalog = { models: [
  { slug: 'gpt-6.9-sol', display_name: 'Older Sol', visibility: 'list' },
  ...['gpt-6-astra', 'gpt-6.10-sol', 'gpt-6.1-terra', 'gpt-6-luna'].map(slug => ({
    slug, display_name: slug, visibility: 'list', input_modalities: ['text', 'image'],
    default_reasoning_level: slug.endsWith('-sol') || slug.endsWith('-terra') ? 'low' : 'medium',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', ...(!slug.endsWith('-luna') ? ['ultra'] : [])].map(effort => ({ effort })),
  })),
  { slug: 'gpt-99-astra', display_name: 'Hidden fixture', visibility: 'hidden' },
] };
const expectedIds = ['gpt-6-astra-bridge', 'gpt-6.10-sol-bridge', 'gpt-6.1-terra-bridge', 'gpt-6-luna-bridge'];
let server, api, replies, seen, catalogReply = familyCatalog;
const endpoint = { url: 'https://fixture-bridge.ngrok.example', upstream: { url: 'http://bridge:8787' } };
before(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/models') { res.end(JSON.stringify(catalogReply)); return; }
    res.end(JSON.stringify(replies.length > 1 ? replies.shift() : replies[0]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const options = extra => ({ ngrokAPI: '', publicURL: '', modelBaseURL: api, ...extra });

test('configuration requires account authorization and plan permission', async () => {
  for (const [status, code] of [[{ connected: false }, 'login_required'], [{ connected: true, plan_usage_enabled: false }, 'plan_usage_not_granted']]) {
    await assert.rejects(workBuddyModels({ status: async () => status }, options()), error => error.code === code);
  }
});
test('local/public modes output latest visible family models with the same bridge key and endpoint', async () => {
  seen = [];
  const local = await workBuddyModels(auth, options({ port: 8788 }));
  assert.deepEqual(local.map(model => model.id), expectedIds);
  for (const model of local) {
    assert.equal(model.url, 'http://127.0.0.1:8788/v1/chat/completions');
    assert.equal(model.apiKey, key);
    assert.equal(model.api, 'openai-completions');
    assert.equal(model.useCustomProtocol, true);
  }
  assert.deepEqual(local.map(model => model.onlyReasoning), [true, true, true, true]);
  assert.deepEqual(local.map(model => model.reasoning.defaultEffort), ['medium', 'low', 'low', 'medium']);
  assert.deepEqual(local.map(model => model.reasoning.supportedEfforts.includes('ultra')), [true, true, true, false]);
  const configured = await workBuddyModels(auth, options({ publicURL: endpoint.url, requirePublic: true }));
  assert.ok(configured.every(model => model.url === `${endpoint.url}/v1/chat/completions` && model.reasoning.summary === undefined));
  for (const bad of ['http://example.com', 'https://user:password@example.com', 'https://example.com/v1', 'https://example.com/?secret=x']) {
    await assert.rejects(workBuddyModels(auth, options({ publicURL: bad })), error => error.code === 'invalid_public_url');
  }
});
test('actual agent HTTP discovery selects the HTTPS bridge endpoint and sends no bearer credentials', async () => {
  seen = []; replies = [{ endpoints: [{ url: 'https://other.example', upstream: { url: 'http://other:80' } }, { ...endpoint, url: 'http://insecure.example' }, endpoint] }];
  const result = await workBuddyModels(auth, options({ ngrokAPI: api, requirePublic: true }));
  assert.ok(result.every(model => model.url === `${endpoint.url}/v1/chat/completions`));
  assert.deepEqual(seen, [{ path: '/api/endpoints', authorization: undefined }, { path: '/models', authorization: 'Bearer fixture-catalog-access-token' }]);
});
test('public mode waits for agent readiness and never silently returns localhost or a mismatched endpoint', async () => {
  seen = []; replies = [{ endpoints: [] }, { endpoints: [endpoint] }];
  const result = await workBuddyModels(auth, options({ ngrokAPI: api, requirePublic: true, pollMs: 1, timeoutMs: 500 }));
  assert.ok(result.every(model => model.url === `${endpoint.url}/v1/chat/completions`));
  assert.equal(seen.filter(request => request.path === '/api/endpoints').length, 2);
  replies = [{ endpoints: [endpoint] }];
  await assert.rejects(workBuddyModels(auth, options({ ngrokAPI: api, publicURL: 'https://expected.example', requirePublic: true, pollMs: 1, timeoutMs: 20 })), error => error.code === 'public_endpoint_unavailable');
  replies = [{ endpoints: [] }];
  await assert.rejects(workBuddyModels(auth, options({ ngrokAPI: api, requirePublic: true, timeoutMs: 20, pollMs: 1 })), error => error.code === 'public_endpoint_unavailable');
});
test('CLI connection prints valid JSON from saved credentials without exposing OAuth or ngrok tokens', async () => {
  seen = []; replies = [{ endpoints: [endpoint] }];
  const dir = await mkdtemp(join(tmpdir(), 'bridge-connection-'));
  try {
    const stored = new Auth(dir), settings = await stored.init();
    await writeJSON(stored.credentialsPath, { access_token: 'fixture-oauth-access-token', refresh_token: 'fixture-oauth-refresh-token', scopes: ['chatgpt.tokens.use.direct'], expires_at: Date.now() + 600000 });
    const preload = join(dir, 'catalog-fixture.mjs');
    await writeFile(preload, `const upstream = globalThis.fetch; globalThis.fetch = (url, init) => upstream(url === 'https://api.openai.com/v1/models' ? ${JSON.stringify(`${api}/models`)} : url, init);`);
    const run = () => promisify(execFile)(process.execPath, ['--import', preload, 'src/cli.mjs', 'connection', '--data-dir', dir, '--require-public'], {
      env: { ...process.env, BRIDGE_NGROK_API_URL: api, BRIDGE_PUBLIC_URL: '' },
    });
    const { stdout, stderr } = await run();
    const models = JSON.parse(stdout);
    assert.deepEqual(models.map(model => model.id), expectedIds);
    assert.ok(models.every(model => model.url === `${endpoint.url}/v1/chat/completions` && model.apiKey === settings.local_key));
    assert.equal(stderr, '');
    assert.doesNotMatch(stdout, /fixture-oauth|access_token|refresh_token|NGROK_AUTHTOKEN/);
    catalogReply = { models: familyCatalog.models.filter(model => !model.slug.endsWith('-luna')) };
    const partial = await run();
    assert.equal(JSON.parse(partial.stdout).length, 3);
    assert.match(partial.stderr, /no available luna model/);
  } finally { catalogReply = familyCatalog; await rm(dir, { recursive: true, force: true }); }
});

test('version comparison is numeric and independent per family, while invalid/unversioned variants are skipped', () => {
  const selected = latestFamilyModels(['gpt-6.9-sol', 'gpt-6.10-sol', 'gpt-6.10.1-sol', 'gpt-7-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-99-sol-preview', 'gpt-sol-latest'].map(id => ({ id })));
  assert.deepEqual(selected.map(item => item.model.id), ['gpt-7-astra', 'gpt-6.10.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
  assert.equal(upstreamModelId('gpt-6.1-sol-bridge'), 'gpt-6.1-sol');
  assert.equal(upstreamModelId('unrelated-bridge'), 'unrelated-bridge');
});

test('missing families are omitted without inventing models; a catalog with no supported family fails explicitly', async () => {
  seen = [];
  try {
    catalogReply = { models: [{ ...familyCatalog.models[2], slug: 'gpt-7-sol', visibility: 'list' }] };
    assert.deepEqual((await workBuddyModels(auth, options())).map(model => model.id), ['gpt-7-sol-bridge']);
    catalogReply = { models: [{ slug: 'other-model', visibility: 'list' }] };
    await assert.rejects(workBuddyModels(auth, options()), error => error.code === 'models_unavailable');
  } finally { catalogReply = familyCatalog; }
});

test('reasoning options and defaults come from the provider list without adding or dropping effort names', () => {
  assert.deepEqual(modelReasoning({ supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'future_level' }], default_reasoning_level: 'low' }), {
    supportedEfforts: ['low', 'ultra', 'future_level'], defaultEffort: 'low', canDisableThinking: false,
  });
  assert.deepEqual(modelReasoning({ supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }], default_reasoning_level: 'none' }), {
    supportedEfforts: ['none', 'high'], defaultEffort: 'none', canDisableThinking: true,
  });
  assert.equal(modelReasoning({}), null);
  assert.equal(modelReasoning({ supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'medium' }), null);
});

test('missing provider effort metadata fails instead of printing an invented list', async () => {
  seen = [];
  try {
    catalogReply = { models: [{ slug: 'gpt-7-sol', visibility: 'list' }] };
    await assert.rejects(workBuddyModels(auth, options()), error => error.code === 'model_capabilities_unavailable');
  } finally { catalogReply = familyCatalog; }
});
