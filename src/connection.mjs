import { BridgeError } from './common.mjs';

function publicOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch {
    throw new BridgeError('Public URL must be an HTTPS origin without credentials, a path, query or fragment.', 400, 'invalid_public_url');
  }
}

function isBridgeUpstream(value) {
  if (typeof value !== 'string') return false;
  try { return new URL(value.includes('://') ? value : `http://${value}`).origin === 'http://bridge:8787'; }
  catch { return false; }
}

export async function workBuddyModel(auth, {
  publicURL = process.env.BRIDGE_PUBLIC_URL ?? '',
  ngrokAPI = process.env.BRIDGE_NGROK_API_URL ?? '',
  requirePublic = false, port = 8787, timeoutMs = 10000, pollMs = 500,
} = {}) {
  const status = await auth.status();
  if (!status.connected) throw new BridgeError('Complete login before printing the WorkBuddy configuration.', 401, 'login_required');
  if (!status.plan_usage_enabled) throw new BridgeError('ChatGPT plan usage was not granted. Reauthorize and enable it.', 403, 'plan_usage_not_granted');
  let origin = publicURL ? publicOrigin(publicURL) : null, discovered = false;
  if (ngrokAPI) {
    const deadline = Date.now() + timeoutMs;
    do {
      try {
        const response = await fetch(`${ngrokAPI.replace(/\/$/, '')}/api/endpoints`, {
          redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
        });
        if (response.ok) {
          const data = await response.json();
          for (const endpoint of Array.isArray(data.endpoints) ? data.endpoints : []) {
            if (!isBridgeUpstream(endpoint.upstream?.url)) continue;
            let candidate; try { candidate = publicOrigin(endpoint.url); } catch { continue; }
            if (origin && candidate !== origin) continue;
            origin = candidate; discovered = true; break;
          }
        } else await response.body?.cancel();
      } catch { /* Agent startup/network errors are retried within the bounded wait. */ }
      if (discovered || !requirePublic || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
  }
  if (requirePublic && (ngrokAPI ? !discovered : !origin)) {
    throw new BridgeError('No active public bridge endpoint. Check NGROK_AUTHTOKEN and `docker compose logs ngrok`, then run `connection --require-public` again. Your saved login is retained.', 503, 'public_endpoint_unavailable');
  }
  origin ??= `http://127.0.0.1:${port}`;
  const { local_key } = await auth.init();
  return {
    id: 'gpt-6.1-sol-bridge', name: 'GPT-6.1 Sol（订阅桥接）',
    vendor: 'Custom', provider: 'openai', api: 'openai-completions',
    url: `${origin}/v1/chat/completions`, apiKey: local_key,
    supportsToolCall: true, supportsImages: true, supportsReasoning: true,
    onlyReasoning: true, useCustomProtocol: true,
    reasoning: { defaultEffort: 'medium', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], canDisableThinking: false },
  };
}
