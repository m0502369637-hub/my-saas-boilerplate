import type { Doc } from "../_generated/dataModel";

// lib/format.ts — user-facing job status text + keyboards. Pure rendering;
// the state machine (jobs.ts) is the only writer of status values.

export const ACTIVE_STATUSES = ["queued", "submitted", "processing"] as const;
export const TERMINAL_STATUSES = ["complete", "failed", "timed_out", "cancelled"] as const;

export const STATUS_LABELS: Record<string, string> = {
  queued: "⏳ Queued",
  submitted: "📨 Submitted",
  processing: "🎞️ Processing",
  complete: "✅ Complete",
  failed: "❌ Failed",
  timed_out: "⚠️ Timed out",
  cancelled: "🚫 Cancelled",
};

export type JobRow = Doc<"jobs">;

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusLine(job: JobRow): string {
  return `${statusLabel(job.status)} · ${job.provider}`;
}

export function renderStatusText(job: JobRow, serviceTitle: string): string {
  const mins = Math.max(0, Math.round((Date.now() - job.createdAt) / 60000));
  const lines = [
    `${serviceTitle} — <code>${job._id}</code>`,
    `Provider: ${job.provider}`,
    `Status: ${statusLabel(job.status)}`,
    `Cost: ${job.cost} ⭐ — refunded automatically on failure or timeout.`,
    `Started ${mins} min ago`,
  ];
  if (job.error) lines.push(`Reason: ${job.error}`);
  return lines.join("\n");
}

/** The [🔄 Check Status][❌ Cancel] keyboard attached to a live job. */
export function statusKeyboard(jobId: string) {
  return {
    inline_keyboard: [
      [
        { text: "🔄 Check Status", callback_data: `check:${jobId}` },
        { text: "❌ Cancel", callback_data: `cancel:${jobId}` },
      ],
    ],
  };
}
