// lib/services/types.ts — the contract every service module implements.
//
// A service is PURE data + payload building: no database, no network, no
// Convex context. The generic plumbing (jobs, wallet, delivery) knows only
// these shapes, so a new service never touches the state machine.

/** What the service extracts from the user's Telegram message. */
export interface JobInput {
  prompt?: string;
  photoFileId?: string; // single photo (non-album message)
  photoFileIds?: string[]; // album (media group) — multi-photo services
  details?: string; // photo caption, for services that take text alongside photos
}

/**
 * Provider-side image references, resolved by the plumbing at submit time:
 * fal → public CDN URL (after uploadImage), comfyui → server file name
 * (after /upload/image). Services consume whichever matches their provider.
 */
export interface ImageRefs {
  falUrl?: string; // single image (fal)
  falUrls?: string[]; // album images (fal)
  comfyName?: string; // single image (comfyui — multi-photo uses the first)
}

export type ProviderPayload =
  | { kind: "fal"; model: string; input: Record<string, unknown> }
  | { kind: "comfyui"; workflow: Record<string, unknown> };

export interface ServiceConfig {
  /** Registry key — unique, snake_case, used in jobs.service. */
  name: string;
  /** Human title shown in status cards. */
  title: string;
  /** One-liner for /help and /start. */
  description: string;
  /** Stars charged per generation (internal wallet). */
  cost: number;
  provider: "fal" | "comfyui";
  /** Poll the provider at most once per this many ms (scheduler chain). */
  pollAfterMs: number;
  /** Auto-timeout + refund once a job outlives this age. */
  maxJobAgeMs: number;
  /** What user input starts a job. */
  trigger: { kind: "photo" } | { kind: "prompt"; command: string };
}

export interface Service {
  config: ServiceConfig;
  /**
   * Merge the env-provided payload (PROVIDER_PAYLOAD, parsed JSON) with the
   * runtime inputs (user photo/prompt). The payload itself NEVER lives in
   * this repo — no sample workflows, no model templates. Pure function.
   */
  buildProviderPayload(
    payload: Record<string, unknown>,
    input: JobInput,
    images: ImageRefs,
  ): ProviderPayload;
}
