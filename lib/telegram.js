// lib/telegram.js — small Bot API hardening helpers.
// Mirrors the patterns from the official educational template and the
// telegram-serverless skill's starter bot.
import { api, BotApiError } from 'sdk';

const BENIGN_400 = [
  'message is not modified',
  'message to delete not found',
  'message to edit not found',
  'query is too old',
  "message can't be deleted",
];

function isBotApiError(e) {
  return e instanceof BotApiError || (e && typeof e.code === 'number' && 'description' in e);
}

/** True when the user blocked the bot or the bot was removed from the chat. */
export function isBlocked(e) {
  return isBotApiError(e) && e.code === 403;
}

/**
 * Run a Bot API call, tolerating known-benign 400s (e.g. editing a message to
 * identical content). Anything else — including 429 — is logged without
 * bodies and rethrown so the handler fails visibly.
 */
export async function safe(call) {
  try {
    return await call();
  } catch (e) {
    if (!isBotApiError(e)) throw e;
    const description = (e.description ?? '').toLowerCase();
    if (e.code === 400 && BENIGN_400.some((s) => description.includes(s))) return undefined;
    if (e.code === 429) {
      // Do not spin-wait here — timers are undocumented on the platform.
      console.warn('rate limited', { method: e.method, retryAfter: e.parameters?.retry_after });
    }
    throw e;
  }
}

/** Split long text at paragraph boundaries below the 4096-character limit. */
export function chunkText(text, max = 4000) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Send text, chunked. `extra` is merged into every sendMessage call. */
export async function reply(chatId, text, extra = {}) {
  let last;
  for (const part of chunkText(text)) {
    last = await safe(() => api.sendMessage({ chat_id: chatId, text: part, ...extra }));
  }
  return last;
}

/** Notify without ever throwing — a failed notification must never undo a
 *  DB transition that already happened (e.g. refund before notify). */
export async function notify(chatId, text, extra = {}) {
  try {
    await reply(chatId, text, extra);
    return true;
  } catch (e) {
    if (!isBlocked(e)) {
      console.warn('notify failed', { chatId, reason: e?.message });
    }
    return false;
  }
}
