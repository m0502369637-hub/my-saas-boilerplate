// schema.js — the bot's database. Tables are named exports.
//
// Deploy with `npx tgcloud push`, then apply with `npx tgcloud migrate`.
// Deploying code NEVER touches data — schema changes are a separate, reviewed
// migration step. See https://core.telegram.org/bots/serverless#the-database
//
// Platform rules encoded here:
//   - No foreign keys. `jobs.user_tg_id`, `payments.job_id`, … are logical
//     links only; integrity is enforced in application code (lib/jobs.js).
//   - integer() is SQLite 64-bit — Telegram user ids exceed 32 bits.
//   - timestamp_ms mode stores unix milliseconds and reads back JS Date
//     objects, which is what the job state machine compares against.
import { table, integer, text, json, index, sql } from 'sdk/db';

// Telegram users + their internal Stars wallet.
export const users = table('users', {
  tgId:         integer('tg_id').primaryKey(),
  username:     text('username'),
  firstName:    text('first_name').notNull(),
  starsBalance: integer('stars_balance').notNull().default(0),
  createdAt:    integer('created_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
});

// One row per AI generation — the heart of the async job system.
//
// Status lifecycle (managed ONLY by lib/jobs.js):
//   queued → submitted → processing → complete | failed | timed_out
//
// `expires_at` = created_at + the service's maxJobAgeMs; the sweep refunds
// anything still active past it. `webhook_secret` is an opaque per-job token
// used by the optional relay (see relay/) to recognise its own callbacks.
export const jobs = table('jobs', {
  id:                text('id').primaryKey(),
  userTgId:          integer('user_tg_id').notNull(),
  serviceName:       text('service_name').notNull(),
  provider:          text('provider').notNull(), // 'fal_ai' | 'comfyui'
  status:            text('status').notNull().default('queued'),
  inputUrl:          text('input_url'),          // provider-side input artifact (fal CDN URL / ComfyUI image name)
  outputUrl:         text('output_url'),         // final video URL once complete
  providerJobId:     text('provider_job_id'),    // fal request_id / ComfyUI prompt_id
  providerStatusUrl: text('provider_status_url'),// fal status_url / ComfyUI history URL
  webhookSecret:     text('webhook_secret').notNull(),
  error:             text('error'),
  costStars:         integer('cost_stars').notNull().default(100),
  createdAt:         integer('created_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
  updatedAt:         integer('updated_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
  expiresAt:         integer('expires_at', { mode: 'timestamp_ms' }),
}, (t) => ({
  byUser:  index('idx_jobs_user_created').on(t.userTgId, t.createdAt),
  bySweep: index('idx_jobs_status_updated').on(t.status, t.updatedAt),
  byExpiry: index('idx_jobs_status_expires').on(t.status, t.expiresAt),
}));

// Money movements of the internal Stars wallet.
//   kind: 'charge' — wallet top-up from a Telegram Stars invoice, or a job debit
//   kind: 'refund' — job failed / timed out / cancelled
export const payments = table('payments', {
  id:          text('id').primaryKey(),
  userTgId:    integer('user_tg_id').notNull(),
  amountStars: integer('amount_stars').notNull(),
  kind:        text('kind').notNull(),
  jobId:       text('job_id'), // set for job debits/refunds; null for wallet top-ups
  status:      text('status').notNull().default('completed'),
  createdAt:   integer('created_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
}, (t) => ({
  byUser: index('idx_payments_user').on(t.userTgId),
  byJob:  index('idx_payments_job').on(t.jobId),
}));

// Audit trail — one row per lifecycle transition, for support and accounting.
//   event: queued | charged | submitted | polled | webhook | completed |
//          failed | timed_out | cancelled | refunded
export const jobEvents = table('job_events', {
  id:        text('id').primaryKey(),
  jobId:     text('job_id').notNull(),
  event:     text('event').notNull(),
  payload:   json('payload'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
}, (t) => ({
  byJob: index('idx_job_events_job').on(t.jobId),
}));

// Idempotency claims keyed by update_id — webhook delivery is at-least-once,
// and a monetised bot must never double-charge on a redelivery.
export const processedUpdates = table('processed_updates', {
  updateId: integer('update_id').primaryKey(),
  seenAt:   integer('seen_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  bySeen: index('idx_processed_updates_seen').on(t.seenAt),
}));

// Tiny key/value store for bot-level state: sweep throttling, command
// registration, anything else that is global rather than per-user.
export const appState = table('app_state', {
  key:       text('key').primaryKey(),
  value:     json('value'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`),
});
