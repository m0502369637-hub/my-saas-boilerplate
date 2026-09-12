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

// --- media-group (album) buffering ------------------------------------------------
//
// Telegram delivers album photos as SEPARATE updates sharing media_group_id,
// with no "album complete" signal. We buffer each photo and debounce: every
// album update cancels the previous finalize timer and schedules a new one
// 2s out; the finalize action then starts ONE job with all photos.

export interface AlbumState {
  mediaGroupId: string;
  chatId: number;
  telegramId: number;
  fileIds: string[];
  caption: string | null;
  scheduledId: string | null;
}

const albumKey = (mediaGroupId: string) => `album:${mediaGroupId}`;

export const addAlbumPhoto = internalMutation({
  args: {
    mediaGroupId: v.string(),
    fileId: v.string(),
    caption: v.optional(v.string()),
    telegramId: v.number(),
    chatId: v.number(),
  },
  handler: async (ctx, args): Promise<AlbumState> => {
    const key = albumKey(args.mediaGroupId);
    const existing = await ctx.db
      .query("app_state")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    let value: AlbumState;
    if (existing) {
      value = existing.value as AlbumState;
      value.fileIds.push(args.fileId);
      if (args.caption) value.caption = args.caption;
      await ctx.db.patch(existing._id, { value });
    } else {
      value = {
        mediaGroupId: args.mediaGroupId,
        chatId: args.chatId,
        telegramId: args.telegramId,
        fileIds: [args.fileId],
        caption: args.caption ?? null,
        scheduledId: null,
      };
      await ctx.db.insert("app_state", { key, value });
    }
    return value;
  },
});

export const setAlbumScheduled = internalMutation({
  args: { mediaGroupId: v.string(), scheduledId: v.id("_scheduled_functions") },
  handler: async (ctx, args) => {
    const key = albumKey(args.mediaGroupId);
    const existing = await ctx.db
      .query("app_state")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!existing) return;
    const value = existing.value as AlbumState;
    value.scheduledId = args.scheduledId;
    await ctx.db.patch(existing._id, { value });
  },
});

export const clearAlbum = internalMutation({
  args: { mediaGroupId: v.string() },
  handler: async (ctx, args) => {
    const key = albumKey(args.mediaGroupId);
    const existing = await ctx.db
      .query("app_state")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const getAlbumState = internalQuery({
  args: { mediaGroupId: v.string() },
  handler: async (ctx, args): Promise<AlbumState | null> => {
    const row = await ctx.db
      .query("app_state")
      .withIndex("by_key", (q) => q.eq("key", albumKey(args.mediaGroupId)))
      .first();
    return (row?.value as AlbumState) ?? null;
  },
});
