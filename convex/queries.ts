import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// queries.ts — internal queries the actions use to read bot state.

export type JobRow = Doc<"jobs">;
export type UserRow = Doc<"users">;

export const getJob = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<JobRow | null> => {
    return ctx.db.get(args.jobId);
  },
});

export const getUser = internalQuery({
  args: { telegramId: v.number() },
  handler: async (ctx, args): Promise<UserRow | null> => {
    return (
      (await ctx.db
        .query("users")
        .withIndex("by_telegramId", (q) => q.eq("telegramId", args.telegramId))
        .first()) ?? null
    );
  },
});

export const getJobsForUser = internalQuery({
  args: { telegramId: v.number(), limit: v.number() },
  handler: async (ctx, args): Promise<JobRow[]> => {
    return ctx.db
      .query("jobs")
      .withIndex("by_telegramId", (q) => q.eq("telegramId", args.telegramId))
      .order("desc")
      .take(args.limit);
  },
});

/** Jobs that may still need attention (submitted or processing). */
export const getActiveJobs = internalQuery({
  args: {},
  handler: async (ctx): Promise<JobRow[]> => {
    const submitted = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "submitted"))
      .take(50);
    const processing = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(50);
    return [...submitted, ...processing];
  },
});
