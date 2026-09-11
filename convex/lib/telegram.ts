import { env } from "../_generated/server";

// lib/telegram.ts — classic Bot API client for actions.
//
// On Convex the bot is self-hosted: we hold the Bot API token (BOT_TOKEN env
// var) and talk to https://api.telegram.org ourselves. Only ACTIONS may call
// these functions (mutations/queries are deterministic and cannot fetch).

const API_BASE = "https://api.telegram.org";

export class BotApiError extends Error {
  status: number;
  description: string;
  constructor(status: number, description: string) {
    super(`Telegram API ${status}: ${description}`);
    this.name = "BotApiError";
    this.status = status;
    this.description = description;
  }
}

export function botToken(): string {
  const t = env.BOT_TOKEN;
  if (!t) throw new Error("BOT_TOKEN env var is not set (npx convex env set BOT_TOKEN …)");
  return t;
}

export function webhookSecret(): string {
  return env.WEBHOOK_SECRET || "dev";
}

/** JSON call. Throws BotApiError on non-ok responses or Telegram error bodies. */
export async function call<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new BotApiError(res.status, `HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
  if (!data.ok) {
    throw new BotApiError(data.error_code ?? 0, data.description ?? "unknown error");
  }
  return data.result as T;
}

/** Multipart call — one binary file plus JSON-ish string fields. */
export async function callMultipart(
  method: string,
  params: Record<string, string>,
  fileField: string,
  filename: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<unknown> {
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append(fileField, new Blob([bytes as BlobPart], { type: contentType }), filename);
  const res = await fetch(`${API_BASE}/bot${botToken()}/${method}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new BotApiError(res.status, `HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new BotApiError(0, data.description ?? "unknown error");
  return data.result;
}

/** Swallow errors — for edits/answers whose benign 400s ("query is too old") must not fail a flow. */
export async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn("telegram call swallowed", { reason: (e as Error)?.message });
  }
}

// --- typed helpers -----------------------------------------------------------------

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { parseMode?: "HTML"; replyMarkup?: unknown } = {},
) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: opts.parseMode,
    ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
  });
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: unknown,
) {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return call("editMessageText", params);
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export async function answerPreCheckoutQuery(preCheckoutQueryId: string) {
  return call("answerPreCheckoutQuery", { pre_checkout_query_id: preCheckoutQueryId, ok: true });
}

export async function sendInvoice(chatId: number, amount: number, description: string) {
  // XTR specifics: currency is "XTR", prices are integer Stars, and
  // provider_token MUST be omitted.
  return call("sendInvoice", {
    chat_id: chatId,
    title: `${amount} Telegram Stars`,
    description,
    payload: "buy_stars", // opaque; the amount is trusted from the payment itself
    currency: "XTR",
    prices: [{ label: `${amount} ⭐`, amount }],
  });
}

export async function sendPhotoByUrl(chatId: number, photoUrl: string, caption: string) {
  return call("sendPhoto", { chat_id: chatId, photo: photoUrl, caption });
}

export async function sendVideoByUrl(chatId: number, videoUrl: string, caption: string) {
  return call("sendVideo", { chat_id: chatId, video: videoUrl, caption, supports_streaming: true });
}

export async function sendPhotoBytes(chatId: number, bytes: Uint8Array, caption: string) {
  return callMultipart("sendPhoto", { chat_id: String(chatId), caption }, "photo", "result.png", bytes, "image/png");
}

export async function sendVideoBytes(chatId: number, bytes: Uint8Array, caption: string) {
  return callMultipart(
    "sendVideo",
    { chat_id: String(chatId), caption, supports_streaming: "true" },
    "video",
    "video.mp4",
    bytes,
    "video/mp4",
  );
}

export async function setMyCommands(commands: Array<{ command: string; description: string }>) {
  return call("setMyCommands", { commands });
}

/**
 * Resolve a photo file_id to raw bytes: getFile → file_path → download.
 * Telegram file_ids are NOT urls; this is how user photos reach providers.
 */
export async function downloadPhoto(fileId: string): Promise<Uint8Array> {
  const file = (await call("getFile", { file_id: fileId })) as {
    file_path?: string;
  };
  if (!file?.file_path) throw new Error("Telegram getFile returned no file_path");
  const res = await fetch(`${API_BASE}/file/bot${botToken()}/${file.file_path}`);
  if (!res.ok) throw new BotApiError(res.status, `file download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
