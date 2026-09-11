import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// users.ts — internal wallet + user rows. Every balance mutation is a single
// serializable transaction: read-balance-check-write inside one mutation is
// race-free by construction (Convex serializes mutations), so there is no
// SQL-style conditional UPDATE needed — but there is also no read-modify-
// write ACROSS awaits anywhere.

export type UserRow = Doc<"users">;

export const upsertUser = internalMutation({
  args: {
    telegramId: v.number(),
    username: v.optional(v.string()),
    firstName: v.optional(v.string()),
    language: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<UserRow> => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_telegramId", (q) => q.eq("telegramId", args.telegramId))
      .first();
    if (existing) {
      const patch: Partial<UserRow> = {};
      if (args.username) patch.username = args.username;
      if (args.firstName) patch.firstName = args.firstName;
      if (args.language) patch.language = args.language;
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      return (await ctx.db.get(existing._id)) ?? existing;
    }
    const id = await ctx.db.insert("users", {
      telegramId: args.telegramId,
      username: args.username,
      firstName: args.firstName ?? "user",
      language: args.language,
      balance: 0,
    });
    return (await ctx.db.get(id)) as UserRow;
  },
});

/**
 * Credit the wallet (Telegram invoice payments and job refunds) and append a
 * payments row. Atomic: balance bump + audit row land or neither does.
 */
export const creditStars = internalMutation({
  args: {
    telegramId: v.number(),
    amount: v.number(),
    kind: v.union(v.literal("purchase"), v.literal("refund")),
    jobId: v.optional(v.id("jobs")),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<number> => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_telegramId", (q) => q.eq("telegramId", args.telegramId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { balance: existing.balance + args.amount });
    } else {
      await ctx.db.insert("users", {
        telegramId: args.telegramId,
        firstName: "user",
        balance: args.amount,
      });
    }
    await ctx.db.insert("payments", {
      telegramId: args.telegramId,
      kind: args.kind,
      amount: args.amount,
      jobId: args.jobId,
      description: args.description,
    });
    const fresh = await ctx.db
      .query("users")
      .withIndex("by_telegramId", (q) => q.eq("telegramId", args.telegramId))
      .first();
    return fresh?.balance ?? args.amount;
  },
});

export const getBalance = internalQuery({
  args: { telegramId: v.number() },
  handler: async (ctx, args): Promise<number> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_telegramId", (q) => q.eq("telegramId", args.telegramId))
      .first();
    return user?.balance ?? 0;
  },
});
