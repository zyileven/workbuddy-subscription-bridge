import { BridgeError } from './common.mjs';
import { listModels } from './server.mjs';
import { latestFamilyModels, modelReasoning } from './models.mjs';

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

export async function workBuddyModels(auth, {
  publicURL = process.env.BRIDGE_PUBLIC_URL ?? '',
  ngrokAPI = process.env.BRIDGE_NGROK_API_URL ?? '',
  requirePublic = false, port = 8787, timeoutMs = 10000, pollMs = 500,
  modelBaseURL = 'https://api.openai.com/v1',
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
  const catalog = await listModels(auth, { baseURL: modelBaseURL, includeMetadata: true });
  const selected = latestFamilyModels(catalog.data);
  if (!selected.length) throw new BridgeError('No Astra, Sol, Terra or Luna model is available in this account catalog. Run `models` to inspect account choices.', 403, 'models_unavailable');
  const { local_key } = await auth.init();
  return selected.map(({ model }) => {
    const reasoning = modelReasoning(model.metadata);
    if (!reasoning) throw new BridgeError(`Account catalog has missing or invalid reasoning capabilities for ${model.id}. No effort list was invented; retry after refreshing the account catalog.`, 502, 'model_capabilities_unavailable');
    const supportsReasoning = reasoning.supportedEfforts.length > 0;
    return {
      id: `${model.id}-bridge`, name: `${model.name || model.id}（订阅桥接）`,
      vendor: 'Custom', provider: 'openai', api: 'openai-completions',
      url: `${origin}/v1/chat/completions`, apiKey: local_key,
      supportsToolCall: true, supportsImages: Array.isArray(model.metadata.input_modalities) ? model.metadata.input_modalities.includes('image') : true,
      supportsReasoning, onlyReasoning: supportsReasoning && !reasoning.canDisableThinking, useCustomProtocol: true,
      ...(supportsReasoning ? { reasoning } : {}),
    };
  });
}
