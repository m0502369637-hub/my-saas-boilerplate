// scripts/set-webhook.ts — point Telegram at the deployed Convex HTTP action.
//
// Usage (after `npm run deploy`):
//   WEBHOOK_URL=https://<deployment>.convex.site npm run webhook:set
//   WEBHOOK_URL=https://<deployment>.convex.site npm run webhook:set -- --delete
//
// Reads BOT_TOKEN and WEBHOOK_SECRET from .env.local (or the environment).

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
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env.local */
  }
  return out;
}

const dotEnv = loadDotEnv(resolve(process.cwd(), ".env.local"));
const env = (name: string): string => process.env[name] ?? dotEnv[name] ?? "";

const BOT_TOKEN = env("BOT_TOKEN");
const WEBHOOK_SECRET = env("WEBHOOK_SECRET") || "dev";
const WEBHOOK_URL = env("WEBHOOK_URL");
const DELETE = process.argv.includes("--delete");

const API = "https://api.telegram.org";
const ALLOWED = ["message", "callback_query", "pre_checkout_query"];

async function call(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  if (!BOT_TOKEN) {
    console.error("BOT_TOKEN is required. Put it in .env.local (see .env.example).");
    process.exit(1);
  }

  if (DELETE) {
    console.log(await call("deleteWebhook", {}));
    console.log(await call("getWebhookInfo", {}));
    return;
  }

  if (!WEBHOOK_URL) {
    console.error("WEBHOOK_URL is required, e.g. https://happy-animal-123.convex.site");
    process.exit(1);
  }
  const url = `${WEBHOOK_URL.replace(/\/+$/, "")}/telegram`;
  const set = await call("setWebhook", {
    url,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ALLOWED,
  });
  console.log("setWebhook:", set);
  console.log("info:", await call("getWebhookInfo", {}));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
