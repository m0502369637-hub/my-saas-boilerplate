import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getService } from "./lib/services/registry";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./lib/format";

// jobs.ts — the SINGLE owner of the job state machine:
//
//   queued → submitted → processing → complete | failed | timed_out | cancelled
//
// Rules (see AGENTS.md):
//   - Nothing outside this file writes jobs.status.
//   - Every terminal transition is a conditional transition inside a mutation.
//     Convex serializes mutations, so read-status-then-patch is race-free:
//     two racing settles can never double-refund or double-deliver.
//   - Mutations never call the network (determinism). External I/O (provider
//     calls, Telegram sends) lives in jobs_actions.ts, which drives these
//     mutations.
//   - Every failed/timed_out/cancelled path refunds Stars in the SAME
//     transaction that flips the status.

export type JobRow = Doc<"jobs">;
export type JobId = Id<"jobs">;

export function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}
export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Append an audit row. Runs inside the caller's transaction. */
export async function addEvent(ctx: MutationCtx, jobId: JobId, event: string, detail?: unknown): Promise<void> {
  await ctx.db.insert("job_events", { jobId, event, detail });
}

/** Credit the wallet + audit row for a refunded job. Same transaction. */
async function refund(ctx: MutationCtx, job: JobRow): Promise<void> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_telegramId", (q) => q.eq("telegramId", job.telegramId))
    .first();
  if (user) {
    await ctx.db.patch(user._id, { balance: user.balance + job.cost });
  } else {
    await ctx.db.insert("users", { telegramId: job.telegramId, firstName: "user", balance: job.cost });
  }
  await ctx.db.insert("payments", {
    telegramId: job.telegramId,
    kind: "refund",
    amount: job.cost,
    jobId: job._id,
    description: `refund for ${job.service}`,
  });
  await addEvent(ctx, job._id, "refunded", { amount: job.cost });
}

// --- creation ---------------------------------------------------------------------

/**
 * Balance gate + job row + charge, all in ONE transaction: if the wallet
 * can't cover the cost, nothing is written and { ok: false } comes back.
 */
export const createJob = internalMutation({
  args: {
    telegramId: v.number(),
    service: v.string(),
    input: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const svc = getService(args.service);
    if (!svc) return { ok: false, reason: "unknown_service" as const };

    const user = await ctx.db
      .query("users")
      .withIndex("by_telegramId", (q) => q.eq("telegramId", args.telegramId))
      .first();
    const balance = user?.balance ?? 0;
    if (!user || balance < svc.config.cost) {
      return { ok: false, reason: "insufficient" as const, balance };
    }

    await ctx.db.patch(user._id, { balance: balance - svc.config.cost });

    const now = Date.now();
    const jobId = await ctx.db.insert("jobs", {
      telegramId: args.telegramId,
      service: svc.config.name,
      provider: svc.config.provider,
      status: "queued",
      cost: svc.config.cost,
      input: args.input,
      pollAfterMs: svc.config.pollAfterMs,
      maxJobAgeMs: svc.config.maxJobAgeMs,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("payments", {
      telegramId: args.telegramId,
      kind: "charge",
      amount: svc.config.cost,
      jobId,
      description: `charge for ${svc.config.name}`,
    });
    await addEvent(ctx, jobId, "queued", { service: svc.config.name, provider: svc.config.provider });

    const fresh = await ctx.db
      .query("users")
      .withIndex("by_telegramId", (q) => q.eq("telegramId", args.telegramId))
      .first();
    return { ok: true as const, jobId, balance: fresh?.balance ?? 0 };
  },
});

// --- transitions ------------------------------------------------------------------

/**
 * queued → submitted. Called by the submit action after the provider accepted
 * the job. Scheduling the first poll from here makes it atomic with the
 * transition: if the mutation lands, the poll IS scheduled (durable).
 */
export const markSubmitted = internalMutation({
  args: {
    jobId: v.id("jobs"),
    providerJobId: v.string(),
    providerStatusUrl: v.string(),
    providerCancelUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "queued") return { ok: false };

    await ctx.db.patch(args.jobId, {
      status: "submitted",
      providerJobId: args.providerJobId,
      providerStatusUrl: args.providerStatusUrl,
      providerCancelUrl: args.providerCancelUrl,
      updatedAt: Date.now(),
    });
    await addEvent(ctx, args.jobId, "submitted", { providerJobId: args.providerJobId });
    await ctx.scheduler.runAfter(job.pollAfterMs, internal.jobs_actions.pollJob, {
      jobId: args.jobId,
    });
    return { ok: true };
  },
});

/** Touch the job at poll time (submitted|processing → processing). */
export const markPolled = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || !isActive(job.status)) return;
    await ctx.db.patch(args.jobId, {
      status: "processing",
      lastPollAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Claim the delivery of a finished result. The deliveryStartedAt guard is the
 * cross-invocation lock: exactly one poll/webhook invocation may deliver.
 */
export const beginDelivery = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || isTerminal(job.status) || job.deliveryStartedAt) {
      return { claimed: false, job };
    }
    await ctx.db.patch(args.jobId, { deliveryStartedAt: Date.now(), updatedAt: Date.now() });
    return { claimed: true, job: (await ctx.db.get(args.jobId)) ?? job };
  },
});

/** Mark the delivered job complete. */
export const completeJob = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || !isActive(job.status) || !job.deliveryStartedAt) return { ok: false };
    await ctx.db.patch(args.jobId, {
      status: "complete",
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await addEvent(ctx, args.jobId, "completed", {});
    return { ok: true };
  },
});

/** Active → failed + refund. Idempotent: a terminal job is left untouched. */
export const failJob = internalMutation({
  args: { jobId: v.id("jobs"), error: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || isTerminal(job.status)) return { ok: false };
    await ctx.db.patch(args.jobId, { status: "failed", error: args.error, updatedAt: Date.now() });
    await addEvent(ctx, args.jobId, "failed", { reason: args.error });
    await refund(ctx, job);
    return { ok: true };
  },
});

/** Active → timed_out + refund. */
export const timeoutJob = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || isTerminal(job.status)) return { ok: false };
    await ctx.db.patch(args.jobId, {
      status: "timed_out",
      error: "exceeded max job age",
      updatedAt: Date.now(),
    });
    await addEvent(ctx, args.jobId, "timed_out", {});
    await refund(ctx, job);
    return { ok: true };
  },
});

/**
 * User-initiated cancel: Active → cancelled + refund, and the provider
 * interrupt is scheduled atomically with the transition (best-effort there).
 */
export const cancelJob = internalMutation({
  args: { jobId: v.id("jobs"), telegramId: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.telegramId !== args.telegramId) return { ok: false, reason: "not_found" as const };
    if (isTerminal(job.status)) return { ok: false, reason: "terminal" as const };

    await ctx.db.patch(args.jobId, { status: "cancelled", updatedAt: Date.now() });
    await addEvent(ctx, args.jobId, "cancelled", {});
    await refund(ctx, job);
    if (job.providerJobId) {
      await ctx.scheduler.runAfter(0, internal.jobs_actions.cancelProviderJob, {
        jobId: args.jobId,
      });
    }
    return { ok: true as const, refunded: job.cost };
  },
});

/**
 * fal webhook acceleration: someone (fal, or anything) says a job finished —
 * the safe reaction is an immediate poll, which re-checks with the provider
 * before touching money. Spoofing this only costs one extra poll.
 */
export const handleFalWebhook = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || isTerminal(job.status) || job.provider !== "fal") return { ok: false };
    await ctx.scheduler.runAfter(0, internal.jobs_actions.pollJob, { jobId: args.jobId });
    return { ok: true };
  },
});
