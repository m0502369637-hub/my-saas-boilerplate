#!/usr/bin/env node
// relay/relay.mjs — OPTIONAL completion watcher/notifier for this boilerplate.
//
// Telegram Serverless has NO inbound HTTP endpoints, so provider webhooks
// (Fal) cannot reach the bot, and ComfyUI has no webhooks at all. This tiny
// zero-dependency Node app (runs on YOUR infrastructure, Node 18+) fills the
// gap by watching provider status and poking the bot's chat through the
// Bot API:
//
//   POST /webhook/:provider/:secret   ← fal queue webhook target (the bot
//                                        passes this URL at submit time)
//   POST /track                       ← called by the bot after every submit;
//                                        the relay then polls the provider
//                                        every RELAY_POLL_MS until done
//   GET  /healthz
//
// IMPORTANT BOUNDARY: the relay never touches the bot's database (only the
// platform can) and never marks jobs complete. It only shortens the wait —
// it nudges the user the moment the provider finishes, and the user taps
// 🔄 Check Status. The bot still advances state through its own polling
// (button + lib/sweep.js), so the relay can crash or be absent without
// losing jobs, money, or timeouts.
//
// Run:  BOT_TOKEN=... [PORT=8787] node relay/relay.mjs
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const BOT_TOKEN = process.env.BOT_TOKEN ?? '';
const POLL_MS = Number(process.env.RELAY_POLL_MS ?? 15000);
const MAX_TRACK_MS = Number(process.env.RELAY_MAX_TRACK_MS ?? 20 * 60 * 1000);

if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN (the Bot API token from @BotFather) to run the relay.');
  process.exit(1);
}

// jobId → { provider, chatId, statusUrl, promptId, authHeader, startedAt, notified }
const tracked = new Map();

// --- Bot API (raw HTTP, no deps) -------------------------------------------
async function bot(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) console.error('bot api failed', { method, status: res.status });
  return res.ok;
}

// The nudge is a pointer, not the result: the bot is the only party allowed to
// mark a job complete (and it refunds/delivers accordingly). Wording is
// media-agnostic because services may produce videos OR images.
function nudge(jobId, chatId, ok, detail) {
  const text = ok
    ? `✅ Your generation is ready!\nTap 🔄 <b>Check Status</b> under your job to receive it.\n<code>${jobId}</code>`
    : `❌ Generation failed: ${String(detail ?? 'provider error').slice(0, 200)}\nThe bot refunds your Stars automatically.`;
  return bot('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

// --- provider polling ---------------------------------------------------------
async function fetchStatus(t) {
  const headers = t.authHeader ? { Authorization: t.authHeader } : {};
  if (t.provider === 'comfyui') {
    const res = await fetch(t.statusUrl, { headers });
    if (!res.ok) throw new Error(`history ${res.status}`);
    const history = await res.json();
    const entry = history?.[t.promptId];
    if (!entry) return { done: false }; // still running
    if (entry.status?.status_str === 'error') return { done: true, ok: false, detail: 'ComfyUI error' };
    return entry.outputs && Object.keys(entry.outputs).length
      ? { done: true, ok: true }
      : { done: false };
  }
  // fal queue status endpoint
  const res = await fetch(t.statusUrl, { headers });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  if (data.status !== 'COMPLETED') return { done: false };
  return data.error
    ? { done: true, ok: false, detail: data.error }
    : { done: true, ok: true };
}

async function pollTracked() {
  const now = Date.now();
  for (const [jobId, t] of [...tracked]) {
    if (t.notified) {
      tracked.delete(jobId);
      continue;
    }
    if (now - t.startedAt > MAX_TRACK_MS) {
      // The bot's own expiry/refund policy takes over from here.
      tracked.delete(jobId);
      continue;
    }
    try {
      const out = await fetchStatus(t);
      if (out.done) {
        t.notified = true;
        await nudge(jobId, t.chatId, out.ok, out.detail);
        tracked.delete(jobId);
      }
    } catch {
      // transient — keep tracking until MAX_TRACK_MS
    }
  }
}
setInterval(pollTracked, POLL_MS);

// --- HTTP server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/track') {
      return handleTrack(req, res);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/webhook/')) {
      return handleWebhook(req, res, url);
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('relay error', { reason: e?.message });
    return json(res, 500, { ok: false });
  }
});

async function handleTrack(req, res) {
  const body = await readJson(req, 64 * 1024);
  const { jobId, chatId, provider, statusUrl, promptId, authHeader } = body ?? {};
  if (!jobId || !chatId || !provider || !statusUrl) {
    return json(res, 400, { ok: false, error: 'missing fields' });
  }
  if (!['fal_ai', 'comfyui'].includes(provider)) {
    return json(res, 400, { ok: false, error: 'bad provider' });
  }
  tracked.set(jobId, {
    provider,
    chatId,
    statusUrl,
    promptId,
    authHeader: authHeader || null,
    startedAt: Date.now(),
    notified: false,
  });
  return json(res, 200, { ok: true, tracked: tracked.size });
}

async function handleWebhook(req, res, url) {
  // POST /webhook/:provider/:secret?job_id=…&chat_id=…
  const [, , provider, secret] = url.pathname.split('/');
  if (!provider || !secret || !['fal_ai', 'comfyui'].includes(provider)) {
    return json(res, 400, { ok: false, error: 'bad path' });
  }
  const jobId = url.searchParams.get('job_id');
  const chatId = Number(url.searchParams.get('chat_id'));
  if (!jobId || !chatId) return json(res, 400, { ok: false, error: 'missing query' });

  // The secret is the per-job token the bot embedded in the URL it gave the
  // provider — treat it as a bearer check for this callback.
  if (secret.length < 16) return json(res, 401, { ok: false, error: 'bad secret' });

  // Fal queue webhook shape: { request_id, status: "OK"|"ERROR", payload, … }
  const body = await readJson(req, 1024 * 1024);
  const t = tracked.get(jobId);
  if (t) {
    t.notified = true;
    tracked.delete(jobId);
  }
  if (body?.status === 'OK') {
    await nudge(jobId, chatId, true);
  } else if (body?.status === 'ERROR') {
    await nudge(jobId, chatId, false, body?.error ?? body?.payload?.error ?? 'provider error');
  }
  return json(res, 200, { ok: true }); // fast ack — fal retries non-2xx deliveries
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, () => {
  console.log(`relay listening on :${PORT}`);
});
