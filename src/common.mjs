import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export class BridgeError extends Error {
  constructor(message, status = 400, code = 'invalid_request', extra = {}) {
    super(message); Object.assign(this, { status, code }, extra);
  }
}
export const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const random = () => randomBytes(32).toString('base64url');
export const ensureDir = async dir => { await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700); };
export async function readJSON(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function writeJSON(path, value) {
  const tmp = `${path}.${random()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}
export async function locked(dir, task) {
  await ensureDir(dir);
  const lock = join(dir, '.auth.lock'), until = Date.now() + 12000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > until) throw new BridgeError('Credential store is busy. Stop other bridge/login processes; remove a stale .auth.lock only after checking none is running.', 503, 'credential_store_busy');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await task(); } finally { await rm(lock, { recursive: true, force: true }); }
}
export function errorBody(e) {
  return { error: { message: e.message, type: e.status >= 500 ? 'upstream_error' : 'invalid_request_error', code: e.code ?? 'bridge_error', ...(e.param ? { param: e.param } : {}) } };
}
export async function checkedJSON(response) {
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  if (!response.ok) {
    // Do not forward untrusted upstream text, which could echo a credential.
    const code = typeof data?.error?.code === 'string' ? data.error.code : typeof data?.error === 'string' ? data.error : 'upstream_http_error';
    throw new BridgeError(`Upstream returned HTTP ${response.status}. See error code and request ID; no automatic retry.`, response.status,
      code, {
        param: data?.error?.param,
        requestId: response.headers.get('x-request-id'), retryAfter: response.headers.get('retry-after'),
      });
  }
  if (!data || typeof data !== 'object') throw new BridgeError('Upstream returned invalid JSON.', 502, 'invalid_upstream_json');
  return data;
}
export async function* sseEvents(body) {
  if (!body) throw new BridgeError('Missing upstream stream.', 502, 'missing_stream');
  const decoder = new TextDecoder(); let buffer = '';
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    if (buffer.length > 4 * 1024 * 1024) throw new BridgeError('Upstream event exceeds 4 MiB.', 502, 'event_too_large');
    let m;
    while ((m = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, m.index); buffer = buffer.slice(m.index + m[0].length);
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') continue;
      let event; try { event = JSON.parse(data); } catch { throw new BridgeError('Malformed upstream SSE event.', 502, 'invalid_upstream_event'); }
      yield event;
    }
  }
  if (buffer.trim()) throw new BridgeError('Upstream stream ended inside an event.', 502, 'truncated_stream');
}
