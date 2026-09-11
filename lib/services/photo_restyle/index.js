// lib/services/photo_restyle/index.js — thin orchestration for the service.
//
// ComfyUI img2img: photo in → restyled image out. Built purely by following
// the services/README.md recipe — this file is the ONLY service-specific
// code; the state machine, wallet, sweep, and relay handoff are untouched
// lib/ glue. dispatch() submits and returns; it never awaits output.
import { api } from 'sdk';
import config from 'lib/services/photo_restyle/config';
import comfyWorkflow from 'lib/services/photo_restyle/comfy_workflow';
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
import { reply } from 'lib/telegram';

const INSUFFICIENT_TEXT = (cost) =>
  `💳 This restyle costs ${cost} ⭐ and your balance is too low. ` +
  `The invoice below tops up exactly ${cost} ⭐ — pay it, then send the photo again.`;

export default async function dispatch(user, photoFileId) {
  const chatId = user.tgId;

  // 1. Balance gate.
  if (user.starsBalance < config.cost) {
    await createStarsInvoice(
      chatId,
      config.cost,
      `Top up ${config.cost} ⭐ for one photo restyle.`,
    );
    await reply(chatId, INSUFFICIENT_TEXT(config.cost));
    return null;
  }

  // 2. Job row (queued) + 3. immediate debit.
  const { job } = await createJob(user, config.name, null, config.cost, config.maxJobAgeMs);
  const charged = await debitStars(chatId, config.cost, job.id);
  if (!charged) {
    return failJob(job, 'Insufficient Stars balance (concurrent spend)');
  }
  await addEvent(job.id, 'charged', { amount: config.cost });

  try {
    // 4. Photo bytes → ComfyUI upload → workflow injection → queue submit.
    const bytes = await api.getFileContent(photoFileId);
    const fresh = await submitToProvider(job, () => submitToComfy(bytes));

    // 5. Reply immediately. Handler returns.
    const sent = await api.sendMessage({
      chat_id: chatId,
      text: renderStatusText(fresh),
      reply_markup: statusKeyboard(fresh.id),
      parse_mode: 'HTML',
    });

    // 6. Optional relay handoff (the relay polls /history for us).
    await trackInRelay(fresh, sent.message_id);
    return fresh;
  } catch (e) {
    await failJob(job, e?.message ?? 'Submission failed');
    return null;
  }
}

async function submitToComfy(bytes) {
  // 1. Upload the photo — LoadImage wants a server-side file name.
  const upload = await comfyui.uploadImage(bytes, 'photo.jpg');

  // 2. Walk the graph and inject image/prompt/seed/steps by class_type.
  const graph = comfyui.injectWorkflow(comfyWorkflow, {
    image: upload.name,
    prompt: config.comfyui.prompt,
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
