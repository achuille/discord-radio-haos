import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const normalizePeer = address => (address || '').replace(/^::ffff:/, '');
export function permittedPeer(address, { dev = false, health = false } = {}) {
  const peer = normalizePeer(address);
  const loopback = peer === '127.0.0.1' || peer === '::1';
  return dev ? loopback : peer === '172.30.32.2' || (health && loopback);
}
const fail = (status, message) => Object.assign(new Error(message), { status });
async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'JSON required');
  if (Number(req.headers['content-length']) > 8192) throw fail(413, 'Request too large');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw fail(413, 'Request too large'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw 0; return value; }
  catch { throw fail(400, 'Invalid JSON object'); }
}
export function createServer({ app, publicDir, dev = false, rateLimit = 120, now = Date.now }) {
  const csrfToken = randomBytes(32).toString('hex');
  let windowStart = now(), requests = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://radio.local');
      const route = url.pathname;
      const health = route === '/health' && req.method === 'GET';
      if (!permittedPeer(req.socket.remoteAddress, { dev, health })) return send(403, { error: 'Forbidden' });
      if (dev && !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || '')) return send(403, {error:'Forbidden host'});
      if (health) return send(200, { ok: true });
      if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
      if (++requests > rateLimit) return send(429, { error: 'Too many requests' });
      if (req.method === 'GET' && route === '/api/status') return send(200, { ...app.status(), csrfToken });
      if (['POST', 'DELETE'].includes(req.method)) {
        const token = Buffer.from(String(req.headers['x-csrf-token'] || ''));
        const expected = Buffer.from(csrfToken);
        if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw fail(403, 'Invalid request token');
        const body = await jsonBody(req);
        if (req.method === 'POST' && route === '/api/control') {
          if (!['pause', 'resume', 'skip', 'volume'].includes(body.action) || (body.action === 'volume' && (typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value < 0 || body.value > 1))) throw fail(400, 'Invalid control');
          await app.control(body.action, body.value); return send(200, { ok: true });
        }
        if (req.method === 'POST' && route === '/api/sources') {
          if (typeof body.url !== 'string' || body.url.length > 2048) throw fail(400, 'Invalid source URL');
          const source = await app.addSource(body.url); return send(201, { source });
        }
        const match = route.match(/^\/api\/sources\/([a-zA-Z0-9_-]{1,80})$/);
        if (req.method === 'DELETE' && match) { await app.removeSource(match[1]); return send(200, { ok: true }); }
        if (req.method === 'POST' && route === '/api/sync') {
          if (body.id !== undefined && (typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.id))) throw fail(400, 'Invalid source');
          app.sync(body.id); return send(202, { ok: true });
        }
      }
      const assets = { '/app.css': ['app.css', 'text/css'], '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
      if (req.method === 'GET' && assets[route]) {
        const [file, type] = assets[route];
        const data = await readFile(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(data);
      }
      return send(404, { error: 'Not found' });
    } catch (error) { if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Request could not be completed' }); else res.end(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return server;
}
export async function listen(server, { dev = false, port = 8080 } = {}) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, dev ? '127.0.0.1' : '0.0.0.0', () => { server.off('error', reject); resolve(); }); });
  return server.address();
}
