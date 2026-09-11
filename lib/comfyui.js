// lib/comfyui.js — async client for any ComfyUI-compatible endpoint.
//
// Works against self-hosted ComfyUI (`--listen`), RunComfy, and other hosted
// servers that speak the standard API:
//   POST /prompt       { prompt, client_id }              → { prompt_id }
//   GET  /history/<id> {} while running; outputs when done
//   GET  /view?filename=…&subfolder=…&type=output         → file bytes
//   POST /interrupt    { prompt_id }                       → stop
//   POST /upload/image multipart (image, overwrite)        → { name, subfolder, type }
//
// Optional bearer auth via secrets.comfyuiApiKey (hosted providers).
// ComfyUI has NO native webhooks — completion is discovered by polling
// /history, either from the bot (Check Status / sweep) or from the optional
// relay (relay/relay.mjs), which polls on the bot's behalf.
import { fetch, FormData, InputFile } from 'sdk';
import { fetchWithRetry } from 'lib/http';
import { secrets } from 'lib/secrets';
import { randomId } from 'lib/ids';

export function baseUrl() {
  const base = String(secrets.comfyuiBaseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('comfyuiBaseUrl is empty — set it in lib/secrets.js');
  return base;
}

function authHeaders(json = false) {
  const headers = {};
  if (secrets.comfyuiApiKey) headers.Authorization = `Bearer ${secrets.comfyuiApiKey}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

/**
 * Upload image bytes; returns the server-side file descriptor the LoadImage
 * node needs: { name, subfolder, type }. Self-hosted and most hosted
 * ComfyUI endpoints implement this multipart endpoint.
 */
export async function uploadImage(bytes, filename = 'photo.jpg') {
  const form = new FormData();
  form.append('image', new InputFile(bytes, filename, { type: 'image/jpeg' }));
  form.append('overwrite', 'true');
  const res = await fetch(`${baseUrl()}/upload/image`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`comfyui upload failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.name) throw new Error('comfyui upload returned no name');
  return data;
}

/**
 * Inject dynamic inputs into an API-format workflow by walking the graph and
 * matching node `class_type` (config.inputNodes) — so the same template works
 * for any user's exported graph regardless of node ids.
 *   - LoadImage        → inputs.image = the uploaded file name
 *   - CLIPTextEncode   → inputs.text  = prompt (first non-negative prompt node)
 *   - KSampler         → inputs.seed / inputs.steps (when provided)
 * Returns a deep copy; the module export is never mutated.
 */
export function injectWorkflow(workflow, {
  image = null,
  prompt = null,
  seed = null,
  steps = null,
  imageNode = 'LoadImage',
  promptNode = 'CLIPTextEncode',
  seedNode = 'KSampler',
} = {}) {
  const graph = JSON.parse(JSON.stringify(workflow));
  let promptSet = false;

  for (const node of Object.values(graph)) {
    if (!node || typeof node !== 'object') continue;
    const cls = node.class_type;
    if (!node.inputs) node.inputs = {};
    const inputs = node.inputs;

    if (cls === imageNode && image != null) {
      // The file name as known to the ComfyUI server (upload first via
      // uploadImage), or a full URL on hosted endpoints whose LoadImage
      // accepts URLs.
      inputs.image = image;
    } else if (cls === promptNode) {
      const title = String(node._meta?.title ?? '').toLowerCase();
      const isNegative = title.includes('negative');
      if (!promptSet && !isNegative && prompt != null) {
        inputs.text = prompt;
        promptSet = true;
      }
    } else if (cls === seedNode) {
      if (seed != null) inputs.seed = seed;
      if (steps != null) inputs.steps = steps;
    }
  }
  return graph;
}

/**
 * Submit the workflow. Returns { promptId, clientId, statusUrl } immediately —
 * NEVER waits for output. `statusUrl` is the /history URL stored on the job
 * row so every poll path (button, sweep, relay) asks the same question.
 */
export async function submitWorkflow(workflow, clientId = randomId()) {
  const res = await fetch(`${baseUrl()}/prompt`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* keep the status code */ }
    throw new Error(`comfyui submit failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 400)}` : ''}`);
  }
  const data = await res.json();
  if (!data?.prompt_id) throw new Error('comfyui submit returned no prompt_id');
  return {
    promptId: data.prompt_id,
    clientId,
    statusUrl: `${baseUrl()}/history/${data.prompt_id}`,
  };
}

/** GET /history/<prompt_id> — {} while running; { [id]: { outputs, status } } when done. */
export async function getHistory(promptId) {
  const res = await fetchWithRetry(`${baseUrl()}/history/${promptId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`comfyui history failed: HTTP ${res.status}`);
  return res.json();
}

export function historyEntry(history, promptId) {
  return history?.[promptId] ?? null;
}

// History entries embed the execution graph in `prompt` (an array whose
// element is usually the node map). Tolerate shape drift; return null when
// the graph is not recoverable.
function findGraph(entry) {
  const prompt = entry?.prompt;
  if (!Array.isArray(prompt)) return null;
  for (const part of prompt) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const values = Object.values(part);
    if (values.length && values.every((v) => v && typeof v === 'object' && typeof v.class_type === 'string')) {
      return part;
    }
  }
  return null;
}

function fileUrl(file, base) {
  const sub = file.subfolder ? `&subfolder=${encodeURIComponent(file.subfolder)}` : '';
  const type = file.type ? `&type=${encodeURIComponent(file.type)}` : '';
  return `${base}/view?filename=${encodeURIComponent(file.filename)}${sub}${type}`;
}

/**
 * Walk the history outputs to find the video produced by the output node
 * (VHS_VideoCombine / SaveVideo) and build its /view download URL.
 * Falls back to the first video-ish output if the class can't be matched.
 */
export function getOutputUrl(history, promptId, outputClass = 'VHS_VideoCombine') {
  const entry = historyEntry(history, promptId);
  if (!entry) return null;
  const outputs = entry.outputs ?? {};
  const graph = findGraph(entry);
  let fallback = null;

  for (const [nodeId, out] of Object.entries(outputs)) {
    const video = out?.videos?.[0] ?? out?.gifs?.[0];
    if (!video?.filename) continue;
    const url = fileUrl(video, baseUrl());
    if (!url) continue;
    const cls = graph?.[nodeId]?.class_type;
    if (!outputClass || cls === outputClass) return url;
    if (!fallback) fallback = url;
  }
  return fallback;
}

/** Best-effort interrupt (used on cancel). Errors are swallowed — the caller refunds regardless. */
export async function interrupt(promptId) {
  try {
    await fetch(`${baseUrl()}/interrupt`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ prompt_id: promptId }),
    });
  } catch {
    // nothing sensible to do; cancellation is best-effort by design
  }
}

/**
 * Download an output file with auth. The platform caps fetch responses at
 * 30 MB, so authed downloads (which Telegram itself cannot fetch) must stay
 * under that — check the cap explicitly for a clean error.
 */
export async function downloadOutput(outputUrl) {
  const res = await fetch(outputUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`comfyui view failed: HTTP ${res.status}`);
  const chunks = [];
  let total = 0;
  const MAX = 29 * 1024 * 1024; // 30 MB platform cap, minus headroom
  for await (const chunk of res.body) {
    const part = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    total += part.length;
    if (total > MAX) throw new Error('comfyui output exceeds the 30 MB platform fetch cap');
    chunks.push(part);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Normalized one-shot poll used by lib/jobs.js#pollJob.
 * Returns { status: 'processing' } while running,
 *          { status: 'complete', outputUrl } on success,
 *          { status: 'complete', failed: true, error } on failure.
 */
export async function getJobStatus(job) {
  const promptId = job.providerJobId;
  const history = await getHistory(promptId);
  const entry = historyEntry(history, promptId);
  if (!entry) return { status: 'processing', failed: false }; // {} while queued/running

  if (entry.status?.status_str === 'error') {
    const messages = (entry.status?.messages ?? [])
      .flat()
      .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
      .join('; ')
      .slice(0, 300);
    return { status: 'complete', failed: true, error: `ComfyUI error: ${messages || 'unknown'}` };
  }

  const outputUrl = getOutputUrl(history, promptId);
  if (outputUrl) return { status: 'complete', failed: false, outputUrl };
  return { status: 'processing', failed: false }; // finished but no video yet — keep polling
}

export async function cancel(job) {
  await interrupt(job.providerJobId);
  return { alreadyCompleted: false };
}
