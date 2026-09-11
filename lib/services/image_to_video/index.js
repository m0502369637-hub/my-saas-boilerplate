// lib/services/image_to_video/index.js — thin orchestration for the service.
//
// dispatch() runs INSIDE the message-handler invocation and MUST return fast
// (platform invocations are short-lived). The whole flow:
//   1. wallet check       2. create the job row (queued)
//   3. debit Stars        4. upload the photo + submit to the provider
//   5. reply with [🔄 Check Status][❌ Cancel]
//   6. RETURN — completion is discovered later via the button, the sweep,
//      or the optional relay. This function never awaits generation output.
//
// When cloning this folder for a new service, this file is the only one that
// knows anything about photos/videos — everything else is generic lib/ glue.
import { api } from 'sdk';
import config from 'lib/services/image_to_video/config';
import falWorkflow from 'lib/services/image_to_video/fal_workflow';
import comfyWorkflow from 'lib/services/image_to_video/comfy_workflow';
import * as fal from 'lib/fal_ai';
import * as comfyui from 'lib/comfyui';
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
  `The invoice below tops up exactly ${cost} ⭐ — pay it, then send the photo again.`;

export default async function dispatch(user, photoFileId) {
  const chatId = user.tgId;

  // 1. Balance gate — no job row, no provider call, no charge until this passes.
  if (user.starsBalance < config.cost) {
    await createStarsInvoice(
      chatId,
      config.cost,
      `Top up ${config.cost} ⭐ for one image→video generation.`,
      'buy_100_stars',
    );
    await reply(chatId, INSUFFICIENT_TEXT(config.cost));
    return null;
  }

  // 2. Job row (queued) …
  const { job } = await createJob(user, config.name, null, config.cost, config.maxJobAgeMs);

  // 3. … and the immediate debit. Every failure path below refunds this.
  const charged = await debitStars(chatId, config.cost, job.id);
  if (!charged) {
    return failJob(job, 'Insufficient Stars balance (concurrent spend)');
  }
  await addEvent(job.id, 'charged', { amount: config.cost });

  try {
    // 4. Download the photo once, then hand it to the chosen provider.
    //    getFileContent resolves the file_id behind the scenes.
    const bytes = await api.getFileContent(photoFileId);

    const fresh = await submitToProvider(job, async () => {
      if (config.provider === 'comfyui') return submitToComfy(bytes, job);
      return submitToFal(bytes, job);
    });

    // 5. Reply immediately — the last awaited user-facing work of this call.
    const sent = await api.sendMessage({
      chat_id: chatId,
      text: renderStatusText(fresh),
      reply_markup: statusKeyboard(fresh.id),
      parse_mode: 'HTML',
    });

    // 6. Optional: let the relay watch completion for us (fire-and-forget).
    await trackInRelay(fresh, sent.message_id);

    return fresh;
  } catch (e) {
    // Submit/upload failure (4xx, 5xx, network) → refund + notify. Never silent.
    await failJob(job, e?.message ?? 'Submission failed');
    return null;
  }
}

// --- provider-specific submit closures -----------------------------------------
// Each does 2–3 fast HTTP calls and returns the identifiers lib/jobs.js
// persists. No waiting for generation output, ever.

async function submitToFal(bytes, job) {
  // 1. Telegram file_id → fal CDN URL (the model needs a public image_url).
  const imageUrl = await fal.uploadImage(bytes, 'photo.jpg');

  // 2. If a relay is configured, fal POSTs the result there when done; the
  //    per-job secret in the URL lets the relay recognise its own callback.
  const webhookUrl = falWebhookUrl(job);

  const input = {
    ...falWorkflow.input,
    image_url: imageUrl,
    prompt: config.fal.prompt,
    duration: config.fal.duration,
    resolution: config.fal.resolution,
    generate_audio: config.fal.generateAudio,
  };

  // 3. Queue submit — returns immediately.
  const res = await fal.submitImageToVideo({
    model: falWorkflow.model ?? config.fal.model,
    input,
    webhookUrl,
  });
  return {
    inputUrl: imageUrl,
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

async function submitToComfy(bytes, job) {
  // 1. Upload the photo to the ComfyUI server — LoadImage wants a server-
  //    side file name, not bytes or a Telegram id.
  const upload = await comfyui.uploadImage(bytes, 'photo.jpg');

  // 2. Walk the workflow graph and inject image/prompt/seed/steps by class.
  const graph = comfyui.injectWorkflow(comfyWorkflow, {
    image: upload.name,
    prompt: config.fal.prompt, // shared creative prompt, provider-agnostic
    seed: config.comfyui.seed,
    steps: config.comfyui.steps,
    imageNode: config.comfyui.inputNodes.image,
    promptNode: config.comfyui.inputNodes.prompt,
    seedNode: config.comfyui.inputNodes.seed,
  });

  // 3. Queue submit — returns { promptId } immediately.
  const res = await comfyui.submitWorkflow(graph);
  return {
    inputUrl: `${upload.subfolder ? `${upload.subfolder}/` : ''}${upload.name}`,
    providerJobId: res.promptId,
    providerStatusUrl: res.statusUrl,
  };
}
