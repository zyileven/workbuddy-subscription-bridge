import { createServer } from 'node:http';
import { BridgeError, checkedJSON, equal, errorBody } from './common.mjs';
import { toResponses, convertResponse } from './protocol.mjs';

function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = e => { cleanup(); reject(e); };
    const aborted = () => error(new BridgeError('Request aborted.', 400, 'request_aborted'));
    const data = b => {
      size += b.length;
      if (size > limit) { cleanup(); req.resume(); reject(new BridgeError('Request body exceeds 16 MiB.', 413, 'body_too_large')); }
      else chunks.push(b);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new BridgeError('Invalid JSON body.', 400, 'invalid_json')); }
    };
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
  });
}
async function write(res, value) {
  if (res.destroyed) throw new BridgeError('Client disconnected.', 499, 'client_disconnected');
  if (!res.write(value)) await new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drain); res.off('close', close); res.off('error', error); };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(new BridgeError('Client disconnected.', 499, 'client_disconnected')); };
    const error = () => { cleanup(); reject(new BridgeError('Client stream failed.', 499, 'client_disconnected')); };
    res.once('drain', drain); res.once('close', close); res.once('error', error);
  });
}

export async function listModels(auth, { baseURL = 'https://api.openai.com/v1', fetcher = fetch, signal = AbortSignal.timeout(20000), includeMetadata = false } = {}) {
  const token = await auth.getToken();
  const data = await checkedJSON(await fetcher(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal,
  }));
  const list = Array.isArray(data.models) ? data.models.filter(m => m.visibility === 'list') : data.data;
  if (!Array.isArray(list)) throw new BridgeError('Unexpected account model catalog.', 502, 'invalid_model_catalog');
  return { object: 'list', data: list.map(m => ({ id: m.slug ?? m.id, object: 'model', created: 0, owned_by: 'openai', name: m.display_name ?? m.id ?? m.slug,
    ...(includeMetadata ? { metadata: m } : {}) })) };
}

export function createBridge({ auth, localKey, baseURL = 'https://api.openai.com/v1', fetcher = fetch, timeoutMs = 300000, maxConcurrent = 4 } = {}) {
  if (!auth || typeof localKey !== 'string' || localKey.length < 24) throw new Error('Auth and a strong local key are required.');
  let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const controller = new AbortController();
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    const timer = setTimeout(() => controller.abort(new Error('Upstream deadline exceeded.')), timeoutMs);
    let acquired = false;
    try {
      const allowedHosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new BridgeError('Invalid Host header.', 403, 'invalid_host');
      // WorkBuddy is a native client. No browser-origin requests or permissive CORS.
      if (req.headers.origin) throw new BridgeError('Browser-origin requests are not accepted.', 403, 'invalid_origin');
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === '/health') { json(res, 200, { status: 'ok', service: 'workbuddy-subscription-bridge' }); return; }
      if (!equal(req.headers.authorization, `Bearer ${localKey}`)) throw new BridgeError('Missing or invalid local bridge key.', 401, 'invalid_local_key');
      if (req.method === 'GET' && path === '/v1/models') { json(res, 200, await listModels(auth, { baseURL, fetcher, signal: controller.signal })); return; }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') throw new BridgeError('Unknown local bridge endpoint.', 404, 'not_found');
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new BridgeError('Content-Type must be application/json.', 415, 'unsupported_media_type');
      const request = await readBody(req, 16 * 1024 * 1024);
      const { body, ignored, names } = toResponses(request);
      if (active >= maxConcurrent) throw new BridgeError('Local concurrency limit reached; retry after active tasks finish.', 429, 'bridge_busy', { retryAfter: '5' });
      acquired = true; active++;
      const token = await auth.getToken();
      const upstream = await fetcher(`${baseURL}/responses`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body), redirect: 'error', signal: controller.signal });
      const requestId = upstream.headers.get('x-request-id'); if (requestId) res.setHeader('x-request-id', requestId);
      if (!upstream.ok) await checkedJSON(upstream);
      // Some response paths omit Content-Type even for SSE. Let the event
      // parser validate those bodies; response.completed is still mandatory.
      const upstreamContentType = upstream.headers.get('content-type');
      if (upstreamContentType && !/^text\/event-stream(?:;|$)/i.test(upstreamContentType)) {
        await upstream.body?.cancel(); throw new BridgeError('Expected an SSE response from OpenAI.', 502, 'invalid_upstream_content_type');
      }
      if (ignored.length) res.setHeader('x-bridge-ignored-parameters', ignored.join(','));
      if (request.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        const final = await convertResponse(upstream, request.model, names, c => write(res, `data: ${JSON.stringify(c)}\n\n`));
        if (request.stream_options?.include_usage && final.usage) {
          await write(res, `data: ${JSON.stringify({ id: final.id, object: 'chat.completion.chunk', created: final.created, model: final.model, choices: [], usage: final.usage })}\n\n`);
        }
        await write(res, 'data: [DONE]\n\n'); res.end();
      } else json(res, 200, await convertResponse(upstream, request.model, names));
    } catch (raw) {
      const e = raw instanceof BridgeError ? raw : new BridgeError(controller.signal.aborted ? 'Upstream request timed out or the client disconnected.' : 'Upstream connection failed.', 502, controller.signal.aborted ? 'upstream_timeout' : 'upstream_network_error');
      if (res.destroyed) return;
      if (!res.headersSent) {
        if (e.requestId) res.setHeader('x-request-id', e.requestId);
        if (e.retryAfter) res.setHeader('retry-after', e.retryAfter);
        json(res, e.status, errorBody(e));
      } else { await write(res, `data: ${JSON.stringify(errorBody(e))}\n\n`).catch(() => {}); res.end(); }
    } finally {
      clearTimeout(timer); if (acquired) active--;
      req.off('aborted', abort); res.off('close', abort);
    }
  });
  server.headersTimeout = 15000; server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  return server;
}
