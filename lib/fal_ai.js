// lib/fal_ai.js — Fal AI async queue client, raw REST (no SDK).
//
// Fal's queue model is exactly what this bot needs:
//   1. submit → returns immediately: request_id + status/response/cancel URLs
//   2. poll   → GET status_url   (IN_QUEUE / IN_PROGRESS / COMPLETED)
//   3. read   → GET response_url (the model output payload)
//   4. cancel → PUT cancel_url
//   5. webhook→ pass ?fal_webhook=… at submit; fal POSTs the result when done
//
// Watch-outs baked in below:
//   - A FAILED run reports status COMPLETED with `error`/`error_type` set —
//     getJobStatus() maps that to failed, never to success.
//   - Submission is never retried (a timed-out POST may have been accepted;
//     a retry would double-bill). Status/result GETs retry once on 5xx.
//
// Docs: https://fal.ai/docs/model-apis/inference/queue
// Model: https://fal.ai/models/fal-ai/veo3.1/image-to-video
import { fetch } from 'sdk';
import { fetchWithRetry } from 'lib/http';
import { secrets } from 'lib/secrets';

const QUEUE_BASE = 'https://queue.fal.run';
const UPLOAD_INITIATE = 'https://rest.fal.ai/storage/upload/initiate';

function authHeaders(json = false) {
  const headers = { Authorization: `Key ${secrets.falKey}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function assertKey() {
  if (!secrets.falKey) throw new Error('falKey is empty — set it in lib/secrets.js');
}

/**
 * Upload raw bytes to fal's CDN and get a public URL back, in two steps:
 * initiate (get a presigned upload_url + the final file_url) → PUT the bytes.
 * Telegram file_ids are not URLs, so this is how the user's photo becomes an
 * `image_url` the model can read.
 */
export async function uploadImage(bytes, filename = 'photo.jpg') {
  assertKey();
  const init = await fetchWithRetry(UPLOAD_INITIATE, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ content_type: 'image/jpeg', file_name: filename }),
  });
  if (!init.ok) throw new Error(`fal upload initiate failed: HTTP ${init.status}`);

  const data = await init.json();
  if (!data?.upload_url || !data?.file_url) throw new Error('fal upload initiate returned no URLs');

  const put = await fetch(data.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: bytes, // Uint8Array from api.getFileContent — streamed out by the platform
  });
  if (!put.ok) throw new Error(`fal upload PUT failed: HTTP ${put.status}`);
  return data.file_url;
}

/**
 * Submit an image-to-video job. NEVER awaits completion — the queue submit
 * itself returns in well under a second.
 *
 * @param {string} model     e.g. 'fal-ai/veo3.1/image-to-video'
 * @param {object} input     model input payload (prompt, image_url, …)
 * @param {string|null} webhookUrl  optional relay URL fal POSTs to when done
 * @returns {{ requestId, statusUrl, responseUrl, cancelUrl }}
 */
export async function submitImageToVideo({ model, input, webhookUrl = null }) {
  assertKey();
  const base = `${QUEUE_BASE}/${model}`;
  const url = webhookUrl ? `${base}?fal_webhook=${encodeURIComponent(webhookUrl)}` : base;

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* keep the status code */ }
    throw new Error(`fal submit failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 400)}` : ''}`);
  }

  const data = await res.json();
  if (!data?.request_id || !data?.status_url) throw new Error('fal submit returned an unexpected shape');
  return {
    requestId: data.request_id,
    statusUrl: data.status_url,
    responseUrl: data.response_url ?? null,
    cancelUrl: data.cancel_url ?? null,
  };
}

/**
 * GET the queue status. Returns a normalized view:
 *   { status: 'IN_QUEUE'|'IN_PROGRESS'|'COMPLETED', error, errorType,
 *     responseUrl, queuePosition }
 * Note the failure encoding: COMPLETED + `error` present = failed run.
 */
export async function getStatus(statusUrl) {
  assertKey();
  const res = await fetchWithRetry(statusUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fal status failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    status: data.status ?? 'UNKNOWN',
    error: data.error ?? null,
    errorType: data.error_type ?? null,
    responseUrl: data.response_url ?? null,
    queuePosition: data.queue_position ?? null,
  };
}

/** GET the final output payload (model-specific shape; veo3.1 → { video: { url } }). */
export async function getResult(responseUrl) {
  assertKey();
  const res = await fetchWithRetry(responseUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fal result failed: HTTP ${res.status}`);
  return res.json();
}

/** Defensively pull a video URL out of whatever the payload shape happens to be. */
export function extractVideoUrl(payload) {
  const video = payload?.video ?? payload?.videos?.[0] ?? payload?.output?.video;
  return typeof video?.url === 'string' ? video.url : null;
}

/**
 * Best-effort cancellation. The cancel endpoint is the documented sibling of
 * the status URL: …/requests/{id}/status → …/requests/{id}/cancel.
 * 400 + {"status":"ALREADY_COMPLETED"} means the run finished first — the
 * caller should poll instead of refunding.
 */
export async function cancel(job) {
  assertKey();
  const cancelUrl = job.providerStatusUrl?.replace(/\/status$/, '/cancel');
  if (!cancelUrl) return { alreadyCompleted: false };
  const res = await fetch(cancelUrl, { method: 'PUT', headers: authHeaders() });
  if (res.status === 400) {
    let body = {};
    try { body = await res.json(); } catch { /* not json */ }
    return { alreadyCompleted: body?.status === 'ALREADY_COMPLETED' };
  }
  return { alreadyCompleted: false };
}

/**
 * Normalized one-shot poll used by lib/jobs.js#pollJob.
 * Returns { status: 'processing' } while queued/running,
 *          { status: 'complete', outputUrl } on success,
 *          { status: 'complete', failed: true, error } on failure.
 * Exactly ONE status call + (when complete) ONE result call — never blocks.
 */
export async function getJobStatus(job) {
  const st = await getStatus(job.providerStatusUrl);
  if (st.status !== 'COMPLETED') {
    return { status: 'processing', failed: false, queuePosition: st.queuePosition };
  }
  if (st.error) {
    return { status: 'complete', failed: true, error: `Fal ${st.errorType ?? 'error'}: ${st.error}` };
  }
  const responseUrl = st.responseUrl ?? job.providerStatusUrl?.replace(/\/status$/, '/response');
  if (!responseUrl) return { status: 'complete', failed: true, error: 'Fal status had no response URL' };

  const payload = await getResult(responseUrl);
  const outputUrl = extractVideoUrl(payload);
  if (!outputUrl) return { status: 'complete', failed: true, error: 'Fal payload contained no video URL' };
  return { status: 'complete', failed: false, outputUrl };
}
