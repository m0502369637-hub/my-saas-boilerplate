// lib/services/text_to_image/index.js — thin orchestration for the service.
//
// The third service built on this boilerplate (after image_to_video and
// photo_restyle) — and proof of the recipe: everything between the balance
// check and the status keyboard is generic lib/ glue. This file only knows
// (a) that its input is TEXT, not a photo, and (b) which fal model to call.
//
// dispatch() runs inside the message-handler invocation and MUST return fast:
// submit + reply + return. Completion arrives via 🔄 / sweep / relay.
import { api } from 'sdk';
import config from 'lib/services/text_to_image/config';
import falWorkflow from 'lib/services/text_to_image/fal_workflow';
import * as fal from 'lib/fal_ai';
import {
  createJob,
  submitToProvider,
  failJob,
  addEvent,
  renderStatusText,
  statusKeyboard,
  trackInRelay,
} from 'lib/jobs';
import { createStarsInvoice, debitStars } from 'lib/stars';
import { secrets } from 'lib/secrets';
import { reply } from 'lib/telegram';

const INSUFFICIENT_TEXT = (cost) =>
  `💳 This generation costs ${cost} ⭐ and your balance is too low. ` +
  `The invoice below tops up exactly ${cost} ⭐ — pay it, then send /imagine again.`;

export default async function dispatch(user, prompt) {
  const chatId = user.tgId;

  // 1. Balance gate.
  if (user.starsBalance < config.cost) {
    await createStarsInvoice(
      chatId,
      config.cost,
      `Top up ${config.cost} ⭐ for one text→image generation.`,
    );
    await reply(chatId, INSUFFICIENT_TEXT(config.cost));
    return null;
  }

  // 2. Job row (queued). The prompt itself is the input artifact.
  const { job } = await createJob(user, config.name, prompt, config.cost, config.maxJobAgeMs);

  // 3. Immediate debit — refunded on every failure path.
  const charged = await debitStars(chatId, config.cost, job.id);
  if (!charged) {
    return failJob(job, 'Insufficient Stars balance (concurrent spend)');
  }
  await addEvent(job.id, 'charged', { amount: config.cost });

  try {
    // 4. Submit. No file upload at all — text goes straight to the model.
    const fresh = await submitToProvider(job, () => submitToFal(prompt, job));

    // 5. Reply immediately with the status board. Handler returns.
    const sent = await api.sendMessage({
      chat_id: chatId,
      text: renderStatusText(fresh),
      reply_markup: statusKeyboard(fresh.id),
      parse_mode: 'HTML',
    });

    // 6. Optional relay handoff (fire-and-forget).
    await trackInRelay(fresh, sent.message_id);
    return fresh;
  } catch (e) {
    await failJob(job, e?.message ?? 'Submission failed');
    return null;
  }
}

async function submitToFal(prompt, job) {
  const input = {
    ...falWorkflow.input,
    prompt,
    num_images: config.fal.numImages,
    aspect_ratio: config.fal.aspectRatio,
    output_format: config.fal.outputFormat,
  };
  const res = await fal.submitRequest({
    model: falWorkflow.model ?? config.fal.model,
    input,
    webhookUrl: falWebhookUrl(job),
  });
  return {
    inputUrl: prompt,
    providerJobId: res.requestId,
    providerStatusUrl: res.statusUrl,
  };
}

function falWebhookUrl(job) {
  const base = String(secrets.relayBaseUrl ?? '').replace(/\/+$/, '');
  if (!base) return null;
  const q = `?job_id=${encodeURIComponent(job.id)}&chat_id=${job.userTgId}`;
  return `${base}/webhook/fal_ai/${job.webhookSecret}${q}`;
}
