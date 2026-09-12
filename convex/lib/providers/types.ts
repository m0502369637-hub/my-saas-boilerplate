import type { JobRow } from "../../queries";
import type { ImageRefs } from "../services/types";

// lib/providers/types.ts — the provider adapter contract.
//
// The BASE repo ships NO provider implementations (no SDKs, no API keys, no
// provider endpoints). Each SaaS repo implements its own provider(s) against
// this interface and registers them in lib/providers/registry.ts. The job
// state machine (jobs.ts / jobs_actions.ts) only knows this contract.

export type JobPollResult =
  | { status: "processing"; failed: false; queuePosition?: number | null }
  | { status: "complete"; failed: true; error: string }
  | {
      status: "complete";
      failed: false;
      output: { url: string; kind: "video" | "image"; requiresDownload?: boolean };
    };

export interface SubmitResult {
  providerJobId: string;
  providerStatusUrl: string;
  providerCancelUrl?: string;
}

export interface Provider {
  /** Registry key — matches ServiceConfig.provider. */
  name: string;
  /**
   * Turn the user's Telegram photo file ids into provider-side image refs
   * (e.g. upload to the provider's CDN). No photos → resolve trivially.
   */
  resolveImages(photoIds: string[]): Promise<ImageRefs>;
  /**
   * Submit the service-built payload to the provider. MUST return fast —
   * never await generation output.
   */
  submit(job: JobRow, payload: unknown): Promise<SubmitResult>;
  /** ONE status check. Never blocks. */
  getJobStatus(job: JobRow): Promise<JobPollResult>;
  /** Best-effort cancel. */
  cancel(job: JobRow): Promise<{ alreadyCompleted: boolean }>;
  /**
   * Optional: download a finished output (needed when the result URL requires
   * auth that Telegram cannot send).
   */
  downloadOutput?(url: string): Promise<Uint8Array>;
}
