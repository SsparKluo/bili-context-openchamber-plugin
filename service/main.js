// billion-context bridge service for the bili-context OpenChamber extension.
//
// Contract (GUEST_SERVICES.md): bind 127.0.0.1:$OPENCHAMBER_SERVICE_PORT,
// require "Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN" on every request,
// answer GET /health with 200. The OpenChamber host proxies panel
// serviceRequest() calls here; the panel itself never sees this port.
//
// Data path: this service dials the billion-context proxy's /__bili/* JSON API.
// The live proxy origin is discovered from bili's own instance records, so any
// bili port (8787 user zone or 18787+ lane zone) works without configuration:
//   1. ~/.local/state/billion-context/proxy-origin   {"origin": "http://127.0.0.1:18787", ...}
//   2. ~/.local/state/billion-context/port-zone.json {"lanes": {"opencode": 18787, ...}}
//   3. fallback http://127.0.0.1:8787

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || '';

if (!PORT) {
  console.error('[bili-context service] OPENCHAMBER_SERVICE_PORT is not set; refusing to start.');
  process.exit(1);
}

const STATE_DIR = join(homedir(), '.local', 'state', 'billion-context');
const DISCOVERY_TTL_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 8_000;

let cachedOrigin = null;
let cachedAt = 0;

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function discoverOrigin() {
  if (cachedOrigin && Date.now() - cachedAt < DISCOVERY_TTL_MS) return cachedOrigin;

  let origin = null;

  // 1. live-instance record (single lane / latest attach)
  const proxyOrigin = readJsonSafe(join(STATE_DIR, 'proxy-origin'));
  if (proxyOrigin && typeof proxyOrigin.origin === 'string') origin = proxyOrigin.origin;

  // 2. lane map (multi-lane: prefer the opencode lane, else the first one)
  if (!origin) {
    const portZone = readJsonSafe(join(STATE_DIR, 'port-zone.json'));
    const lanes = portZone?.lanes;
    if (lanes && typeof lanes === 'object') {
      const port = lanes.opencode ?? Object.values(lanes)[0];
      if (port) origin = `http://127.0.0.1:${port}`;
    }
  }

  // 3. user-zone default (bili start daemon)
  if (!origin) origin = 'http://127.0.0.1:8787';

  cachedOrigin = origin;
  cachedAt = Date.now();
  return origin;
}

function bearerOk(headerValue) {
  if (typeof headerValue !== 'string') return false;
  const expected = `Bearer ${TOKEN}`;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function proxyBili(res, rest) {
  const origin = discoverOrigin();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${origin}/__bili/${rest}`, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(body);
  } catch (err) {
    // Likely a stale origin (bili restarted on a different lane port): drop the
    // cache so the next request re-reads the instance records.
    cachedOrigin = null;
    cachedAt = 0;
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'bili-unreachable',
      origin,
      message: err?.name === 'AbortError' ? `timeout after ${UPSTREAM_TIMEOUT_MS}ms` : String(err?.message ?? err),
    }));
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer((req, res) => {
  if (!bearerOk(req.headers.authorization)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'bili-context' }));
    return;
  }

  // /bili/<rest> -> <origin>/__bili/<rest>
  if (req.method === 'GET' && url.pathname.startsWith('/bili/')) {
    const rest = url.pathname.slice('/bili/'.length) + url.search;
    proxyBili(res, rest);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not-found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bili-context service] listening on 127.0.0.1:${PORT}`);
});
