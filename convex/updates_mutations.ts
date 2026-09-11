import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// updates_mutations.ts — small bookkeeping mutations for update handling.

/**
 * Idempotency claim: Telegram delivers updates at-least-once, and a webhook
 * retry can re-deliver the same update_id. Claim inside a transaction
 * (query-then-insert is race-free) so each update is processed exactly once.
 */
export const claimUpdate = internalMutation({
  args: { updateId: v.number() },
  handler: async (ctx, args): Promise<boolean> => {
    const existing = await ctx.db
      .query("processed_updates")
      .withIndex("by_updateId", (q) => q.eq("updateId", args.updateId))
      .first();
    if (existing) return false;
    await ctx.db.insert("processed_updates", { updateId: args.updateId });
    return true;
  },
});

export const setAppState = internalMutation({
  args: { key: v.string(), value: v.any() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("app_state")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (existing) await ctx.db.patch(existing._id, { value: args.value });
    else await ctx.db.insert("app_state", { key: args.key, value: args.value });
  },
});

export const getAppState = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<unknown> => {
    const row = await ctx.db
      .query("app_state")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    return row?.value ?? null;
  },
});
