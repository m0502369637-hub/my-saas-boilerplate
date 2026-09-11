// handlers/callback_query.js — all inline-button traffic.
//
// Button payloads (all comfortably under the 64-byte callback_data limit):
//   check:<job_id>   — one forced poll; edits the message; delivers the video
//                      if the poll completes the job
//   cancel:<job_id>  — best-effort provider interrupt + refund
//   buy_100_stars    — send the Stars top-up invoice
import { api } from 'sdk';
import { withUpdateClaim } from 'lib/idempotency';
import { safe } from 'lib/telegram';
import { createStarsInvoice, INVOICE_PAYLOAD } from 'lib/stars';
import {
  getJob,
  pollJob,
  cancelJob,
  renderStatusText,
  statusKeyboard,
  TERMINAL_STATUSES,
} from 'lib/jobs';
import { maybeSweep } from 'lib/sweep';

export default async function (cq, ctx) {
  return withUpdateClaim(ctx, async () => {
    // Answer first — otherwise the client keeps the loading spinner for up
    // to a minute. Old queries 400 with "query is too old" (benign).
    await safe(() => api.answerCallbackQuery({ callback_query_id: cq.id }));

    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    if (!cq.from || !chatId || !messageId) return;

    const [op, value] = (cq.data ?? '').split(':');

    switch (op) {
      case 'buy_100_stars':
        await createStarsInvoice(
          chatId,
          100,
          'Top up 100 ⭐ for image→video generations.',
          INVOICE_PAYLOAD,
        );
        break;
      case 'check':
        await handleCheck(cq, value, chatId, messageId);
        break;
      case 'cancel':
        await handleCancel(cq, value, chatId, messageId);
        break;
      default:
        console.warn('unknown callback op', { op });
    }

    await maybeSweep();
  });
}

async function handleCheck(cq, jobId, chatId, messageId) {
  const job = await getJob(jobId);
  if (!job || job.userTgId !== cq.from.id) {
    await editText(chatId, messageId, '🤷 Job not found.');
    return;
  }

  // Terminal states need no provider call — just refresh the card.
  if (TERMINAL_STATUSES.includes(job.status)) {
    await editText(chatId, messageId, renderStatusText(job));
    return;
  }

  // ONE lightweight status call (force = user explicitly asked).
  const fresh = await pollJob(job, { force: true });
  const current = fresh ?? job;

  // If the poll just completed the job, completeJob already sent the video.
  const keyboard = TERMINAL_STATUSES.includes(current.status)
    ? undefined
    : statusKeyboard(jobId);
  await editText(chatId, messageId, renderStatusText(current), keyboard);
}

async function handleCancel(cq, jobId, chatId, messageId) {
  const job = await getJob(jobId);
  if (!job || job.userTgId !== cq.from.id) {
    await editText(chatId, messageId, '🤷 Job not found.');
    return;
  }
  if (TERMINAL_STATUSES.includes(job.status)) {
    await editText(chatId, messageId, renderStatusText(job));
    return;
  }

  await safe(() => api.answerCallbackQuery({ callback_query_id: cq.id, text: 'Cancelling…' }));
  const fresh = await cancelJob(job); // refunds unless the provider already finished
  await editText(chatId, messageId, renderStatusText(fresh ?? job));
}

async function editText(chatId, messageId, text, replyMarkup) {
  const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup) params.reply_markup = replyMarkup;
  await safe(() => api.editMessageText(params));
}
