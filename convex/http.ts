import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { env } from "./_generated/server";

// convex/http.ts — public endpoints, served at https://<deployment>.convex.site
//
//   POST /telegram  — the bot's webhook (setWebhook → …/telegram)
//   GET  /healthz   — liveness probe
//
// The webhook is protected by setWebhook's secret_token: Telegram sends it as
// the X-Telegram-Bot-Api-Secret-Token header on every delivery.
//
// Providers that support webhook callbacks can add their own route here in
// the SaaS repo (keep the pattern: verify → runMutation → immediate poll).

const http = httpRouter();

http.route({
  path: "/telegram",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (!secret || secret !== (env.WEBHOOK_SECRET || "")) {
      return new Response("unauthorized", { status: 401 });
    }
    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    // HTTP actions may call actions; the whole update is processed in the
    // action runtime (it needs fetch for Telegram API calls).
    const result = await ctx.runAction(internal.updates.processUpdate, { update });
    return new Response("ok", { status: result.processed ? 200 : 500 });
  }),
});

http.route({
  path: "/healthz",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
