// Contract fixture for the Docker-private ngrok agent API; no cloud account.
require('node:http').createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' || req.url !== '/api/endpoints') {
    res.writeHead(501); res.end(JSON.stringify({ error: 'not_modeled' })); return;
  }
  res.end(JSON.stringify({ endpoints: [
    { url: 'https://other.ngrok.example', upstream: { url: 'http://other:80' } },
    { url: 'https://fixture-bridge.ngrok.example', upstream: { url: 'http://bridge:8787' }, inspect: false },
  ] }));
}).listen(Number(process.env.PORT || 4011));
