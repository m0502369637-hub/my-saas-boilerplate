// lib/sweep.js — the cron replacement.
//
// Telegram Serverless has NO scheduled triggers. This sweep piggybacks on
// user activity instead: after every message / callback, the handlers call
// maybeSweep(), which:
//   1. throttles itself (max once per minute, recorded in app_state),
//   2. times out every job past its expires_at (cheap local SQL, refunds),
//   3. polls up to 5 jobs whose status is submitted/processing and whose
//      updated_at is older than 90s — one status call each,
//   4. stops early when close to the ~20s budget so the handler invocation
//      that carries it is never endangered.
//
// If the platform ever adds scheduled triggers, this module's body is the
// drop-in for the future handlers/cron.js — the state machine it drives
// (lib/jobs.js) does not care who polls.
import { db } from 'sdk';
import { and, inArray, lt } from 'sdk/db';
import { jobs, processedUpdates } from 'schema';
import { getState, setState } from 'lib/app_state';
import { pollJob, timeoutStaleJobs } from 'lib/jobs';

const KEY = 'sweep.last_run';
const MIN_INTERVAL_MS = 60 * 1000;   // sweep at most once per minute
const POLL_STALE_MS = 90 * 1000;     // only poll jobs untouched for 90s
const CONCURRENCY_CAP = 5;           // provider calls per sweep
const BUDGET_MS = 20 * 1000;         // stop when this close to the handler's end
const RESERVE_MS = 3000;             // always leave at least this much headroom

export async function maybeSweep() {
  const now = Date.now();
  const last = await getState(KEY);
  if (last?.t && now - last.t < MIN_INTERVAL_MS) return 0;

  // Claim the slot BEFORE doing work so concurrent invocations don't pile on.
  await setState(KEY, { t: now });
  const deadline = now + BUDGET_MS;

  // 1. Local, cheap, first: refund everything past its expiry.
  await timeoutStaleJobs(10);

  // 2. Bounded provider polls.
  const due = await db.select().from(jobs)
    .where(and(
      inArray(jobs.status, ['submitted', 'processing']),
      lt(jobs.updatedAt, new Date(now - POLL_STALE_MS)),
    ))
    .limit(CONCURRENCY_CAP)
    .all();

  let polled = 0;
  for (const job of due) {
    if (Date.now() + RESERVE_MS > deadline) break; // not enough room for one more call
    try {
      await pollJob(job, { force: true });
      polled += 1;
    } catch (e) {
      console.warn('sweep poll failed', { jobId: job.id, reason: e?.message });
    }
    if (Date.now() > deadline) break;
  }

  // 3. Housekeeping: prune old idempotency claims (piggybacked — no cron).
  try {
    await db.delete(processedUpdates)
      .where(lt(processedUpdates.seenAt, new Date(now - 172800 * 1000)))
      .run();
  } catch {
    // pruning is best-effort
  }

  return polled;
}
