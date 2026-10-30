#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Auth, login } from './auth.mjs';
import { createBridge, listModels } from './server.mjs';
import { convertResponse } from './protocol.mjs';
import { checkedJSON } from './common.mjs';

const args = process.argv.slice(2), command = args[0] ?? 'help';
function option(name, fallback) {
  const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1];
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const auth = new Auth(resolve(option('data-dir', join(root, '.local'))));
function portOption(name, fallback) {
  const p = Number(option(name, fallback));
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`--${name} must be a port from 1024 to 65535.`);
  return p;
}
function hostOption() {
  const host = option('host', '127.0.0.1');
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('--host must be 127.0.0.1 or 0.0.0.0. Use 0.0.0.0 only with loopback-only Docker port publishing.');
  return host;
}
try {
  if (command === 'init') { await auth.init(); console.log('Local host ID and bridge key created. Use `key` to view the WorkBuddy key.'); }
  else if (command === 'key') console.log((await auth.init()).local_key);
  else if (command === 'status') console.log(JSON.stringify(await auth.status(), null, 2));
  else if (command === 'login') {
    const result = await login(auth, { port: portOption('callback-port', 1455), host: hostOption(),
      onReady: url => console.log(`Continue with ChatGPT in your browser:\n${url}\nWaiting for local callback…`),
      openBrowser: async url => {
        if (args.includes('--no-open')) return;
        const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
        const parameters = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
        const child = spawn(executable, parameters, { stdio: 'ignore', detached: true });
        child.on('error', () => console.log('Open the displayed authorization URL manually.')); child.unref();
      } });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'models') {
    const catalog = await listModels(auth); console.log(JSON.stringify(catalog.data.map(m => ({ slug: m.id, name: m.name })), null, 2));
  } else if (command === 'serve') {
    const host = hostOption(), port = portOption('port', 8787), settings = await auth.init();
    const server = createBridge({ auth, localKey: settings.local_key });
    server.on('error', e => { console.error(`Local listener failed (${e.code ?? 'error'}).`); process.exitCode = 1; });
    server.listen(port, host, () => console.log(`Bridge: http://127.0.0.1:${port}/v1 (listen: ${host})\nChatGPT credentials stay in the bridge.\nUse \`node src/cli.mjs key\` for the local WorkBuddy key.\nCtrl+C stops the bridge.`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
  } else if (command === 'verify') {
    const model = option('model', null); if (!model) throw new Error('Pass --model with a slug returned by the models command. This sends one real inference request.');
    const token = await auth.getToken();
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: [{ role: 'user', content: 'Reply with exactly: Bridge subscription test OK.' }], store: false, stream: true }),
    });
    if (!response.ok) await checkedJSON(response);
    const final = await convertResponse(response, model, new Set());
    console.log(final.choices[0].message.content); console.log('Received response.completed. Confirm the app usage in ChatGPT Settings → Usage.');
  } else if (command === 'logout') { await auth.logout(); console.log('Renewable session revoked and local tokens cleared. Client registration and local key retained.'); }
  else console.log(`WorkBuddy Local Subscription Bridge (Node.js 22+, no npm install)\n\nCommands:\n  init                 Create a private local data directory\n  login                Complete official ChatGPT OAuth in browser\n  status               Show login/permission status without tokens\n  models               Discover account-specific model slugs\n  key                  Print only the local WorkBuddy bearer key\n  serve                Listen on 127.0.0.1:8787\n  verify --model SLUG  Send one real inference to verify access\n  logout               Revoke the renewable session\n\nOptions:\n  --data-dir PATH       Separate private directory for this account\n  --host 127.0.0.1      Listener address; use 0.0.0.0 inside Docker only\n  --port 8787           Local server port\n  --callback-port 1455  OAuth callback port (redirect host stays 127.0.0.1)\n  --no-open             Display authorization URL without opening browser\n\nThis is a personal integration prototype. Actual account eligibility,\nmodel access and quota consumption require browser authorization and a\ncompleted real request. OpenAI API keys are not needed for this flow.`);
} catch (e) {
  // Deliberately do not print raw fetch exceptions, token responses or URLs.
  console.error(`${e.code ?? 'bridge_error'}: ${e.message}`); process.exitCode = 1;
}
