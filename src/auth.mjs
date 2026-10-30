import { createServer } from 'node:http';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError, checkedJSON, equal, locked, random, readJSON, writeJSON } from './common.mjs';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const SCOPE = 'chatgpt.tokens.use.direct';
const b64json = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export class Auth {
  constructor(dir, { issuer = ISSUER, resource = RESOURCE, fetcher = fetch } = {}) {
    Object.assign(this, { dir, issuer, resource, fetcher });
    this.credentialsPath = join(dir, 'credentials.json');
    this.settingsPath = join(dir, 'settings.json');
  }
  async init() {
    return locked(this.dir, async () => {
      let settings = await readJSON(this.settingsPath);
      if (!settings) {
        settings = { host_id: `urn:uuid:${randomUUID()}`, local_key: random(), client_id: null };
        await writeJSON(this.settingsPath, settings);
      }
      return settings;
    });
  }
  async request(url, init = {}) {
    try {
      return await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
    } catch {
      throw new BridgeError('OpenAI authentication connection failed or timed out.', 502, 'auth_network_error');
    }
  }
  async metadata() {
    const d = await checkedJSON(await this.request(`${this.issuer}/.well-known/openid-configuration`));
    if (d.issuer !== this.issuer || !d.jwks_uri || new URL(d.jwks_uri).origin !== this.issuer) {
      throw new BridgeError('Unexpected OpenID issuer or JWKS origin.', 502, 'invalid_openid_configuration');
    }
    return d;
  }
  async verifyIdentity(jwt, clientId, nonce) {
    try {
      if (typeof jwt !== 'string' || jwt.length > 65536) throw new Error();
      const parts = jwt.split('.'); if (parts.length !== 3) throw new Error();
      const header = b64json(parts[0]), claims = b64json(parts[1]);
      // RS256/ES256 only. Never trust alg or jku to select a remote key source.
      if (!['RS256', 'ES256'].includes(header.alg) || !header.kid || header.crit) throw new Error();
      const meta = await this.metadata();
      const jwks = await checkedJSON(await this.request(meta.jwks_uri));
      const key = jwks.keys?.find(k => k.kid === header.kid && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg));
      if (!key || (header.alg === 'RS256' ? key.kty !== 'RSA' : key.kty !== 'EC' || key.crv !== 'P-256')) throw new Error();
      const pub = createPublicKey({ key, format: 'jwk' });
      const options = header.alg === 'ES256' ? { key: pub, dsaEncoding: 'ieee-p1363' } : pub;
      if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), options, Buffer.from(parts[2], 'base64url'))) throw new Error();
      const now = Date.now() / 1000, audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== this.issuer || !audience.includes(clientId) || !claims.sub ||
          typeof claims.exp !== 'number' || claims.exp <= now ||
          (claims.nbf !== undefined && claims.nbf > now + 30) ||
          (claims.iat !== undefined && claims.iat > now + 30) ||
          (audience.length > 1 && claims.azp !== clientId) ||
          (nonce !== undefined && !equal(claims.nonce, nonce))) throw new Error();
      return claims;
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError('ID token signature or identity validation failed.', 401, 'invalid_id_token');
    }
  }
  async tokenRequest(params) {
    return checkedJSON(await this.request(`${this.issuer}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    }));
  }
  tokenRecord(tokens, identity, clientId, previous = {}) {
    if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
        !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
        (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')) {
      throw new BridgeError('OAuth token response is incomplete.', 502, 'invalid_token_response');
    }
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : previous.scopes ?? [];
    return {
      ...previous, client_id: clientId, subject: identity.sub, issuer: identity.iss,
      email: identity.email, access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? previous.refresh_token,
      id_token: tokens.id_token ?? previous.id_token,
      scopes, expires_at: Date.now() + tokens.expires_in * 1000,
    };
  }
  async beginLogin(redirectUri) {
    const settings = await this.init();
    const state = random(), nonce = random(), verifier = random();
    const clientId = settings.client_id ?? 'dynamic_agent_client';
    const params = {
      client_id: clientId, ext_agent_host_id: settings.host_id,
      response_type: 'code', redirect_uri: redirectUri, resource: this.resource,
      scope: SCOPES, state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
    if (clientId === 'dynamic_agent_client') params.agent_name_hint = 'WorkBuddy Local Subscription Bridge';
    return { state, nonce, verifier, clientId, redirectUri, url: `${this.issuer}/api/accounts/authorize?${new URLSearchParams(params)}` };
  }
  async completeLogin(attempt, query) {
    if (!equal(query.get('state'), attempt.state)) throw new BridgeError('OAuth state mismatch.', 400, 'invalid_state');
    if (query.has('error')) throw new BridgeError('OpenAI authorization was declined or failed.', 403, 'authorization_declined');
    const code = query.get('code'), supplied = query.get('client_id');
    const clientId = attempt.clientId === 'dynamic_agent_client' ? supplied : attempt.clientId;
    if (!code || !clientId || clientId === 'dynamic_agent_client' ||
        (attempt.clientId !== 'dynamic_agent_client' && supplied && supplied !== attempt.clientId)) {
      throw new BridgeError('Missing authorization code or unexpected issued client ID.', 400, 'incomplete_registration');
    }
    return locked(this.dir, async () => {
      const settings = await readJSON(this.settingsPath);
      if (settings.client_id && settings.client_id !== clientId) throw new BridgeError('A different registration is active in this directory.', 409, 'registration_conflict');
      // Retain the issued registration even if code exchange later fails.
      await writeJSON(this.settingsPath, { ...settings, client_id: clientId });
      const tokens = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId,
        code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: this.resource });
      const identity = await this.verifyIdentity(tokens.id_token, clientId, attempt.nonce);
      const previous = await readJSON(this.credentialsPath);
      if (previous && previous.subject !== identity.sub) throw new BridgeError('Login identity differs from the saved account; use a separate data directory.', 409, 'account_mismatch');
      const record = this.tokenRecord(tokens, identity, clientId);
      if (!record.refresh_token) throw new BridgeError('No refresh token was issued.', 502, 'missing_refresh_token');
      await writeJSON(this.credentialsPath, record);
      return { connected: true, plan_usage_enabled: record.scopes.includes(SCOPE) };
    });
  }
  async status() {
    const record = await readJSON(this.credentialsPath);
    return { connected: Boolean(record), plan_usage_enabled: Boolean(record?.scopes?.includes(SCOPE)),
      expired: record ? record.expires_at <= Date.now() : null };
  }
  async getToken() {
    const current = await readJSON(this.credentialsPath);
    if (!current) throw new BridgeError('Run node src/cli.mjs login first.', 401, 'login_required');
    if (!current.scopes?.includes(SCOPE)) throw new BridgeError('ChatGPT plan usage was not granted. Reauthorize and enable it.', 403, 'plan_usage_not_granted');
    if (current.expires_at > Date.now() + 60000) return current.access_token;
    return locked(this.dir, async () => {
      const record = await readJSON(this.credentialsPath);
      if (!record) throw new BridgeError('Login is required.', 401, 'login_required');
      if (!record.scopes?.includes(SCOPE)) throw new BridgeError('Plan usage permission is missing.', 403, 'plan_usage_not_granted');
      if (record.expires_at > Date.now() + 60000) return record.access_token;
      const tokens = await this.tokenRequest({ grant_type: 'refresh_token', client_id: record.client_id,
        refresh_token: record.refresh_token, resource: this.resource });
      const identity = tokens.id_token ? await this.verifyIdentity(tokens.id_token, record.client_id) : { sub: record.subject, iss: record.issuer, email: record.email };
      if (identity.sub !== record.subject) throw new BridgeError('Refreshed identity changed.', 401, 'account_mismatch');
      const updated = this.tokenRecord(tokens, identity, record.client_id, record);
      await writeJSON(this.credentialsPath, updated);
      if (!updated.scopes.includes(SCOPE)) throw new BridgeError('Plan usage permission was removed.', 403, 'plan_usage_not_granted');
      return updated.access_token;
    });
  }
  async logout() {
    return locked(this.dir, async () => {
      const record = await readJSON(this.credentialsPath);
      if (!record) return;
      const meta = await this.metadata();
      if (!meta.revocation_endpoint || new URL(meta.revocation_endpoint).origin !== this.issuer) throw new BridgeError('Invalid revocation endpoint.', 502, 'invalid_openid_configuration');
      const response = await this.request(meta.revocation_endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: record.refresh_token, token_type_hint: 'refresh_token', client_id: record.client_id }) });
      if (!response.ok) throw new BridgeError('Remote revocation failed; local tokens retained so you can retry.', 502, 'revocation_failed');
      const { rm } = await import('node:fs/promises'); await rm(this.credentialsPath, { force: true });
    });
  }
}

export async function login(auth, { port = 1455, host = '127.0.0.1', openBrowser = () => {}, onReady = () => {} } = {}) {
  const callback = '/auth/callback';
  let resolveResult, rejectResult, attempt, claimed = false;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Avoid an unhandled rejection if startup fails before awaiting result.
  result.catch(() => {});
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://127.0.0.1');
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (!attempt || req.method !== 'GET' || req.headers.host !== expectedHost || url.pathname !== callback ||
        !equal(url.searchParams.get('state'), attempt.state) || ['state', 'code', 'client_id', 'error'].some(k => url.searchParams.getAll(k).length > 1)) {
      res.writeHead(400); res.end('Invalid callback.'); return;
    }
    if (claimed) { res.writeHead(409); res.end('Callback already received.'); return; }
    claimed = true;
    try {
      const value = await auth.completeLogin(attempt, url.searchParams);
      res.end(value.plan_usage_enabled ? 'Connected. You can close this window.' : 'Connected, but ChatGPT plan usage was not granted.');
      resolveResult(value);
    } catch (e) { res.writeHead(400); res.end('Authorization failed. See the local terminal.'); rejectResult(e); }
  });
  // Docker listens on its container interface; the browser redirect stays loopback.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const timer = setTimeout(() => rejectResult(new BridgeError('Browser authorization timed out after 10 minutes.', 408, 'login_timeout')), 600000);
  try {
    attempt = await auth.beginLogin(`http://127.0.0.1:${server.address().port}${callback}`);
    await onReady(attempt.url); await openBrowser(attempt.url);
    return await result;
  } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
