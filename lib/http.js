// lib/http.js — outbound HTTP hardening for the platform `fetch`.
//
// Platform facts (https://core.telegram.org/bots/serverless#http):
//   - fetch() resolves with ok:false on non-2xx — it does NOT throw; only
//     network-level failures reject.
//   - The response body can be read once. 30 MB response cap.
//   - Timer functions are undocumented in the isolate, so this module never
//     schedules timeouts or sleeps. A hard per-request timeout is therefore
//     left to the platform's own outbound limits; handlers keep total work
//     bounded by budget checks around every await (see lib/sweep.js).
import { fetch } from 'sdk';

// Never log URLs — provider callbacks embed the webhook secret in the path.
function hostOf(url) {
  return String(url).match(/^https?:\/\/[^/?#]+/)?.[0] ?? String(url);
}

// fetch with a normalized error. Keeps stack traces useful without leaking
// the URL (which may carry a secret).
export async function request(url, opts = {}) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const wrapped = new Error(`HTTP ${opts.method ?? 'GET'} ${hostOf(url)} failed: ${e?.message ?? String(e)}`);
    wrapped.cause = e;
    throw wrapped;
  }
}

/**
 * fetch with one immediate retry on transient failures.
 *   - Retries once on 5xx / 429. POSTs are never retried by default: a
 *     provider submit that timed out may actually have been accepted, and a
 *     duplicate submit would double-bill the GPU.
 *   - No sleep between attempts (timers are undocumented); the jitter between
 *     concurrent handlers' retries comes from invocation timing itself.
 */
export async function fetchWithRetry(url, opts = {}, { retries = 1, retryOnPost = false } = {}) {
  const method = (opts.method ?? 'GET').toUpperCase();
  const canRetry = method === 'GET' || retryOnPost;
  let last = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      console.warn('http retry', { attempt, method, host: hostOf(url), previousStatus: last?.status });
    }
    const res = await request(url, opts);
    if (res.ok) return res;
    last = res;

    const retryable = res.status === 429 || res.status >= 500;
    if (!canRetry || !retryable || attempt >= retries) return res;
  }
  return last;
}

/**
 * fetch + parse JSON, returning { ok, status, data }.
 * `data` is null for non-2xx or unparseable bodies. Callers branch on `ok`
 * first — never call .json() twice on the same response.
 */
export async function fetchJson(url, opts = {}, retryOpts = {}) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  let data = null;
  if (res.ok) {
    try {
      data = await res.json();
    } catch {
      // empty or non-JSON 2xx body — callers treat data === null as an error
    }
  }
  return { ok: res.ok, status: res.status, data, response: res };
}
