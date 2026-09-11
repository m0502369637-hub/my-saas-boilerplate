import { env } from "../../_generated/server";
import { fetchWithRetry } from "../http";

// lib/providers/fal.ts — Fal AI async queue client, raw REST (no SDK).
//
// Queue model:
//   1. submit  → POST https://queue.fal.run/<model> → { request_id, status_url,
//      response_url, cancel_url } (immediate)
//   2. status  → GET status_url → IN_QUEUE | IN_PROGRESS | COMPLETED
//   3. result  → GET response_url → model output payload
//   4. cancel  → PUT cancel_url
//   5. webhook → pass ?fal_webhook=<url> at submit; fal POSTs the result when done
//
// Watch-outs:
//   - A FAILED run reports status COMPLETED with `error`/`error_type` set —
//     getJobStatus() maps that to failed, never to success.
//   - Submission is never retried. Status/result GETs retry once on 5xx.
//
// Docs: https://fal.ai/docs/model-apis/inference/queue

const QUEUE_BASE = "https://queue.fal.run";
const UPLOAD_INITIATE = "https://rest.fal.ai/storage/upload/initiate";

export function falKey(): string {
  const key = env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY env var is not set (npx convex env set FAL_KEY …)");
  return key;
}

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Key ${falKey()}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/** Upload raw bytes to fal's CDN; returns a public URL (two steps: initiate → PUT). */
export async function uploadImage(bytes: Uint8Array, filename = "photo.jpg"): Promise<string> {
  const init = await fetchWithRetry(UPLOAD_INITIATE, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ content_type: "image/jpeg", file_name: filename }),
  });
  if (!init.ok) throw new Error(`fal upload initiate failed: HTTP ${init.status}`);
  const data = (await init.json()) as { upload_url?: string; file_url?: string };
  if (!data?.upload_url || !data?.file_url) throw new Error("fal upload initiate returned no URLs");

  const put = await fetch(data.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: new Blob([bytes as BlobPart], { type: "image/jpeg" }),
  });
  if (!put.ok) throw new Error(`fal upload PUT failed: HTTP ${put.status}`);
  return data.file_url;
}

export interface SubmitResult {
  requestId: string;
  statusUrl: string;
  responseUrl: string | null;
  cancelUrl: string | null;
}

/** Submit to the queue. NEVER awaits completion — returns identifiers immediately. */
export async function submitRequest(opts: {
  model: string;
  input: Record<string, unknown>;
  webhookUrl?: string | null;
}): Promise<SubmitResult> {
  const base = `${QUEUE_BASE}/${opts.model}`;
  const url = opts.webhookUrl ? `${base}?fal_webhook=${encodeURIComponent(opts.webhookUrl)}` : base;

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(opts.input),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* not json */
    }
    throw new Error(`fal submit failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 400)}` : ""}`);
  }

  const data = (await res.json()) as {
    request_id?: string;
    status_url?: string;
    response_url?: string;
    cancel_url?: string;
  };
  if (!data?.request_id || !data?.status_url) throw new Error("fal submit returned an unexpected shape");
  return {
    requestId: data.request_id,
    statusUrl: data.status_url,
    responseUrl: data.response_url ?? null,
    cancelUrl: data.cancel_url ?? null,
  };
}

export interface QueueStatus {
  status: string;
  error: string | null;
  errorType: string | null;
  responseUrl: string | null;
  queuePosition: number | null;
}

export async function getStatus(statusUrl: string): Promise<QueueStatus> {
  const res = await fetchWithRetry(statusUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fal status failed: HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  return {
    status: (data.status as string) ?? "UNKNOWN",
    error: (data.error as string) ?? null,
    errorType: (data.error_type as string) ?? null,
    responseUrl: (data.response_url as string) ?? null,
    queuePosition: (data.queue_position as number) ?? null,
  };
}

export async function getResult(responseUrl: string): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(responseUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fal result failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export function extractVideoUrl(payload: Record<string, unknown>): string | null {
  const video = (payload?.video ?? (payload?.videos as unknown[] | undefined)?.[0] ?? (payload?.output as Record<string, unknown> | undefined)?.video) as
    | { url?: unknown }
    | undefined;
  return typeof video?.url === "string" ? video.url : null;
}

export function extractImageUrl(payload: Record<string, unknown>): string | null {
  const image = ((payload?.images as unknown[] | undefined)?.[0] ?? payload?.image) as { url?: unknown } | undefined;
  return typeof image?.url === "string" ? image.url : null;
}

export interface OutputRef {
  url: string;
  kind: "video" | "image";
}

/** Normalize any fal payload into { url, kind } — one delivery path for all services. */
export function extractOutput(payload: Record<string, unknown>): OutputRef | null {
  const videoUrl = extractVideoUrl(payload);
  if (videoUrl) return { url: videoUrl, kind: "video" };
  const imageUrl = extractImageUrl(payload);
  if (imageUrl) return { url: imageUrl, kind: "image" };
  return null;
}

export async function cancelRequest(cancelUrl: string | null): Promise<{ alreadyCompleted: boolean }> {
  if (!cancelUrl) return { alreadyCompleted: false };
  const res = await fetch(cancelUrl, { method: "PUT", headers: authHeaders() });
  if (res.status === 400) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not json */
    }
    return { alreadyCompleted: body?.status === "ALREADY_COMPLETED" };
  }
  return { alreadyCompleted: false };
}

export type JobPollResult =
  | { status: "processing"; failed: false; queuePosition: number | null }
  | { status: "complete"; failed: true; error: string }
  | { status: "complete"; failed: false; output: OutputRef };

/** One-shot poll: ONE status call (+ ONE result call when complete). Never blocks. */
export async function getJobStatus(opts: {
  statusUrl: string;
  responseUrl: string | null;
}): Promise<JobPollResult> {
  const st = await getStatus(opts.statusUrl);
  if (st.status !== "COMPLETED") {
    return { status: "processing", failed: false, queuePosition: st.queuePosition };
  }
  if (st.error) {
    return { status: "complete", failed: true, error: `Fal ${st.errorType ?? "error"}: ${st.error}` };
  }
  const responseUrl = st.responseUrl ?? opts.responseUrl;
  if (!responseUrl) return { status: "complete", failed: true, error: "Fal status had no response URL" };

  const payload = await getResult(responseUrl);
  const output = extractOutput(payload);
  if (!output) return { status: "complete", failed: true, error: "Fal payload contained no result URL" };
  return { status: "complete", failed: false, output };
}
