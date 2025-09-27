// Quantix Pro Backend (Express + WebSocket proxy for Deriv)
// - Serves static frontend
// - Manages per-client Deriv WebSocket sessions (token-based)
// - REST endpoints: /api/session (POST connect/disconnect), /api/buy, /api/sell
// - SSE endpoint: /api/ticks?symbol=R_100 streams ticks to client
// Note: This is a minimal, stateless proxy; don't store tokens server-side beyond process memory.

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DERIV_APP_ID = process.env.DERIV_APP_ID || 1089; // default/fallback

// Keep lightweight in-memory sessions keyed by a random id provided by client
// Each session holds a Deriv WS connection and small state.
const sessions = new Map(); // sessionId => { ws, authorized, currency, loginid, sseClients:Set, lastSubscribeTs:number }

// Token bucket rate limiter per session and action
class TokenBucket {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerSec;
    this.lastRefill = Date.now();
  }
  _refill() {
    const now = Date.now();
    const deltaSec = (now - this.lastRefill) / 1000;
    if (deltaSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + deltaSec * this.refillPerSec);
      this.lastRefill = now;
    }
  }
  take(n = 1) {
    this._refill();
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

const limiters = new Map(); // sessionId => { proposals, buys, sells, subscribe }

function getLimiter(sessionId, key) {
  let m = limiters.get(sessionId);
  if (!m) { m = {}; limiters.set(sessionId, m); }
  if (!m[key]) {
    // Defaults tuned to be conservative; adjust via env if needed
    const defaults = {
      proposals: { capacity: 6, refillPerSec: 3 }, // up to ~3/sec sustained, burst 6
      buys: { capacity: 4, refillPerSec: 3 },      // allow 3x burst comfortably
      sells: { capacity: 3, refillPerSec: 2 },     // similar to buys
      subscribe: { capacity: 1, refillPerSec: 0.5 } // one every 2s
    };
    const cfg = defaults[key] || { capacity: 5, refillPerSec: 2 };
    m[key] = new TokenBucket(cfg);
  }
  return m[key];
}

function createDerivSocket(appIdOverride) {
  const appId = appIdOverride || DERIV_APP_ID;
  const url = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
  const ws = new WebSocket(url);
  return ws;
}

function json(res, code, data) { res.status(code).json(data); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(morgan('tiny'));

// Serve static frontend
app.use(express.static(__dirname));
// SPA fallback for direct route hits
app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/login.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Create/authorize session
// POST /api/session { sessionId, token }
// DELETE /api/session?sessionId=...
app.post('/api/session', (req, res) => {
  const { sessionId, token, appId } = req.body || {};
  if (!sessionId || !token) return json(res, 400, { error: 'sessionId and token required' });

  // Close old session if exists
  const old = sessions.get(sessionId);
  if (old?.ws) { try { old.ws.close(); } catch {} sessions.delete(sessionId); }

  const ws = createDerivSocket(appId);
  const sess = { ws, authorized: false, currency: 'USD', loginid: null, sseClients: new Set(), lastSubscribeTs: 0 };
  sessions.set(sessionId, sess);

  let responded = false;
  const safeRespond = (code, data) => {
    if (!responded) { responded = true; try { json(res, code, data); } catch {} }
  };

  let authTimeout = setTimeout(() => {
    try { ws.close(); } catch {}
    sessions.delete(sessionId);
    safeRespond(504, { error: 'authorize_timeout' });
  }, 15000);

  ws.on('open', () => {
    ws.send(JSON.stringify({ authorize: token }));
  });
  ws.on('message', (buf) => {
    let data; try { data = JSON.parse(buf.toString()); } catch { return; }
    if (data.msg_type === 'authorize') {
      clearTimeout(authTimeout); authTimeout = null;
      if (data.error) {
        try { ws.close(); } catch {}
        sessions.delete(sessionId);
        return safeRespond(401, { error: data.error.message, code: data.error.code });
      }
      sess.authorized = true;
      sess.currency = data.authorize?.currency || 'USD';
      sess.loginid = data.authorize?.loginid || null;
      return safeRespond(200, { ok: true, currency: sess.currency, loginid: sess.loginid });
    }
  });
  ws.on('close', () => {
    sessions.delete(sessionId);
    if (!responded) safeRespond(502, { error: 'upstream_closed' });
  });
  ws.on('error', () => { /* ignore, client sees via 401 path */ });
});

app.delete('/api/session', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return json(res, 400, { error: 'sessionId required' });
  const sess = sessions.get(sessionId);
  if (!sess) return json(res, 200, { ok: true });
  try { sess.ws.close(); } catch {}
  sessions.delete(sessionId);
  return json(res, 200, { ok: true });
});

// Place a trade via session: POST /api/buy { sessionId, request }
app.post('/api/buy', (req, res) => {
  const { sessionId, request } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess || !sess.ws || sess.ws.readyState !== 1 || !sess.authorized) {
    return json(res, 400, { error: 'invalid session or not authorized' });
  }
  // Rate limit per session
  let kind = 'requests';
  if (request && typeof request === 'object') {
    if (request.proposal) kind = 'proposals';
    else if (request.buy) kind = 'buys';
  }
  const bucket = getLimiter(sessionId, kind === 'proposals' ? 'proposals' : (kind === 'buys' ? 'buys' : 'proposals'));
  if (!bucket.take()) {
    res.setHeader('Retry-After', '1');
    return json(res, 429, { error: 'rate_limited', type: kind });
  }
  try {
    sess.ws.send(JSON.stringify(request));
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { error: e?.message || String(e) });
  }
});

// Sell contract: POST /api/sell { sessionId, contract_id }
app.post('/api/sell', (req, res) => {
  const { sessionId, contract_id } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess || !sess.ws || sess.ws.readyState !== 1 || !sess.authorized) {
    return json(res, 400, { error: 'invalid session or not authorized' });
  }
  const bucket = getLimiter(sessionId, 'sells');
  if (!bucket.take()) {
    res.setHeader('Retry-After', '1');
    return json(res, 429, { error: 'rate_limited', type: 'sells' });
  }
  try {
    sess.ws.send(JSON.stringify({ sell: contract_id, price: 0 }));
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { error: e?.message || String(e) });
  }
});

// Stream ticks via SSE using the session connection
app.get('/api/ticks', (req, res) => {
  const sessionId = req.query.sessionId;
  const symbol = req.query.symbol || 'R_100';
  const sess = sessions.get(sessionId);
  if (!sess || !sess.ws || sess.ws.readyState !== 1 || !sess.authorized) {
    return json(res, 400, { error: 'invalid session or not authorized' });
  }
  // Prevent multiple SSE streams per session
  if (sess.sseClients && sess.sseClients.size >= 1) {
    return json(res, 409, { error: 'sse_already_open' });
  }
  // Rate limit subscriptions
  const subLimiter = getLimiter(sessionId, 'subscribe');
  if (!subLimiter.take()) {
    res.setHeader('Retry-After', '2');
    return json(res, 429, { error: 'rate_limited', type: 'subscribe' });
  }
  const now = Date.now();
  if (now - (sess.lastSubscribeTs || 0) < 1000) {
    res.setHeader('Retry-After', '1');
    return json(res, 429, { error: 'subscribe_too_soon' });
  }
  sess.lastSubscribeTs = now;
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Subscribe
  sess.ws.send(JSON.stringify({ forget_all: 'ticks' }));
  sess.ws.send(JSON.stringify({ ticks_history: symbol, count: 20, end: 'latest', style: 'ticks' }));
  sess.ws.send(JSON.stringify({ ticks: symbol }));

  const onMessage = (buf) => {
    let data; try { data = JSON.parse(buf.toString()); } catch { return; }
    if (data.msg_type === 'history' && data.history?.prices) {
      res.write(`event: history\n`);
      res.write(`data: ${JSON.stringify(data.history)}\n\n`);
    }
    if (data.msg_type === 'tick' && data.tick?.quote) {
      res.write(`event: tick\n`);
      res.write(`data: ${JSON.stringify(data.tick)}\n\n`);
    }
  };
  sess.sseClients.add(res);
  const onClose = () => {
    try { sess.ws.off('message', onMessage); } catch {}
    try { res.end(); } catch {}
    try { sess.sseClients.delete(res); } catch {}
  };
  sess.ws.on('message', onMessage);
  req.on('close', onClose);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Stream ALL Deriv messages for a session via SSE
// Frontend can reuse existing message handling by listening to event names = msg_type
app.get('/api/events', (req, res) => {
  const sessionId = req.query.sessionId;
  const sess = sessions.get(sessionId);
  if (!sess || !sess.ws || sess.ws.readyState !== 1 || !sess.authorized) {
    return json(res, 400, { error: 'invalid session or not authorized' });
  }
  if (sess.sseClients && sess.sseClients.size >= 1) {
    return json(res, 409, { error: 'sse_already_open' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sess.sseClients.add(res);
  const onMessage = (buf) => {
    let data; try { data = JSON.parse(buf.toString()); } catch { return; }
    const type = data.msg_type || 'deriv';
    try {
      // Named event for selective listeners
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      // Default message event for generic listeners
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };
  const onClose = () => {
    try { sess.ws.off('message', onMessage); } catch {}
    try { res.end(); } catch {}
    try { sess.sseClients.delete(res); } catch {}
  };
  sess.ws.on('message', onMessage);
  req.on('close', onClose);
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Quantix Pro backend listening on :${PORT}`);
});
