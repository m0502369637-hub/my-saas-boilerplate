import { defineApp } from "convex/server";
import { v } from "convex/values";

// Declared env vars → typed `env` import from `_generated/server`, validated
// at deploy time. Set values with `npx convex env set NAME value` (prod) or
// by exporting them before `npx convex dev` (local dev).
export default defineApp({
  env: {
    BOT_TOKEN: v.string(), // classic Bot API token from @BotFather
    WEBHOOK_SECRET: v.string(), // setWebhook secret_token; Telegram sends it as a header
    // The provider submission payload, supplied at deploy time — the repo
    // carries NO sample workflows. JSON string, one of:
    //   fal:     {"model": "fal-ai/…", "input": {…model input template…}}
    //   comfyui: {"workflow": {…ComfyUI API-format graph…}}
    PROVIDER_PAYLOAD: v.string(),
    // Price per generation, in Telegram Stars (positive integer). Lives ONLY
    // here — change it anytime without redeploying:
    //   npx convex env set SERVICE_COST '120'
    SERVICE_COST: v.string(),
    FAL_KEY: v.optional(v.string()), // https://fal.ai/dashboard/keys
    COMFYUI_BASE_URL: v.optional(v.string()), // e.g. https://your-comfyui.example.com
    COMFYUI_API_KEY: v.optional(v.string()), // optional bearer for hosted ComfyUI
  },
});
