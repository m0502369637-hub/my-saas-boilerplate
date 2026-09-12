import { defineApp } from "convex/server";
import { v } from "convex/values";

// Declared env vars → typed `env` import from `_generated/server`, validated
// at deploy time. Set values with `npx convex env set NAME value` (prod) or
// by exporting them before `npx convex dev` (local dev).
//
// NOTE: no provider-specific vars here — the base repo ships no providers.
// A SaaS repo adds its provider's secrets to its own copy of this file.
export default defineApp({
  env: {
    BOT_TOKEN: v.string(), // classic Bot API token from @BotFather
    WEBHOOK_SECRET: v.string(), // setWebhook secret_token; Telegram sends it as a header
    // Price per generation, in Telegram Stars (positive integer). Lives ONLY
    // here — change it anytime without redeploying:
    //   npx convex env set SERVICE_COST '120'
    SERVICE_COST: v.string(),
  },
});
