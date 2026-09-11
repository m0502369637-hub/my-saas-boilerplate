import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { env } from "./_generated/server";

// convex/http.ts — public endpoints, served at https://<deployment>.convex.site
//
//   POST /telegram        — the bot's webhook (setWebhook → …/telegram)
//   POST /fal/webhook     — fal queue completion webhook (optional accelerator)
//   GET  /healthz         — liveness probe
//
// The webhook is protected by setWebhook's secret_token: Telegram sends it as
// the X-Telegram-Bot-Api-Secret-Token header on every delivery.

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
  path: "/fal/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId) return new Response("missing jobId", { status: 400 });
    // The webhook only triggers an immediate poll — the poll re-verifies with
    // fal before any money or delivery moves, so a spoofed call is harmless.
    await ctx.runMutation(internal.jobs.handleFalWebhook, { jobId: jobId as any });
    return new Response("ok", { status: 200 });
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
