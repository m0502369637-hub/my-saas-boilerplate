// scripts/dev-poll.ts — local development long-poller.
//
// Telegram cannot reach localhost, so during `npx convex dev` we long-poll
// getUpdates here and forward every update to the LOCAL HTTP action
// (http://127.0.0.1:3210/telegram by default — override with DEV_HTTP_URL).
// The production webhook path (convex/http.ts) is exercised unchanged.
//
// Usage:
//   npx convex dev        (terminal 1)
//   npm run dev:poll      (terminal 2)
//
// Reads .env.local (same file `npx convex dev` picks up): BOT_TOKEN required,
// WEBHOOK_SECRET must match what the dev functions see.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key) out[key] = value;
    }
  } catch {
    /* no .env.local — env vars may already be exported */
  }
  return out;
}

const dotEnv = loadDotEnv(resolve(process.cwd(), ".env.local"));
const env = (name: string): string => process.env[name] ?? dotEnv[name] ?? "";

const BOT_TOKEN = env("BOT_TOKEN");
const WEBHOOK_SECRET = env("WEBHOOK_SECRET") || "dev";
const DEV_HTTP_URL = env("DEV_HTTP_URL") || "http://127.0.0.1:3210";

const API = "https://api.telegram.org";
const ALLOWED = ["message", "callback_query", "pre_checkout_query"];

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required. Put it in .env.local (see .env.example).");
  process.exit(1);
}

async function getUpdates(offset: number): Promise<{ ok: boolean; result: any[] }> {
  const url = `${API}/bot${BOT_TOKEN}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(ALLOWED))}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`getUpdates failed: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return (await res.json()) as { ok: boolean; result: any[] };
}

async function forward(update: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${DEV_HTTP_URL}/telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(update),
    });
    return res.status === 200;
  } catch (e) {
    console.warn("forward failed — is `npx convex dev` running?", e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function main() {
  const me = await fetch(`${API}/bot${BOT_TOKEN}/getMe`).then((r) => r.json());
  console.log(`Polling @${(me as any).result?.username ?? "?"} → ${DEV_HTTP_URL}/telegram`);
  console.log("Ctrl-C to stop.");

  let offset = 0;
  while (true) {
    let batch: any[] = [];
    try {
      const res = await getUpdates(offset);
      batch = res.result ?? [];
    } catch (e) {
      console.warn("getUpdates error, retrying", e instanceof Error ? e.message : String(e));
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const update of batch) {
      const updateId: number = update?.update_id;
      const ok = await forward(update);
      if (ok) {
        offset = Math.max(offset, updateId + 1); // only advance on success so failures are retried
        console.log(`processed update ${updateId}`);
      } else {
        console.warn(`update ${updateId} failed (status != 200) — retrying`);
        break; // stop the batch; the failed update will be redelivered next loop
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
