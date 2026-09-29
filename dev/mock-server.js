// Local stand-in for the Google Apps Script backend.
// Serves the site from the repo root and runs the REAL api.js + engine.js against an
// in-memory store, so the whole draft can be rehearsed before deploying.
//
//   node dev/mock-server.js [port]         → http://localhost:8751
//   admin key is "dev"; add ?api=local to the site URL (config.js does this on localhost)
//   MOCK_LATENCY=700 simulates Apps Script's slow responses
//   POST /__reset clears the store; POST /__seed adds fake players

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8751);
const LATENCY = Number(process.env.MOCK_LATENCY || 250);

let store = {};
let cache = {};

const Platform = {
  storeLoadAll: () => JSON.parse(JSON.stringify(store)),
  storeSet: (k, v) => {
    const json = JSON.stringify(v);
    if (json.length > 49000) throw new Error('value_too_large:' + k);
    store[k] = JSON.parse(json);
  },
  backup: () => {},
  cachePut: (body, meta, ns) => { cache[ns || ''] = { body, meta }; },
  cacheGet: (ns) => cache[ns || ''] || null,
  cacheClear: (ns) => { delete cache[ns || '']; },
  withLock: (label, fn) => fn(),     // node is single-threaded: requests never interleave
  tryWithLock: (ms, label, fn) => fn(),
  adminKey: () => 'dev',
  json: (obj) => ({ body: JSON.stringify(obj) }),
  raw: (str) => ({ body: str })
};

const ctx = { Platform, console, Math, Date, JSON };
vm.createContext(ctx);
for (const f of ['cast.js', 'engine.js', 'apps-script/api.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^if \(typeof module.*$/m, ''), ctx, { filename: f });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function seed(n) {
  const names = ['Will Taylor', 'Jim', 'James Baumer', 'Ryan Thaxton', 'Martina Probst', 'Jarrard', 'Matt Jennings', 'Henry Evans', 'M Ragazz', 'Test Ten', 'Test Eleven'];
  for (let i = 0; i < n; i++) {
    const name = names[i] || 'Player ' + (i + 1);
    const email = name.toLowerCase().replace(/[^a-z]/g, '') + '@example.com';
    ctx.doPost({ postData: { contents: JSON.stringify({ action: 'join', name, email }) } });
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type) => {
    setTimeout(() => {
      res.writeHead(code, { 'Content-Type': type || 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(body);
    }, url.pathname === '/api' ? LATENCY : 0);
  };

  if (url.pathname === '/__reset' && req.method === 'POST') { store = {}; cache = {}; return send(200, '{"ok":true}'); }
  if (url.pathname === '/__seed' && req.method === 'POST') { seed(Number(url.searchParams.get('n') || 9)); return send(200, '{"ok":true}'); }
  if (url.pathname === '/__dump') return send(200, JSON.stringify(store, null, 2));

  if (url.pathname === '/api') {
    if (req.method === 'GET') {
      const out = ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
      return send(200, out.body);
    }
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const out = ctx.doPost({ postData: { contents: data } });
      send(200, out.body);
    });
    return;
  }

  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) return send(403, 'no', 'text/plain');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return send(404, 'not found', 'text/plain');
  send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}).listen(PORT, () => console.log(`Survivor 51 mock server on http://localhost:${PORT}  (admin key: dev)`));
