import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The job state machine: queued → submitted → processing → complete | failed
// | timed_out | cancelled. Mutations in jobs.ts own every transition; nothing
// else may write jobs.status.
export const JOB_STATUSES = [
  "queued",
  "submitted",
  "processing",
  "complete",
  "failed",
  "timed_out",
  "cancelled",
] as const;

export default defineSchema({
  // Internal Stars wallet. telegramId is the business key; _id is internal.
  users: defineTable({
    telegramId: v.number(),
    username: v.optional(v.string()),
    firstName: v.optional(v.string()),
    language: v.optional(v.string()),
    balance: v.number(), // Stars, internal wallet
  }).index("by_telegramId", ["telegramId"]),

  // One row per generation request. Convex mutations are serializable
  // transactions, so every conditional status transition in jobs.ts is
  // race-free by construction.
  jobs: defineTable({
    telegramId: v.number(),
    service: v.string(), // registry key, e.g. "image_to_video"
    provider: v.string(), // registry key of the Provider adapter (repo-defined)
    status: v.union(...JOB_STATUSES.map((s) => v.literal(s))),
    cost: v.number(), // Stars charged at creation
    input: v.optional(v.any()), // service-specific: { prompt? }, { photoFileId? }
    output: v.optional(v.any()), // { url, kind: "video" | "image" } once generated
    providerJobId: v.optional(v.string()), // fal request_id | comfy prompt_id
    providerStatusUrl: v.optional(v.string()),
    providerCancelUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    pollAfterMs: v.number(),
    maxJobAgeMs: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastPollAt: v.optional(v.number()),
    deliveryStartedAt: v.optional(v.number()), // guard against double delivery
    completedAt: v.optional(v.number()),
  })
    .index("by_telegramId", ["telegramId"])
    .index("by_status", ["status"]),

  // Audit trail for money. purchase = Telegram invoice paid; charge = job
  // debit; refund = job failure/timeout/cancel credit.
  payments: defineTable({
    telegramId: v.number(),
    kind: v.union(v.literal("purchase"), v.literal("charge"), v.literal("refund")),
    amount: v.number(), // Stars
    jobId: v.optional(v.id("jobs")),
    description: v.optional(v.string()),
  })
    .index("by_telegramId", ["telegramId"])
    .index("by_jobId", ["jobId"]),

  // Job transition log, appended by jobs.ts on every state change.
  job_events: defineTable({
    jobId: v.id("jobs"),
    event: v.string(),
    detail: v.optional(v.any()),
  }).index("by_jobId", ["jobId"]),

  // Webhook idempotency: Telegram delivers at-least-once, so each update_id
  // is claimed exactly once inside a mutation (query-then-insert is race-free
  // in a transaction).
  processed_updates: defineTable({
    updateId: v.number(),
  }).index("by_updateId", ["updateId"]),

  // Tiny key/value store (e.g. "commands_set" so setMyCommands runs once).
  app_state: defineTable({
    key: v.string(),
    value: v.any(),
  }).index("by_key", ["key"]),
});
