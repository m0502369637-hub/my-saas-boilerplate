import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// convex/crons.ts — recurring maintenance. The per-job lifecycle runs on
// scheduler chains (durable, self-rescheduling); these are the safety nets.

const crons = cronJobs();

// Time out aged jobs + re-kick polls that fell behind. At most one run at a
// time; work is bounded inside the action.
crons.interval("job sweep", { minutes: 1 }, internal.jobs_actions.sweep);

// Prune idempotency + audit rows (updates: 7 days, events: 30 days).
// Cutoffs are computed inside the mutation at execution time.
crons.interval("prune old rows", { hours: 12 }, internal.maintenance.prune);

export default crons;
