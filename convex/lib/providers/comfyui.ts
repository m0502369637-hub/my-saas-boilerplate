import { env } from "../../_generated/server";
import { fetchWithRetry } from "../http";

// lib/providers/comfyui.ts — async client for any ComfyUI-compatible endpoint
// (self-hosted, RunComfy, and other hosted servers speaking the standard API):
//   POST /prompt         { prompt, client_id }              → { prompt_id }
//   GET  /history/<id>   {} while running; outputs when done
//   GET  /view?filename=…&subfolder=…&type=output           → file bytes
//   POST /interrupt      { prompt_id }                       → stop
//   POST /upload/image   multipart (image, overwrite)        → { name, subfolder, type }
//
// Optional bearer auth via COMFYUI_API_KEY. ComfyUI has NO webhooks —
// completion is discovered by polling /history (scheduler + cron here).

export function baseUrl(): string {
  const base = (env.COMFYUI_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("COMFYUI_BASE_URL env var is not set");
  return base;
}

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.COMFYUI_API_KEY) headers.Authorization = `Bearer ${env.COMFYUI_API_KEY}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/** Upload image bytes; returns the descriptor LoadImage needs: { name, subfolder, type }. */
export async function uploadImage(
  bytes: Uint8Array,
  filename = "photo.jpg",
): Promise<{ name: string; subfolder: string; type: string }> {
  const form = new FormData();
  form.append("image", new Blob([bytes as BlobPart], { type: "image/jpeg" }), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${baseUrl()}/upload/image`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`comfyui upload failed: HTTP ${res.status}`);
  const data = (await res.json()) as { name?: string; subfolder?: string; type?: string };
  if (!data?.name) throw new Error("comfyui upload returned no name");
  return { name: data.name, subfolder: data.subfolder ?? "", type: data.type ?? "input" };
}

/**
 * Inject dynamic inputs into an API-format workflow by walking the graph and
 * matching node class_type — so any exported graph works regardless of node
 * ids. Returns a deep copy; the input is never mutated.
 */
export function injectWorkflow(
  workflow: Record<string, unknown>,
  opts: {
    image?: string | null;
    prompt?: string | null;
    seed?: number | null;
    steps?: number | null;
    imageNode?: string;
    promptNode?: string;
    seedNode?: string;
  } = {},
): Record<string, unknown> {
  const graph = JSON.parse(JSON.stringify(workflow)) as Record<string, Record<string, any>>;
  const {
    image = null,
    prompt = null,
    seed = null,
    steps = null,
    imageNode = "LoadImage",
    promptNode = "CLIPTextEncode",
    seedNode = "KSampler",
  } = opts;
  let promptSet = false;

  for (const node of Object.values(graph)) {
    if (!node || typeof node !== "object") continue;
    const cls = node.class_type as string;
    if (!node.inputs) node.inputs = {};
    const inputs = node.inputs as Record<string, any>;

    if (cls === imageNode && image != null) {
      inputs.image = image;
    } else if (cls === promptNode) {
      const title = String(node._meta?.title ?? "").toLowerCase();
      const isNegative = title.includes("negative");
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

/** Submit the workflow. Returns identifiers immediately — NEVER waits for output. */
export async function submitWorkflow(workflow: Record<string, unknown>, clientId: string) {
  const res = await fetch(`${baseUrl()}/prompt`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* not json */
    }
    throw new Error(`comfyui submit failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 400)}` : ""}`);
  }
  const data = (await res.json()) as { prompt_id?: string };
  if (!data?.prompt_id) throw new Error("comfyui submit returned no prompt_id");
  return { promptId: data.prompt_id, clientId };
}

export async function getHistory(promptId: string): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(`${baseUrl()}/history/${promptId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`comfyui history failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

type OutputFile = { filename?: string; subfolder?: string; type?: string };

type HistoryEntry = {
  outputs?: Record<
    string,
    { videos?: OutputFile[]; gifs?: OutputFile[]; images?: OutputFile[] }
  >;
  status?: { status_str?: string; messages?: unknown };
  prompt?: unknown;
};

function findGraph(entry: HistoryEntry): Record<string, { class_type?: string }> | null {
  const prompt = entry?.prompt;
  if (!Array.isArray(prompt)) return null;
  for (const part of prompt) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const values = Object.values(part as Record<string, unknown>);
    if (values.length && values.every((v) => v && typeof v === "object" && typeof (v as any).class_type === "string")) {
      return part as Record<string, { class_type?: string }>;
    }
  }
  return null;
}

function fileUrl(file: { filename: string; subfolder?: string; type?: string }): string {
  const sub = file.subfolder ? `&subfolder=${encodeURIComponent(file.subfolder)}` : "";
  const type = file.type ? `&type=${encodeURIComponent(file.type)}` : "";
  return `${baseUrl()}/view?filename=${encodeURIComponent(file.filename)}${sub}${type}`;
}

/** Walk history outputs for the video produced by VHS_VideoCombine/SaveVideo. */
export function getOutputUrl(history: Record<string, unknown>, promptId: string, outputClass = "VHS_VideoCombine"): string | null {
  const entry = history?.[promptId] as HistoryEntry | undefined;
  if (!entry) return null;
  const outputs = entry.outputs ?? {};
  const graph = findGraph(entry);
  let fallback: string | null = null;

  for (const [nodeId, out] of Object.entries(outputs)) {
    const file = out?.videos?.[0] ?? out?.gifs?.[0];
    const filename = file?.filename;
    if (!filename) continue;
    const url = fileUrl({ filename, subfolder: file?.subfolder, type: file?.type });
    if (!url) continue;
    const cls = graph?.[nodeId]?.class_type;
    if (!outputClass || cls === outputClass) return url;
    if (!fallback) fallback = url;
  }
  return fallback;
}

/** Same walk for images (SaveImage → { images: [{ filename, … }] }). */
export function getOutputImageUrl(history: Record<string, unknown>, promptId: string, outputClass = "SaveImage"): string | null {
  const entry = history?.[promptId] as HistoryEntry | undefined;
  if (!entry) return null;
  const outputs = entry.outputs ?? {};
  const graph = findGraph(entry);
  let fallback: string | null = null;

  for (const [nodeId, out] of Object.entries(outputs)) {
    const file = out?.images?.[0];
    const filename = file?.filename;
    if (!filename) continue;
    const url = fileUrl({ filename, subfolder: file?.subfolder, type: file?.type });
    if (!url) continue;
    const cls = graph?.[nodeId]?.class_type;
    if (!outputClass || cls === outputClass) return url;
    if (!fallback) fallback = url;
  }
  return fallback;
}

export async function interrupt(promptId: string): Promise<void> {
  try {
    await fetch(`${baseUrl()}/interrupt`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ prompt_id: promptId }),
    });
  } catch {
    // best-effort by design — the caller refunds regardless
  }
}

/** Download an output file (used when auth means Telegram cannot fetch the URL itself). */
export async function downloadOutput(outputUrl: string): Promise<Uint8Array> {
  const res = await fetch(outputUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`comfyui view failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export type JobPollResult =
  | { status: "processing"; failed: false }
  | { status: "complete"; failed: true; error: string }
  | { status: "complete"; failed: false; output: { url: string; kind: "video" | "image"; requiresDownload: boolean } };

/** One-shot poll of /history. Never blocks. */
export async function getJobStatus(promptId: string): Promise<JobPollResult> {
  const history = await getHistory(promptId);
  const entry = history?.[promptId] as HistoryEntry | undefined;
  if (!entry) return { status: "processing", failed: false }; // {} while queued/running

  if (entry.status?.status_str === "error") {
    const messages = ((entry.status?.messages ?? []) as unknown[])
      .flat()
      .map((m) => (typeof m === "string" ? m : JSON.stringify(m)))
      .join("; ")
      .slice(0, 300);
    return { status: "complete", failed: true, error: `ComfyUI error: ${messages || "unknown"}` };
  }

  const requiresDownload = Boolean(env.COMFYUI_API_KEY); // Telegram cannot fetch authed /view urls
  const videoUrl = getOutputUrl(history, promptId);
  if (videoUrl) return { status: "complete", failed: false, output: { url: videoUrl, kind: "video", requiresDownload } };
  const imageUrl = getOutputImageUrl(history, promptId);
  if (imageUrl) return { status: "complete", failed: false, output: { url: imageUrl, kind: "image", requiresDownload } };
  return { status: "processing", failed: false }; // finished but no output yet — keep polling
}

export async function cancel(promptId: string): Promise<{ alreadyCompleted: boolean }> {
  await interrupt(promptId);
  return { alreadyCompleted: false };
}
