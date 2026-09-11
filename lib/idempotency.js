// lib/idempotency.js — deduplicate at-least-once webhook deliveries.
//
// Guarantees: a redelivery of an update whose handler already COMPLETED is
// skipped (critical for a bot that moves money).
// Non-guarantees: external side effects are not exactly-once; two deliveries
// racing inside the processing window are not excluded. Keep side effects
// late and tolerant (edit instead of send where possible).
//
// Claims are pruned opportunistically by lib/sweep.js — there is no cron.
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { processedUpdates } from 'schema';

/** Returns true if this update_id is new (and records it), false if already claimed. */
export async function claimUpdate(updateId) {
  if (updateId == null) return true; // e.g. `npx tgcloud run` without --ctx
  const rows = await db.insert(processedUpdates)
    .values({ updateId })
    .onConflictDoNothing({ target: processedUpdates.updateId })
    .returning()
    .run();
  return rows.length > 0;
}

/** Remove a claim so a redelivery can retry after a failed attempt. */
export async function releaseUpdate(updateId) {
  if (updateId == null) return;
  await db.delete(processedUpdates).where(eq(processedUpdates.updateId, updateId)).run();
}

/** Run `work` once per update_id; release the claim if it throws. */
export async function withUpdateClaim(ctx, work) {
  const updateId = ctx?.update?.update_id;
  if (!(await claimUpdate(updateId))) {
    console.log('duplicate delivery skipped', { updateId });
    return undefined;
  }
  try {
    return await work();
  } catch (e) {
    try {
      await releaseUpdate(updateId);
    } catch (releaseError) {
      console.warn('could not release update claim', { updateId, reason: releaseError?.message });
    }
    throw e;
  }
}
