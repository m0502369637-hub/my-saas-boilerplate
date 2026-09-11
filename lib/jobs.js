// lib/jobs.js — the SINGLE source of truth for the job state machine.
//
//   queued → submitted → processing → complete | failed | timed_out
//
// Rules that MUST hold (see AGENTS.md):
//   - Handlers never write jobs.status directly. Every transition goes
//     through this module.
//   - Every terminal transition is a conditional UPDATE on the current
//     status, so two racing invocations can never double-refund or
//     double-deliver.
//   - No handler ever awaits generation completion. Provider interactions
//     are submit-once (fast) or one status poll (fast). Long waits live in
//     the user's 🔄 button, the piggyback sweep (lib/sweep.js), and the
//     optional relay (relay/).
//   - Every failed / timed_out / cancelled path refunds Stars and notifies
//     the user. Nothing fails silently.
import { api, db, fetch, InputFile } from 'sdk';
import { and, eq, inArray, desc, lt } from 'sdk/db';
import { jobs, payments, jobEvents } from 'schema';
import { randomId, newWebhookSecret } from 'lib/ids';
import { affectedCount } from 'lib/db_util';
import { secrets } from 'lib/secrets';
import { refundStars } from 'lib/stars';
import { safe, notify } from 'lib/telegram';
import { getServiceConfig } from 'lib/services/registry';
import * as fal from 'lib/fal_ai';
import * as comfyui from 'lib/comfyui';

export const ACTIVE_STATUSES = ['queued', 'submitted', 'processing'];
export const TERMINAL_STATUSES = ['complete', 'failed', 'timed_out'];

export const STATUS_LABELS = {
  queued: '⏳ Queued',
  submitted: '📨 Submitted',
  processing: '🎞️ Processing',
  complete: '✅ Complete',
  failed: '❌ Failed',
  timed_out: '⚠️ Timed out',
};

/** Pick the provider client for a job — the only place provider identity lives. */
export function providerClient(provider) {
  return provider === 'comfyui' ? comfyui : fal;
}

export async function getJob(id) {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export async function listUserJobs(userTgId, limit = 5) {
  return db.select().from(jobs)
    .where(eq(jobs.userTgId, userTgId))
    .orderBy(desc(jobs.createdAt))
    .limit(limit)
    .all();
}

/** Append an audit row. Never throws — auditing must not break the transition. */
export async function addEvent(jobId, event, payload = null) {
  try {
    await db.insert(jobEvents)
      .values({ id: randomId(), jobId, event, payload, createdAt: new Date() })
      .run();
  } catch (e) {
    console.warn('job event insert failed', { jobId, event, reason: e?.message });
  }
}

// --- creation ----------------------------------------------------------------

/**
 * Insert a `queued` row and return { job, webhookSecret }.
 * `expiresAt` is stamped from the service's maxJobAgeMs so the sweep's
 * timeout check needs no per-service lookup later.
 */
export async function createJob(user, serviceName, inputUrl, cost, maxJobAgeMs = 15 * 60 * 1000) {
  const cfg = getServiceConfig(serviceName);
  const id = randomId();
  const now = new Date();
  const [row] = await db.insert(jobs)
    .values({
      id,
      userTgId: user.tgId,
      serviceName,
      provider: cfg?.provider ?? 'fal_ai',
      status: 'queued',
      inputUrl,
      webhookSecret: newWebhookSecret(),
      costStars: cost,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + maxJobAgeMs),
    })
    .returning()
    .run();
  await addEvent(id, 'queued', { serviceName, provider: row.provider });
  return { job: row, webhookSecret: row.webhookSecret };
}

// --- transitions --------------------------------------------------------------

/**
 * Run the caller's submit closure (one fast provider call), then persist the
 * provider's identifiers and flip queued → submitted.
 * The closure returns { inputUrl, providerJobId, providerStatusUrl }.
 */
export async function submitToProvider(job, submitFn) {
  const submitted = await submitFn();
  await db.update(jobs)
    .set({
      status: 'submitted',
      inputUrl: submitted.inputUrl ?? job.inputUrl,
      providerJobId: submitted.providerJobId,
      providerStatusUrl: submitted.providerStatusUrl,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id))
    .run();
  await addEvent(job.id, 'submitted', {
    providerJobId: submitted.providerJobId,
    providerStatusUrl: submitted.providerStatusUrl,
  });
  return getJob(job.id);
}

/**
 * ONE lightweight provider status call, throttled by the service's
 * pollAfterMs unless `force` is set (the 🔄 button is an explicit poll).
 * Advances the state machine; on completion delivers the video; on provider
 * failure refunds. Returns the fresh row (or null if the job vanished).
 */
export async function pollJob(job, { force = false } = {}) {
  const fresh = await getJob(job.id);
  if (!fresh) return null;
  if (TERMINAL_STATUSES.includes(fresh.status)) return fresh;
  if (!fresh.providerStatusUrl) return fresh; // nothing to poll yet

  const cfg = getServiceConfig(fresh.serviceName) ?? {};
  const pollAfterMs = cfg.pollAfterMs ?? 60 * 1000;
  const lastTouch = fresh.updatedAt?.getTime?.() ?? 0;
  if (!force && Date.now() - lastTouch < pollAfterMs) return fresh; // throttle provider calls

  const result = await providerClient(fresh.provider).getJobStatus(fresh);
  await addEvent(fresh.id, 'polled', { providerStatus: result.status, failed: !!result.failed });

  if (result.failed) return failJob(fresh, result.error ?? 'Provider reported failure');
  if (result.status === 'complete') {
    if (!result.outputUrl) return failJob(fresh, 'Provider completed without a video URL');
    return completeJob(fresh, result.outputUrl);
  }

  // Still running (or queued upstream): touch the row and stay active.
  await db.update(jobs)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(jobs.id, fresh.id))
    .run();
  return getJob(fresh.id);
}

/**
 * Mark complete + send the video. The conditional update is the cross-
 * invocation guard: if another poll already completed this job, we touch
 * nothing and send nothing twice.
 */
export async function completeJob(job, outputUrl) {
  const claimed = await db.update(jobs)
    .set({ status: 'complete', outputUrl, updatedAt: new Date() })
    .where(and(eq(jobs.id, job.id), inArray(jobs.status, ACTIVE_STATUSES)))
    .run();
  if (affectedCount(claimed) === 0) return getJob(job.id); // already terminal

  const fresh = await getJob(job.id);
  await addEvent(job.id, 'completed', { outputUrl });

  try {
    await deliverVideo(fresh, outputUrl);
  } catch (e) {
    console.warn('video delivery failed', { jobId: job.id, reason: e?.message });
    // Delivery is the product — if the user never received the video,
    // refund. Only a job we just completed may be failed this way.
    return failJob(fresh, `Video delivery failed: ${e?.message ?? 'unknown'}`, { fromComplete: true });
  }
  return getJob(job.id);
}

/**
 * Mark failed, refund, notify. `fromComplete` is only for the delivery-
 * failure path inside completeJob.
 */
export async function failJob(job, reason, { fromComplete = false } = {}) {
  const allowed = fromComplete ? [...ACTIVE_STATUSES, 'complete'] : ACTIVE_STATUSES;
  const claimed = await db.update(jobs)
    .set({ status: 'failed', error: reason, updatedAt: new Date() })
    .where(and(eq(jobs.id, job.id), inArray(jobs.status, allowed)))
    .run();
  if (affectedCount(claimed) === 0) return getJob(job.id);

  await addEvent(job.id, 'failed', { reason });
  await refund(job);
  await notify(
    job.userTgId,
    `❌ Generation failed: ${reason}\nYour ${job.costStars} ⭐ have been refunded.`,
  );
  return getJob(job.id);
}

/** Timeout path — same machinery as failJob but its own status + message. */
export async function timeoutJob(job) {
  const claimed = await db.update(jobs)
    .set({ status: 'timed_out', error: 'exceeded max job age', updatedAt: new Date() })
    .where(and(eq(jobs.id, job.id), inArray(jobs.status, ACTIVE_STATUSES)))
    .run();
  if (affectedCount(claimed) === 0) return getJob(job.id);

  await addEvent(job.id, 'timed_out', {});
  await refund(job);
  await notify(
    job.userTgId,
    `⚠️ Your generation took too long and was cancelled. Your ${job.costStars} ⭐ have been refunded.`,
  );
  return getJob(job.id);
}

/**
 * Cron-sweep helper (called by lib/sweep.js): refund everything past its
 * expires_at. Pure local DB work — no provider calls.
 */
export async function timeoutStaleJobs(limit = 10) {
  const stale = await db.select().from(jobs)
    .where(and(inArray(jobs.status, ACTIVE_STATUSES), lt(jobs.expiresAt, new Date())))
    .limit(limit)
    .all();
  for (const job of stale) {
    await timeoutJob(job);
  }
  return stale.length;
}

/**
 * User-initiated cancel. Best-effort provider interrupt first (ComfyUI
 * /interrupt; fal cancel endpoint); then refund unless the provider reports
 * the job actually finished (in which case we poll and deliver instead).
 */
export async function cancelJob(job) {
  const fresh = await getJob(job.id);
  if (!fresh || TERMINAL_STATUSES.includes(fresh.status)) return fresh;

  if (fresh.providerJobId || fresh.providerStatusUrl) {
    try {
      const outcome = await providerClient(fresh.provider).cancel(fresh);
      if (outcome?.alreadyCompleted) return pollJob(fresh, { force: true });
    } catch (e) {
      console.warn('provider cancel failed (refunding anyway)', { jobId: job.id, reason: e?.message });
    }
  }

  await addEvent(fresh.id, 'cancelled', {});
  return failJob(fresh, 'Cancelled by user');
}

/**
 * Refund a job's charge: credit the wallet and record a payments row with
 * kind 'refund'. Idempotent per job — a second call is a no-op.
 */
export async function refund(job) {
  const already = await db.select().from(payments)
    .where(and(eq(payments.jobId, job.id), eq(payments.kind, 'refund')))
    .get();
  if (already) return false;
  await refundStars(job.userTgId, job.costStars, job.id);
  await addEvent(job.id, 'refunded', { amount: job.costStars });
  return true;
}

// --- delivery ------------------------------------------------------------------

/**
 * Send the finished video.
 *   - fal: the CDN URL is public — Telegram fetches it directly.
 *   - comfyui with auth: Telegram would get a 401, so the bot downloads the
 *     bytes itself (30 MB platform fetch cap) and uploads them as InputFile.
 *   - comfyui without auth: public /view URL — Telegram fetches it directly.
 */
async function deliverVideo(job, outputUrl) {
  const base = {
    chat_id: job.userTgId,
    caption: `🎬 ${job.serviceName} — enjoy!`,
    supports_streaming: true,
  };
  if (job.provider === 'comfyui' && secrets.comfyuiApiKey) {
    const bytes = await comfyui.downloadOutput(outputUrl);
    await safe(() => api.sendVideo({ ...base, video: new InputFile(bytes, 'video.mp4', { type: 'video/mp4' }) }));
  } else {
    await safe(() => api.sendVideo({ ...base, video: outputUrl }));
  }
}

// --- optional relay handoff -------------------------------------------------------

/**
 * If a relay is configured (secrets.relayBaseUrl), hand the job to it so it
 * can watch provider status from its own long-lived process and nudge the
 * user the moment the video is ready. Fire-and-forget: failures here must
 * never fail the job — the button + sweep paths still work without it.
 */
export async function trackInRelay(job, messageId) {
  const base = String(secrets.relayBaseUrl ?? '').replace(/\/+$/, '');
  if (!base || !job.providerStatusUrl) return false;

  const payload = {
    jobId: job.id,
    chatId: job.userTgId,
    messageId,
    provider: job.provider,
    webhookSecret: job.webhookSecret,
    statusUrl: job.providerStatusUrl,
    promptId: job.provider === 'comfyui' ? job.providerJobId : null,
    authHeader: job.provider === 'comfyui'
      ? (secrets.comfyuiApiKey ? `Bearer ${secrets.comfyuiApiKey}` : null)
      : (secrets.falKey ? `Key ${secrets.falKey}` : null),
  };

  try {
    await fetch(`${base}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return true;
  } catch (e) {
    console.warn('relay track failed', { jobId: job.id, reason: e?.message });
    return false;
  }
}

// --- rendering ---------------------------------------------------------------------

/** One-line status for /jobs listings. */
export function statusLine(job) {
  return `${STATUS_LABELS[job.status] ?? job.status} · ${job.provider}`;
}

/** Full status card for the job message and its edits. */
export function renderStatusText(job) {
  const created = job.createdAt?.getTime?.() ?? Date.now();
  const mins = Math.max(0, Math.round((Date.now() - created) / 60000));
  const lines = [
    `🎬 <b>${job.serviceName}</b> — <code>${job.id}</code>`,
    `Provider: ${job.provider}`,
    `Status: ${STATUS_LABELS[job.status] ?? job.status}`,
    `Cost: ${job.costStars} ⭐ — refunded automatically on failure or timeout.`,
    `Started ${mins} min ago`,
  ];
  if (job.error) lines.push(`Reason: ${job.error}`);
  return lines.join('\n');
}

/** The [🔄 Check Status][❌ Cancel] keyboard attached to a live job. */
export function statusKeyboard(jobId) {
  return {
    inline_keyboard: [[
      { text: '🔄 Check Status', callback_data: `check:${jobId}` },
      { text: '❌ Cancel', callback_data: `cancel:${jobId}` },
    ]],
  };
}
