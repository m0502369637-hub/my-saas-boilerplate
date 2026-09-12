import type { Service } from "./types";

// lib/services/registry.ts — the ONE list of services this bot offers.
//
// DELIBERATELY EMPTY in the base repo: this boilerplate ships no services.
// Each SaaS repo adds its own service folder and registers it here, e.g.:
//
//   import { myService } from "./my_service/index";
//   export const SERVICES: Record<string, Service> = { my_service: myService };
//
// The base repo must stay free of service accumulation — see services/README.md.

export const SERVICES: Record<string, Service> = {};

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
