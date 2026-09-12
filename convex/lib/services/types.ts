// lib/services/types.ts — the contract every service module implements.
//
// A service is PURE data + payload building: no database, no network, no
// Convex context. The generic plumbing (jobs, wallet, delivery) knows only
// these shapes, so a new service never touches the state machine.
//
// The BASE repo ships NO services and NO providers — this file is the
// contract a SaaS repo fills in when it adds its own service.

/** What the service extracts from the user's Telegram message. */
export interface JobInput {
  prompt?: string;
  photoFileId?: string; // single photo (non-album message)
  photoFileIds?: string[]; // album (media group) — multi-photo services
  details?: string; // photo caption, for services that take text alongside photos
}

/**
 * Provider-side image references, resolved by the Provider's resolveImages()
 * at submit time (generic names — the provider decides their meaning).
 */
export interface ImageRefs {
  imageUrl?: string; // single image (URL)
  imageUrls?: string[]; // album images (URLs)
  imageName?: string; // single image (server-side name)
}

export interface ServiceConfig {
  /** Registry key — unique, snake_case, used in jobs.service. */
  name: string;
  /** Human title shown in status cards. */
  title: string;
  /** One-liner for /help and /start (no price — that's the SERVICE_COST env var). */
  description: string;
  /** Must match the key of a registered Provider (lib/providers/registry.ts). */
  provider: string;
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
   * Build the provider submission payload from the runtime inputs (photo
   * refs / prompt / caption). Pure function — no network, no DB. The return
   * value is passed verbatim to Provider.submit().
   */
  buildProviderPayload(input: JobInput, images: ImageRefs): unknown;
}
