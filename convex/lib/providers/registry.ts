import type { Provider } from "./types";

// lib/providers/registry.ts — the provider registry.
//
// DELIBERATELY EMPTY in the base repo: this boilerplate ships no provider
// implementations. Each SaaS repo adds its own (e.g. providers/my_provider.ts)
// and registers it here, e.g.:
//
//   import { myProvider } from "./my_provider";
//   export const PROVIDERS: Record<string, Provider> = { my_provider: myProvider };
//
// The job state machine resolves providers through getProvider().

export const PROVIDERS: Record<string, Provider> = {};

export function getProvider(name: string): Provider | null {
  return PROVIDERS[name] ?? null;
}
