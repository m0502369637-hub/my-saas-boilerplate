import { defineApp } from "convex/server";
import { v } from "convex/values";

// Declared env vars → typed `env` import from `_generated/server`, validated
// at deploy time. Set values with `npx convex env set NAME value` (prod) or
// by exporting them before `npx convex dev` (local dev).
export default defineApp({
  env: {
    BOT_TOKEN: v.string(), // classic Bot API token from @BotFather
    WEBHOOK_SECRET: v.string(), // setWebhook secret_token; Telegram sends it as a header
    FAL_KEY: v.optional(v.string()), // https://fal.ai/dashboard/keys
    COMFYUI_BASE_URL: v.optional(v.string()), // e.g. https://your-comfyui.example.com
    COMFYUI_API_KEY: v.optional(v.string()), // optional bearer for hosted ComfyUI
  },
});
