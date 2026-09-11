// handlers/pre_checkout_query.js — required for Telegram Stars payments.
//
// Telegram sends this update before charging the user; the invoice is
// cancelled unless the bot answers ok:true. Only accept payloads this bot
// actually issues — everything else gets an explicit refusal.
import { api } from 'sdk';

const KNOWN_PAYLOADS = new Set(['buy_stars']); // lib/stars.js INVOICE_PAYLOAD

export default async function (pq) {
  const ok = KNOWN_PAYLOADS.has(pq.invoice_payload ?? '');
  const params = { pre_checkout_query_id: pq.id, ok };
  if (!ok) params.error_message = 'Unknown invoice payload.';
  await api.answerPreCheckoutQuery(params);
}
