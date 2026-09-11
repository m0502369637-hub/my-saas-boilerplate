// lib/services/types.ts — the contract every service module implements.
//
// A service is PURE data + payload building: no database, no network, no
// Convex context. The generic plumbing (jobs, wallet, delivery) knows only
// these shapes, so a new service never touches the state machine.

/** What the service extracts from the user's Telegram message. */
export interface JobInput {
  prompt?: string;
  photoFileId?: string;
}

/**
 * Provider-side image references, resolved by the plumbing at submit time:
 * fal → public CDN URL (after uploadImage), comfyui → server file name
 * (after /upload/image). Services consume whichever matches their provider.
 */
export interface ImageRefs {
  falUrl?: string;
  comfyName?: string;
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
  /** Build the provider submission payload from user input + resolved images. */
  buildProviderPayload(input: JobInput, images: ImageRefs): ProviderPayload;
}
