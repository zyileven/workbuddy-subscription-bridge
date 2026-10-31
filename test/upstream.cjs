const http = require('node:http');
const { generateKeyPairSync, sign } = require('node:crypto');

function createMock() {
  const records = [], controls = { nonce: '', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', refreshes: 0 };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  let base;
  const jwt = (overrides = {}) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: base, aud: 'oaiapp_fixture', sub: 'fixture-user',
      exp: Math.floor(Date.now() / 1000) + 3600, nonce: controls.nonce, ...overrides })).toString('base64url');
    return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    if (req.body !== undefined) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    else for await (const chunk of req) raw += chunk;
    let data; try { data = JSON.parse(raw); } catch { data = null; }
    const path = new URL(req.url, 'http://fixture').pathname;
    records.push({ path, method: req.method, body: data ?? raw, headers: req.headers });
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (path === '/.well-known/openid-configuration') return json(200, { issuer: base, jwks_uri: `${base}/jwks`, revocation_endpoint: `${base}/revoke` });
    if (path === '/jwks') return json(200, { keys: [jwk] });
    if (path === '/inspect') return json(200, { records });
    if (path === '/revoke') { res.writeHead(200); return res.end(); }
    if (path === '/api/accounts/oauth/token') {
      const params = new URLSearchParams(raw), refresh = params.get('grant_type') === 'refresh_token';
      if (refresh) controls.refreshes++;
      return json(200, { access_token: `fixture-access-${controls.refreshes}`, refresh_token: `fixture-refresh-${controls.refreshes}`,
        token_type: 'Bearer', expires_in: 3600, scope: controls.scope,
        ...(!refresh ? { id_token: jwt() } : {}) });
    }
    if (path === '/models') return json(200, { models: [
      { slug: 'fixture-text', display_name: 'Fixture text', visibility: 'list' },
      { slug: 'fixture-hidden', display_name: 'Hidden', visibility: 'hidden' },
    ] });
    if (path === '/family/models') return json(200, { models: [
      { slug: 'gpt-5.6-sol', display_name: 'Older Sol', visibility: 'list' },
      ...['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].map(slug => ({
        slug, display_name: slug, visibility: 'list', input_modalities: ['text', 'image'],
        default_reasoning_level: slug.endsWith('-sol') || slug.endsWith('-terra') ? 'low' : 'medium',
        supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', ...(!slug.endsWith('-luna') ? ['ultra'] : [])].map(effort => ({ effort })),
      })),
      { slug: 'gpt-99-astra', display_name: 'Hidden future fixture', visibility: 'hidden' },
    ] });
    if (path !== '/responses' || req.method !== 'POST') return json(501, { error: { code: 'not_modeled' } });
    if (data.model === 'fixture-429') return json(429, { error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { 'Retry-After': '30', 'x-request-id': 'req_fixture_limit' });
    if (data.model === 'fixture-403') return json(403, { error: { code: 'subscription_sharing_user_not_eligible' } });
    if (data.model === 'fixture-401') return json(401, { error: { code: 'invalid_token' } });
    if (data.model === 'fixture-html') { res.writeHead(503, { 'Content-Type': 'text/html' }); return res.end('<h1>Upstream unavailable</h1>'); }
    if (data.model === 'fixture-slow') { const timer = setTimeout(() => json(503, {}), 2000); res.on('close', () => clearTimeout(timer)); return; }
    if (data.model === 'fixture-wrong-content-type') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>Not an event stream</h1>'); }
    const omitContentType = data.model.startsWith('fixture-no-content-type');
    res.writeHead(200, { ...(!omitContentType ? { 'Content-Type': 'text/event-stream' } : {}), 'x-request-id': 'req_fixture' });
    if (data.model === 'fixture-no-content-type-html') return res.end('<h1>Not an event stream</h1>');
    const events = [];
    let output = [];
    const add = (type, other = {}) => events.push({ type, ...other });
    const text = value => { add('response.output_text.delta', { item_id: 'msg_fixture', delta: value }); output.push({ type: 'message', content: [{ type: 'output_text', text: value }] }); };
    const tool = (n, name, args) => {
      const item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, namespace: 'workbuddy', name, arguments: '' };
      add('response.output_item.added', { output_index: n, item });
      add('response.function_call_arguments.delta', { item_id: item.id, delta: args.slice(0, 3) });
      add('response.function_call_arguments.delta', { item_id: item.id, delta: args.slice(3) });
      add('response.function_call_arguments.done', { item_id: item.id, arguments: args });
      const finished = { ...item, arguments: args };
      add('response.output_item.done', { item: finished }); output.push(finished);
    };
    if (['fixture-fail', 'fixture-no-content-type-fail'].includes(data.model)) add('response.failed', { response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded' } } });
    else if (data.model === 'fixture-incomplete') add('response.incomplete', { response: { status: 'incomplete' } });
    else if (['fixture-drop', 'fixture-no-content-type-drop'].includes(data.model)) text('partial');
    else if (['fixture-tools', 'fixture-empty-final-tools'].includes(data.model) && !data.input.some(i => i.type === 'function_call_output')) {
      tool(0, 'lookup', '{"q":"上海"}'); tool(1, 'clock', '{}');
    } else if (data.model === 'fixture-refusal') {
      add('response.refusal.delta', { delta: 'Cannot help with that.' }); output.push({ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help with that.' }] });
    } else if (data.model === 'fixture-final-only') output.push({ type: 'message', content: [{ type: 'output_text', text: 'Final only.' }] });
    else text(data.input.some(i => i.type === 'function_call_output') ? 'Tools completed.' : '你好，桥接成功。');
    const emptyFinal = data.model.startsWith('fixture-empty-final');
    if (emptyFinal && data.model !== 'fixture-empty-final-no-items') {
      for (const [output_index, item] of output.entries()) {
        add('response.output_item.done', { output_index, item: { id: `msg_final_${output_index}`, ...item,
          ...(data.model === 'fixture-empty-final-inconsistent' ? { content: [{ type: 'output_text', text: 'Different output.' }] } : {}) } });
      }
    }
    if (!['fixture-fail', 'fixture-drop', 'fixture-incomplete', 'fixture-no-content-type-fail', 'fixture-no-content-type-drop'].includes(data.model)) add('response.completed', { response: { id: 'resp_fixture', status: 'completed', output: emptyFinal ? [] : output,
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 2 } } } });
    const bytes = Buffer.from(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
    // Split inside JSON, CRLF and UTF-8 characters, as real TCP streams may do.
    for (let i = 0; i < bytes.length && !res.destroyed; i += 13) { res.write(bytes.subarray(i, i + 13)); await new Promise(r => setImmediate(r)); }
    res.end();
  });
  return { server, records, controls, jwt,
    start: async (port = 0) => { await new Promise(r => server.listen(port, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; return base; },
    close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); },
  };
}
module.exports = { createMock };
if (require.main === module) createMock().start(Number(process.env.PORT || 4010));
