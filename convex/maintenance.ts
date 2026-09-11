import { internalMutation } from "./_generated/server";

// maintenance.ts — periodic housekeeping from crons.ts.

export const prune = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ updates: number; events: number }> => {
    // Compute cutoffs at EXECUTION time — cron arguments are frozen at deploy.
    const updateCutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const eventCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let updates = 0;
    const staleUpdates = await ctx.db
      .query("processed_updates")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", updateCutoffMs))
      .take(500);
    for (const row of staleUpdates) {
      await ctx.db.delete(row._id);
      updates++;
    }

    let events = 0;
    const staleEvents = await ctx.db
      .query("job_events")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", eventCutoffMs))
      .take(500);
    for (const row of staleEvents) {
      await ctx.db.delete(row._id);
      events++;
    }
    return { updates, events };
  },
});
