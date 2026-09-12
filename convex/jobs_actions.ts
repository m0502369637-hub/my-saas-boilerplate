import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { env } from "./_generated/server";
import { internal } from "./_generated/api";
import type { JobRow } from "./queries";
import { getService } from "./lib/services/registry";
import { TERMINAL_STATUSES, renderStatusText } from "./lib/format";
import * as telegram from "./lib/telegram";
import * as fal from "./lib/providers/fal";
import * as comfy from "./lib/providers/comfyui";
import type { ImageRefs, JobInput } from "./lib/services/types";

// jobs_actions.ts — every bit of external I/O the job machine needs.
//
// Mutations in jobs.ts own state; these actions own the outside world:
// provider submit/poll/cancel and Telegram sends. Actions are NOT retried by
// Convex, so each one is built to be safe to run more than once (guarded by
// the conditional mutations) and to reschedule itself when it must live on.

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The provider submission payload, supplied at deploy time (PROVIDER_PAYLOAD
 * env var). The repo carries no sample workflows — this is the single source
 * of the fal model/input template or the ComfyUI workflow graph.
 */
function providerPayload(): Record<string, unknown> {
  const raw = env.PROVIDER_PAYLOAD;
  if (!raw) throw new Error("PROVIDER_PAYLOAD env var is not set (npx convex env set PROVIDER_PAYLOAD '…')");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`PROVIDER_PAYLOAD is not valid JSON: ${errMsg(e)}`);
  }
}

async function notify(ctx: { runQuery: Function }, chatId: number, text: string): Promise<void> {
  try {
    await telegram.sendMessage(chatId, text, { parseMode: "HTML" });
  } catch (e) {
    console.warn("notify failed", { chatId, reason: errMsg(e) });
  }
}

async function editStatus(
  chatId: number | undefined,
  messageId: number | undefined,
  job: JobRow,
): Promise<void> {
  if (!chatId || !messageId) return;
  const svc = getService(job.service);
  await telegram.safe(() =>
    telegram.editMessageText(
      chatId,
      messageId,
      renderStatusText(job, svc?.config.title ?? job.service),
      undefined,
    ),
  );
}

/** Active job → failed (refund inside the mutation) → tell the user. */
async function failAndNotify(
  ctx: { runMutation: Function; runQuery: Function },
  job: JobRow,
  reason: string,
  chatId?: number,
  messageId?: number,
): Promise<void> {
  await ctx.runMutation(internal.jobs.failJob, { jobId: job._id, error: reason });
  const fresh = await ctx.runQuery(internal.queries.getJob, { jobId: job._id });
  await notify(ctx, job.telegramId, `❌ Generation failed: ${reason}\nYour ${job.cost} ⭐ have been refunded.`);
  if (fresh) await editStatus(chatId, messageId, fresh);
}

/** Build the fal webhook URL only in prod (CONVEX_SITE_URL is unset in dev → polling only). */
function falWebhookUrl(job: JobRow): string | null {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) return null;
  return `${site}/fal/webhook?jobId=${encodeURIComponent(job._id)}`;
}

// --- submit -----------------------------------------------------------------------

/**
 * queued job → provider. Resolves the user's photo to provider-side bytes,
 * builds the service payload, submits, and flips the job to submitted via
 * markSubmitted (which also schedules the first poll). Fast: a few HTTP
 * calls, never waits for generation output.
 */
export const submitJob = internalAction({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<{ status: "submitted" | "skipped" | "failed"; error?: string }> => {
    const job = await ctx.runQuery(internal.queries.getJob, { jobId: args.jobId });
    if (!job || job.status !== "queued") return { status: "skipped" };
    const svc = getService(job.service);
    if (!svc) {
      await failAndNotify(ctx, job, `Unknown service ${job.service}`);
      return { status: "failed", error: `Unknown service ${job.service}` };
    }

    try {
      const input = (job.input ?? {}) as JobInput;
      const images: ImageRefs = {};
      if (input.photoFileId) {
        const bytes = await telegram.downloadPhoto(input.photoFileId);
        if (job.provider === "comfyui") {
          const up = await comfy.uploadImage(bytes, "photo.jpg");
          images.comfyName = up.name;
        } else {
          images.falUrl = await fal.uploadImage(bytes, "photo.jpg");
        }
      }

      const payload = svc.buildProviderPayload(providerPayload(), input, images);
      if (payload.kind === "fal") {
        const res = await fal.submitRequest({
          model: payload.model,
          input: payload.input,
          webhookUrl: falWebhookUrl(job),
        });
        await ctx.runMutation(internal.jobs.markSubmitted, {
          jobId: job._id,
          providerJobId: res.requestId,
          providerStatusUrl: res.statusUrl,
          providerCancelUrl: res.cancelUrl ?? undefined,
        });
      } else {
        const res = await comfy.submitWorkflow(payload.workflow, `bot-${job._id}`);
        await ctx.runMutation(internal.jobs.markSubmitted, {
          jobId: job._id,
          providerJobId: res.promptId,
          providerStatusUrl: `${comfy.baseUrl()}/history/${res.promptId}`,
        });
      }
      return { status: "submitted" };
    } catch (e) {
      await failAndNotify(ctx, job, errMsg(e));
      return { status: "failed", error: errMsg(e) };
    }
  },
});

// --- poll / settle ----------------------------------------------------------------

export interface DeliveryOutput {
  url: string;
  kind: "video" | "image";
  requiresDownload?: boolean;
}

/** Deliver a finished result, then complete — or refund on delivery failure. */
async function settleAndDeliver(
  ctx: { runMutation: Function; runQuery: Function },
  job: JobRow,
  output: DeliveryOutput,
  chatId?: number,
  messageId?: number,
): Promise<void> {
  const claimed = await ctx.runMutation(internal.jobs.beginDelivery, { jobId: job._id });
  if (!claimed.claimed) return; // another invocation is already delivering
  const chat = job.telegramId;
  const svc = getService(job.service);
  const caption = svc?.config.title ?? job.service;

  try {
    if (output.requiresDownload) {
      const bytes = await comfy.downloadOutput(output.url);
      if (output.kind === "image") {
        await telegram.sendPhotoBytes(chat, bytes, caption);
      } else {
        await telegram.sendVideoBytes(chat, bytes, caption);
      }
    } else if (output.kind === "image") {
      await telegram.sendPhotoByUrl(chat, output.url, caption);
    } else {
      await telegram.sendVideoByUrl(chat, output.url, caption);
    }
    await ctx.runMutation(internal.jobs.completeJob, { jobId: job._id });
    const fresh = await ctx.runQuery(internal.queries.getJob, { jobId: job._id });
    if (fresh) await editStatus(chatId, messageId, fresh);
  } catch (e) {
    // Delivery is the product — if the user never received it, refund.
    await ctx.runMutation(internal.jobs.failJob, {
      jobId: job._id,
      error: `Result delivery failed: ${errMsg(e)}`,
    });
    const fresh = await ctx.runQuery(internal.queries.getJob, { jobId: job._id });
    await notify(ctx, chat, `❌ Delivery failed: ${errMsg(e)}\nYour ${job.cost} ⭐ have been refunded.`);
    if (fresh) await editStatus(chatId, messageId, fresh);
  }
}

/**
 * ONE provider status check. On completion it settles (deliver → complete,
 * or fail); while running it re-schedules itself after pollAfterMs; past
 * maxJobAgeMs it times out + refunds. Safe to run concurrently/repeatedly.
 */
export const pollJob = internalAction({
  args: { jobId: v.id("jobs"), chatId: v.optional(v.number()), messageId: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runQuery(internal.queries.getJob, { jobId: args.jobId });
    if (!job) return;
    if ((TERMINAL_STATUSES as readonly string[]).includes(job.status)) {
      await editStatus(args.chatId, args.messageId, job);
      return;
    }
    if (job.status === "queued") {
      // Submit hasn't landed yet (rare) — try again shortly.
      await ctx.scheduler.runAfter(5000, internal.jobs_actions.pollJob, { jobId: job._id });
      return;
    }

    await ctx.runMutation(internal.jobs.markPolled, { jobId: job._id });
    const fresh = (await ctx.runQuery(internal.queries.getJob, { jobId: job._id })) ?? job;

    try {
      const result =
        fresh.provider === "comfyui"
          ? await comfy.getJobStatus(fresh.providerJobId ?? "")
          : await fal.getJobStatus({
              statusUrl: fresh.providerStatusUrl ?? "",
              responseUrl: fresh.providerCancelUrl?.replace(/\/cancel$/, "/response") ?? null,
            });

      if (result.status === "complete") {
        if (result.failed) {
          await failAndNotify(ctx, fresh, result.error, args.chatId, args.messageId);
        } else {
          await settleAndDeliver(ctx, fresh, result.output, args.chatId, args.messageId);
        }
        return;
      }

      // Still running — timeout or keep polling.
      if (Date.now() - fresh.createdAt > fresh.maxJobAgeMs) {
        await ctx.runMutation(internal.jobs.timeoutJob, { jobId: fresh._id });
        await notify(
          ctx,
          fresh.telegramId,
          `⚠️ Your generation took too long and was cancelled. Your ${fresh.cost} ⭐ have been refunded.`,
        );
        const after = await ctx.runQuery(internal.queries.getJob, { jobId: fresh._id });
        if (after) await editStatus(args.chatId, args.messageId, after);
        return;
      }

      await ctx.scheduler.runAfter(fresh.pollAfterMs, internal.jobs_actions.pollJob, {
        jobId: fresh._id,
      });
      if (args.messageId) {
        const after = await ctx.runQuery(internal.queries.getJob, { jobId: fresh._id });
        if (after) await editStatus(args.chatId, args.messageId, after);
      }
    } catch (e) {
      // Transient provider error — never fail the job for it; poll again.
      console.warn("poll failed, rescheduling", { jobId: fresh._id, reason: errMsg(e) });
      await ctx.scheduler.runAfter(fresh.pollAfterMs, internal.jobs_actions.pollJob, {
        jobId: fresh._id,
      });
    }
  },
});

/** Best-effort provider cancel, scheduled atomically by cancelJob. */
export const cancelProviderJob = internalAction({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runQuery(internal.queries.getJob, { jobId: args.jobId });
    if (!job) return;
    try {
      if (job.provider === "comfyui") {
        await comfy.cancel(job.providerJobId ?? "");
      } else {
        await fal.cancelRequest(job.providerCancelUrl ?? null);
      }
    } catch (e) {
      console.warn("provider cancel failed (already refunded)", { jobId: job._id, reason: errMsg(e) });
    }
  },
});

// --- cron sweep --------------------------------------------------------------------

/**
 * Belt-and-braces for the scheduler chains (which are durable but let's not
 * bet the money on a single mechanism): time out aged jobs and re-kick polls
 * that fell behind. Runs every minute from crons.ts. Bounded work per run.
 */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<{ timedOut: number; rescheduled: number }> => {
    const jobs = (await ctx.runQuery(internal.queries.getActiveJobs, {})) as JobRow[];
    const now = Date.now();
    let timedOut = 0;
    let rescheduled = 0;

    for (const job of jobs) {
      if (now - job.createdAt > job.maxJobAgeMs && timedOut < 10) {
        await ctx.runMutation(internal.jobs.timeoutJob, { jobId: job._id });
        timedOut++;
        await notify(
          ctx,
          job.telegramId,
          `⚠️ Your generation took too long and was cancelled. Your ${job.cost} ⭐ have been refunded.`,
        );
        continue;
      }
      const lastPoll = job.lastPollAt ?? job.createdAt;
      const graceMs = Math.max(job.pollAfterMs * 3, 3 * 60 * 1000);
      if (now - lastPoll > graceMs && rescheduled < 20) {
        await ctx.scheduler.runAfter(0, internal.jobs_actions.pollJob, { jobId: job._id });
        rescheduled++;
      }
    }
    return { timedOut, rescheduled };
  },
});
