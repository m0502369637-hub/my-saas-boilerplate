import { env } from "../_generated/server";

// lib/pricing.ts — the per-generation price, in Telegram Stars.
//
// The price lives ONLY in the SERVICE_COST env var (per deployment), never in
// a repo file — change it anytime without redeploying:
//
//   npx convex env set SERVICE_COST '120'
//
// Each job stamps the cost it was charged onto the job row, so refunds always
// match the charge even if the price changes while jobs are in flight.
export function serviceCost(): number {
  const raw = env.SERVICE_COST ?? "";
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`SERVICE_COST env var must be a positive integer Stars amount (got "${raw}")`);
  }
  return n;
}
