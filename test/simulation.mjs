// Run the real bridge against a separately running Postman HTTP simulation.
import assert from 'node:assert/strict';
import { createBridge } from '../src/server.mjs';
const upstream = process.argv[2];
if (!upstream || !/^http:\/\/127\.0\.0\.1:\d+\/openai$/.test(upstream)) throw new Error('Usage: node test/simulation.mjs http://127.0.0.1:4010/openai');
const key = 'fixture-local-key-at-least-32-characters';
const bridge = createBridge({ auth: { getToken: async () => 'fixture-only-access-token' }, localKey: key, baseURL: upstream, timeoutMs: 500 });
await new Promise(r => bridge.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${bridge.address().port}`;
const messages = [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Hello.' }];
const tools = ['lookup', 'clock'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
const post = body => fetch(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fixture-text', messages, ...body }) });
try {
  const catalog = await (await fetch(`${endpoint}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.deepEqual(catalog.data.map(m => m.id), ['fixture-text']);
  const result = await (await post({ stream: true })).text(); assert.match(result, /你好，桥接成功/); assert.match(result, /\[DONE\]/);
  const called = await (await post({ model: 'fixture-tools', tools })).json(); assert.equal(called.choices[0].message.tool_calls.length, 2);
  const finished = await (await post({ model: 'fixture-tools', tools, messages: [...messages, called.choices[0].message,
    { role: 'tool', tool_call_id: 'call_0', content: 'found' }, { role: 'tool', tool_call_id: 'call_1', content: '12:00' }] })).json();
  assert.equal(finished.choices[0].message.content, 'Tools completed.');
  const limited = await post({ model: 'fixture-429' }); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '30');
  for (const model of ['fixture-fail', 'fixture-drop']) { const raw = await (await post({ model, stream: true })).text(); assert.match(raw, /"error"/); assert.doesNotMatch(raw, /\[DONE\]/); }
  assert.equal((await post({ model: 'fixture-slow' })).status, 502);
  for (const stream of [false, true]) {
    const response = await post({ model: 'fixture-no-content-type', stream });
    assert.equal(response.status, 200);
    if (stream) assert.match(await response.text(), /\[DONE\]/);
    else assert.equal((await response.json()).choices[0].message.content, '你好，桥接成功。');
  }
  for (const model of ['fixture-no-content-type-fail', 'fixture-no-content-type-drop', 'fixture-no-content-type-html', 'fixture-wrong-content-type']) {
    const raw = await (await post({ model, stream: true })).text();
    assert.match(raw, /"error"/);
    assert.doesNotMatch(raw, /\[DONE\]|"finish_reason":"(?:stop|tool_calls)"/);
  }
  const emptyFinal = await (await post({ model: 'fixture-empty-final', stream: true })).text();
  assert.match(emptyFinal, /你好，桥接成功/);
  assert.match(emptyFinal, /\[DONE\]/);
  const inconsistent = await (await post({ model: 'fixture-empty-final-inconsistent', stream: true })).text();
  assert.match(inconsistent, /inconsistent_stream/);
  assert.doesNotMatch(inconsistent, /\[DONE\]|"finish_reason":"(?:stop|tool_calls)"/);
  const inspected = await (await fetch(`${upstream}/inspect`)).json();
  const requests = inspected.records.filter(r => r.path === '/responses');
  assert.equal(requests.length, 15);
  for (const request of requests) { assert.equal(request.body.store, false); assert.equal(request.body.stream, true); assert.ok(Array.isArray(request.body.input)); }
  console.log('Postman HTTP simulation: 16 scenarios passed; 15 inference requests observed by the upstream stand-in.');
  console.log('Verified model discovery, streamed text, parallel tools, tool results, HTTP 429, stream failure, dropped stream, timeout, missing/incorrect Content-Type and empty terminal output handling.');
  console.log('Real OpenAI eligibility, quota consumption and WorkBuddy compatibility remain unverified.');
} finally { bridge.closeAllConnections(); await new Promise(r => bridge.close(r)); }
