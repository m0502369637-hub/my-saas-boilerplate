// lib/stars.js — Telegram Stars invoicing + the internal wallet.
//
// Money model (keep it in your head before touching anything):
//   - Users buy Stars through a real Telegram invoice (`sendInvoice` with
//     currency 'XTR'). The payment arrives as message.successful_payment.
//   - The bot keeps an INTERNAL wallet (users.stars_balance). A generation
//     debits it; a failed/timed-out/cancelled job refunds it. This is
//     deliberate: refunds are instant, whole, and auditable in `payments`,
//     and we never depend on Telegram's refund API granularity.
//   - Every wallet movement writes a payments row (kind 'charge'|'refund').
//
// All mutations are single SQL statements with guards, so concurrent
// invocations cannot double-credit or overdraw.
import { api, db } from 'sdk';
import { and, eq, gte, sql } from 'sdk/db';
import { payments, users } from 'schema';
import { randomId } from 'lib/ids';
import { affectedCount } from 'lib/db_util';
import { notify } from 'lib/telegram';

export const INVOICE_PAYLOAD = 'buy_100_stars';
export const PACK_STARS = 100;

/**
 * Send a Telegram Stars invoice for `amount` Stars.
 * XTR specifics: currency is 'XTR', prices are integer Stars, and
 * provider_token must be omitted (Stars are charged to the user's balance).
 */
export async function createStarsInvoice(chatId, amount, description, payload) {
  return api.sendInvoice({
    chat_id: chatId,
    title: `${amount} Telegram Stars`,
    description,
    payload,
    currency: 'XTR',
    prices: [{ label: `${amount} ⭐`, amount }],
  });
}

/**
 * Called from handlers/message.js when a message carries successful_payment.
 * Credits the internal wallet and confirms to the user. Idempotent per
 * delivery thanks to the update_id claim in the handler.
 */
export async function handleSuccessfulPayment(message) {
  const sp = message?.successful_payment;
  const chatId = message?.chat?.id;
  const from = message?.from;
  if (!sp || !chatId || !from) return null;
  if (sp.currency !== 'XTR') return null;              // we only bill in Stars
  if (sp.invoice_payload !== INVOICE_PAYLOAD) return null; // not our invoice
  const amount = Number(sp.total_amount) || 0;
  if (amount <= 0) return null;

  await creditStars(from.id, amount, { kind: 'charge', jobId: null });
  await notify(chatId, `✅ ${amount} ⭐ added to your balance. Send a photo to start a generation!`);
  return amount;
}

/**
 * Credit `amount` to the wallet, inserting a payments row.
 * Single-statement upsert so it is safe even if the users row vanished.
 */
export async function creditStars(userTgId, amount, { kind = 'charge', jobId = null } = {}) {
  await db.insert(users)
    .values({ tgId: userTgId, firstName: 'user', starsBalance: amount })
    .onConflictDoUpdate({
      target: users.tgId,
      set: { starsBalance: sql`${users.starsBalance} + ${amount}` },
    })
    .run();
  await recordPayment(userTgId, amount, kind, jobId);
}

/**
 * Debit `amount` ONLY if the balance covers it. Returns true on success.
 * The conditional UPDATE is the race-safe balance gate.
 */
export async function debitStars(userTgId, amount, jobId) {
  const res = await db.update(users)
    .set({ starsBalance: sql`${users.starsBalance} - ${amount}` })
    .where(and(eq(users.tgId, userTgId), gte(users.starsBalance, amount)))
    .run();
  if (affectedCount(res) === 0) return false;
  await recordPayment(userTgId, amount, 'charge', jobId);
  return true;
}

/** Refund a job's charge back to the wallet (used by lib/jobs.js). */
export async function refundStars(userTgId, amount, jobId) {
  await creditStars(userTgId, amount, { kind: 'refund', jobId });
}

async function recordPayment(userTgId, amountStars, kind, jobId) {
  await db.insert(payments)
    .values({
      id: randomId(),
      userTgId,
      amountStars,
      kind,
      jobId,
      status: 'completed',
      createdAt: new Date(),
    })
    .run();
}
