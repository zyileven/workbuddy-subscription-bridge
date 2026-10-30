import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { createBridge } from '../src/server.mjs';
import { toResponses } from '../src/protocol.mjs';
const { createMock } = createRequire(import.meta.url)('./upstream.cjs');
const key = 'fixture-local-key-at-least-32-characters';
let mock, base, bridge, url;
const auth = { getToken: async () => 'fixture-access' };
const tools = [
  { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
  { type: 'function', function: { name: 'clock', parameters: { type: 'object', properties: {} } } },
];
const messages = [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Hello.' }];
async function send(body = {}, options = {}) {
  return fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...options.headers },
    body: options.raw ?? JSON.stringify({ model: 'fixture-text', messages, ...body }) });
}
function chunks(raw) { return raw.split(/\r?\n\r?\n/).filter(b => b.startsWith('data: ') && !b.includes('[DONE]')).map(b => JSON.parse(b.slice(6))); }
before(async () => {
  mock = createMock(); base = await mock.start();
  bridge = createBridge({ auth, localKey: key, baseURL: base, timeoutMs: 500 });
  await new Promise(r => bridge.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${bridge.address().port}`;
});
after(async () => { bridge.closeAllConnections(); await new Promise(r => bridge.close(r)); await mock.close(); });

test('health needs no key and discloses no credentials', async () => {
  const response = await fetch(`${url}/health`); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'workbuddy-subscription-bridge' });
});
test('model discovery filters the account catalog and uses upstream OAuth, not the local key', async () => {
  const response = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  assert.deepEqual((await response.json()).data.map(m => m.id), ['fixture-text']);
  assert.equal(mock.records.at(-1).headers.authorization, 'Bearer fixture-access');
});
test('unauthenticated requests never reach the upstream', async () => {
  const count = mock.records.length; const response = await send({}, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(response.status, 401); assert.equal(mock.records.length, count);
});
test('browser-origin and DNS-rebinding Host requests are rejected', async () => {
  assert.equal((await send({}, { headers: { Origin: 'https://evil.example' } })).status, 403);
  // Node fetch normalizes Host; use the actual HTTP transport to test rebinding.
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/health`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});
test('invalid JSON and unsupported formats fail before inference', async () => {
  assert.equal((await send({}, { raw: '{broken' })).status, 400);
  assert.equal((await send({ response_format: { type: 'json_schema' } })).status, 400);
  assert.equal((await send({ n: 2 })).status, 400);
});
test('non-stream completion uses the subscription contract and converts usage', async () => {
  const response = await send({ temperature: 0, max_tokens: 10 }); const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.choices[0].message.content, '你好，桥接成功。');
  assert.equal(result.usage.total_tokens, 14); assert.equal(response.headers.get('x-bridge-ignored-parameters'), 'temperature,max_tokens');
  const upstream = mock.records.at(-1).body;
  assert.equal(upstream.store, false); assert.equal(upstream.stream, true); assert.equal(upstream.input[0].role, 'developer');
  assert.equal(upstream.temperature, undefined); assert.equal(upstream.max_tokens, undefined);
});
test('the separate WorkBuddy bridge ID targets the canonical model and preserves response identity', async () => {
  const response = await send({ model: 'gpt-6.1-sol-bridge' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, 'gpt-6.1-sol-bridge');
  assert.equal(mock.records.at(-1).body.model, 'gpt-6.1-sol');
  const direct = toResponses({ model: 'gpt-6.1-sol', messages });
  assert.equal(direct.body.model, 'gpt-6.1-sol');
});
test('SSE survives fragmented UTF-8 and includes terminal usage only on completion', async () => {
  const response = await send({ stream: true, stream_options: { include_usage: true } });
  const raw = await response.text(), data = chunks(raw);
  assert.match(raw, /data: \[DONE\]/); assert.equal(data.flatMap(x => x.choices).map(c => c.delta.content ?? '').join(''), '你好，桥接成功。');
  assert.equal(data.at(-1).usage.total_tokens, 14); assert.equal(data.at(-2).choices[0].finish_reason, 'stop');
});
test('valid SSE without Content-Type completes for both JSON and streaming callers', async () => {
  const plain = await send({ model: 'fixture-no-content-type' });
  assert.equal(plain.status, 200);
  assert.equal((await plain.json()).choices[0].message.content, '你好，桥接成功。');
  const streamed = await send({ model: 'fixture-no-content-type', stream: true });
  const raw = await streamed.text();
  assert.match(raw, /\[DONE\]/);
  assert.equal(chunks(raw).at(-1).choices[0].finish_reason, 'stop');
});
test('missing Content-Type never turns failed, truncated or non-SSE bodies into success', async () => {
  for (const model of ['fixture-no-content-type-fail', 'fixture-no-content-type-drop', 'fixture-no-content-type-html']) {
    const plain = await send({ model });
    assert.ok(plain.status >= 400);
    assert.ok((await plain.json()).error.code);
    const raw = await (await send({ model, stream: true })).text();
    assert.doesNotMatch(raw, /\[DONE\]|"finish_reason":"(?:stop|tool_calls)"/);
    assert.ok(chunks(raw).some(event => event.error));
  }
});
test('an explicit non-SSE Content-Type is still rejected without forwarding its body', async () => {
  const response = await send({ model: 'fixture-wrong-content-type' });
  assert.equal(response.status, 502);
  const raw = await response.text();
  assert.equal(JSON.parse(raw).error.code, 'invalid_upstream_content_type');
  assert.doesNotMatch(raw, /<h1>/);
});
test('empty terminal output uses completed item snapshots for text and function calls', async () => {
  for (const stream of [false, true]) {
    const response = await send({ model: 'fixture-empty-final', stream });
    assert.equal(response.status, 200);
    if (stream) {
      const raw = await response.text();
      assert.match(raw, /\[DONE\]/);
      assert.equal(chunks(raw).flatMap(event => event.choices).map(choice => choice.delta.content ?? '').join(''), '你好，桥接成功。');
    } else assert.equal((await response.json()).choices[0].message.content, '你好，桥接成功。');
  }
  const first = await (await send({ model: 'fixture-empty-final-tools', tools })).json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(first.choices[0].message.tool_calls.map(call => call.function.arguments), ['{"q":"上海"}', '{}']);
  const second = await send({ model: 'fixture-empty-final-tools', tools, messages: [...messages, first.choices[0].message,
    { role: 'tool', tool_call_id: 'call_0', content: 'found' }, { role: 'tool', tool_call_id: 'call_1', content: '12:00' }] });
  assert.equal((await second.json()).choices[0].message.content, 'Tools completed.');
});
test('empty terminal output cannot hide missing or inconsistent completed item snapshots', async () => {
  for (const model of ['fixture-empty-final-inconsistent', 'fixture-empty-final-no-items']) {
    const plain = await send({ model });
    assert.equal(plain.status, 502);
    assert.equal((await plain.json()).error.code, 'inconsistent_stream');
    const raw = await (await send({ model, stream: true })).text();
    assert.match(raw, /inconsistent_stream/);
    assert.doesNotMatch(raw, /\[DONE\]|"finish_reason":"(?:stop|tool_calls)"/);
  }
});
test('parallel function calls retain IDs, argument deltas and tool_calls finish reason', async () => {
  const response = await send({ model: 'fixture-tools', tools, stream: true }); const data = chunks(await response.text());
  const calls = new Map();
  for (const event of data) for (const call of event.choices[0]?.delta.tool_calls ?? []) {
    const current = calls.get(call.index) ?? { id: call.id, name: call.function.name, args: '' };
    current.args += call.function.arguments ?? ''; calls.set(call.index, current);
  }
  assert.deepEqual([...calls.values()], [{ id: 'call_0', name: 'lookup', args: '{"q":"上海"}' }, { id: 'call_1', name: 'clock', args: '{}' }]);
  assert.equal(data.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.equal(mock.records.at(-1).body.tools[0].type, 'namespace');
});
test('a second turn maps tool-result history to namespaced function calls and outputs', async () => {
  const first = await (await send({ model: 'fixture-tools', tools })).json();
  const assistant = first.choices[0].message;
  const response = await send({ model: 'fixture-tools', tools, messages: [...messages, assistant,
    { role: 'tool', tool_call_id: 'call_0', content: 'Found Shanghai.' },
    { role: 'tool', tool_call_id: 'call_1', content: '12:00' }] });
  assert.equal((await response.json()).choices[0].message.content, 'Tools completed.');
  const input = mock.records.at(-1).body.input;
  assert.equal(input[2].namespace, 'workbuddy'); assert.equal(input[2].call_id, 'call_0');
  assert.deepEqual(input[4], { type: 'function_call_output', call_id: 'call_0', output: 'Found Shanghai.' });
});
test('orphan, duplicate and unresolved tool histories are rejected', () => {
  for (const history of [
    [{ role: 'tool', tool_call_id: 'missing', content: 'x' }],
    [{ role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }],
  ]) assert.throws(() => toResponses({ model: 'fixture-text', messages: history }), /tool/i);
});
test('HTTP quota errors preserve code, status, retry delay and request ID without retrying', async () => {
  const count = mock.records.length; const response = await send({ model: 'fixture-429' });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '30');
  assert.equal(response.headers.get('x-request-id'), 'req_fixture_limit');
  assert.equal((await response.json()).error.code, 'subscription_sharing_usage_limit_exceeded');
  assert.equal(mock.records.length, count + 1);
});
test('ineligible accounts and invalid tokens are not retried or silently switched to API billing', async () => {
  for (const [model, status] of [['fixture-403', 403], ['fixture-401', 401], ['fixture-html', 503]]) {
    const count = mock.records.length; const response = await send({ model }); assert.equal(response.status, status);
    assert.equal(mock.records.length, count + 1);
  }
});
test('stream errors, incomplete generation and premature EOF never produce a successful finish or DONE', async () => {
  for (const model of ['fixture-fail', 'fixture-incomplete', 'fixture-drop']) {
    const response = await send({ model, stream: true }); const raw = await response.text();
    assert.doesNotMatch(raw, /\[DONE\]/); assert.doesNotMatch(raw, /"finish_reason":"(?:stop|tool_calls)"/);
    assert.ok(chunks(raw).some(e => e.error));
    const plain = await send({ model }); assert.ok(plain.status >= 400);
  }
});
test('upstream timeout cancels without retrying', async () => {
  const count = mock.records.length, start = Date.now(); const response = await send({ model: 'fixture-slow' });
  assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'upstream_timeout');
  assert.ok(Date.now() - start < 1700); assert.equal(mock.records.length, count + 1);
});
test('refusals and final-only output remain visible to clients', async () => {
  assert.equal((await (await send({ model: 'fixture-refusal' })).json()).choices[0].message.content, 'Cannot help with that.');
  assert.equal((await (await send({ model: 'fixture-final-only' })).json()).choices[0].message.content, 'Final only.');
});
test('text/image conversion preserves message order and never downloads images locally', () => {
  const result = toResponses({ model: 'fixture-text', messages: [
    { role: 'user', content: 'first' }, { role: 'system', content: 'second' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] },
  ] });
  assert.deepEqual(result.body.input.map(m => m.role), ['user', 'developer', 'user']);
  assert.equal(result.body.input[2].content[0].type, 'input_image');
  assert.throws(() => toResponses({ model: 'm', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }), /Unsupported/);
});
test('client cancellation aborts upstream generation', async () => {
  const controller = new AbortController(); const pending = fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-slow', messages }), signal: controller.signal });
  await new Promise(r => setTimeout(r, 50)); controller.abort();
  await assert.rejects(pending, /abort/i);
});
test('local named forced-tool constraints are rejected rather than silently changed', () => {
  assert.throws(() => toResponses({ model: 'm', messages, tools, tool_choice: { type: 'function', function: { name: 'lookup' } } }), /named forced-tool/);
});
