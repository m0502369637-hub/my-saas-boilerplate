import type { Service } from "./types";
import { imageToVideo } from "./image_to_video/index";

// lib/services/registry.ts — the ONE list of services this bot offers.
//
// This repo ships exactly one worked example (image_to_video). Each real SaaS
// clones this repo into its own and keeps a single entry here (see
// services/README.md). Never accumulate services in the base repo.

export const SERVICES: Record<string, Service> = {
  image_to_video: imageToVideo,
};

export function getService(name: string): Service | null {
  return SERVICES[name] ?? null;
}

/** The service that consumes photos (single-service repos have exactly one). */
export function photoService(): Service | null {
  return Object.values(SERVICES).find((s) => s.config.trigger.kind === "photo") ?? null;
}

/** The service that consumes prompt commands (e.g. /imagine <prompt>). */
export function promptService(): Service | null {
  return Object.values(SERVICES).find((s) => s.config.trigger.kind === "prompt") ?? null;
}
