# my-saas-boilerplate

A **clone-and-reuse boilerplate for monetised Telegram SaaS bots on Convex**: one
worked-example service (`image_to_video`, photo → video), an internal Stars
wallet with Telegram invoices and automatic refunds, and a fully async,
refund-safe job queue built on Convex scheduled functions.

**Each real SaaS is its own repository cloned from this one** — see
[One service per repo](#one-service-per-repo).

## Why Convex instead of Telegram's serverless platform

This boilerplate was originally built for Telegram's `tgcloud` serverless
platform and later moved to Convex. The bot logic is identical; the platform
differences that motivated the move:

| | Telegram Serverless (tgcloud) | Convex (this repo) |
| --- | --- | --- |
| Bot runtime | Telegram's managed isolates, pre-authenticated `api` | Classic Bot API — you hold `BOT_TOKEN` |
| Database | Platform's Drizzle-style DB | Convex DB (transactions, indexes) |
| Cron / timers | ❌ none (piggyback hacks) | ✅ cron + durable scheduled functions |
| Secrets | ❌ shipped in deployed code | ✅ env vars (`npx convex env set`) |
| Inbound HTTP | ❌ none (external relay needed) | ✅ HTTP actions on `*.convex.site` |
| npm packages | ❌ | ✅ (web-standard libs in functions, Node in `"use node"` actions) |
| Job completion | sweep + polling + relay | scheduler chain + fal webhook + cron sweep |

The cost: you run a classic bot — webhook management, token custody, and
update idempotency are yours (all handled for you in this repo).

## Architecture

```
Telegram ──webhook──▶ https://<deployment>.convex.site/telegram
                          │ (secret-token header check)
                          ▼
                    convex/http.ts ──runAction──▶ updates.processUpdate
                          │                        ├─ claim update_id (idempotent)
                          │                        ├─ /start /balance /jobs /help
                          │                        ├─ photo → runJob → jobs.createJob (debit)
                          │                        │              → jobs_actions.submitJob (provider)
                          │                        ├─ successful_payment → credit wallet
                          │                        ├─ callback_query → check/cancel/buy
                          │                        └─ pre_checkout_query → answer ok
                          ▼
   provider (fal / comfyui) ◀──submit── jobs_actions.submitJob
        ▲                                      │
        │ fal webhook (optional accelerator)   │ scheduler.runAfter(pollAfterMs)
        └────────────── /fal/webhook ──▶ jobs_actions.pollJob ◀──┘
                                                 │ terminal? → beginDelivery →
                                                 │ send media → completeJob (or fail + refund)
        cron (every minute) ──▶ jobs_actions.sweep (timeouts + lost polls)
```

- **`convex/http.ts`** — the webhook + provider webhook + healthz.
- **`convex/updates.ts`** — the bot brain (message/callback/checkout routing).
- **`convex/jobs.ts`** — the job state machine (`queued → submitted →
  processing → complete | failed | timed_out | cancelled`). Mutations only;
  every terminal transition refunds in the same transaction.
- **`convex/jobs_actions.ts`** — provider submit/poll/cancel and Telegram
  delivery (actions; the only place external I/O happens).
- **`convex/lib/services/<name>/`** — one pure, provider-agnostic service module.

## Quickstart

Prereqs: Node ≥ 20, a Telegram bot (created in @BotFather), a
[Convex account](https://dashboard.convex.dev), and a provider account
(fal.ai and/or a ComfyUI endpoint).

> ⚠️ If this bot currently runs on Telegram's serverless platform, turn that
> OFF first: @BotFather → your bot → Serverless → turn off. From here on the
> bot is self-hosted via the classic Bot API token.

1. **Install and link a Convex project**

   ```bash
   npm install
   npx convex dev          # first run logs you in and creates the project
   ```

2. **Set the secrets** (production deployment — after the first deploy):

   ```bash
   npx convex env set BOT_TOKEN '123456:ABC…'        # @BotFather → your bot → API token
   npx convex env set WEBHOOK_SECRET "$(openssl rand -hex 16)"
   npx convex env set FAL_KEY '…'                    # https://fal.ai/dashboard/keys
   # and/or, for ComfyUI services:
   npx convex env set COMFYUI_BASE_URL 'https://…'
   npx convex env set COMFYUI_API_KEY '…'            # optional bearer
   ```

3. **Deploy**

   ```bash
   npm run deploy          # npx convex deploy
   ```

4. **Point Telegram at it** (find the site URL in Dashboard → Settings →
   URL; it ends in `.convex.site`):

   ```bash
   cp .env.example .env.local   # fill BOT_TOKEN + WEBHOOK_SECRET
   WEBHOOK_URL=https://<your-deployment>.convex.site npm run webhook:set
   ```

5. **Test**: message the bot → `/start` → send a photo → pay the Stars invoice
   → watch the status card (`🔄 Check Status`) → receive the video.

### Local development

```bash
# terminal 1 — local backend (reads env from .env.local)
npx convex dev

# terminal 2 — long-poll Telegram updates into the local backend
npm run dev:poll
```

Telegram cannot reach localhost, so `scripts/dev-poll.ts` polls `getUpdates`
and forwards each update to `http://127.0.0.1:3210/telegram` — the exact same
production code path. Switch back to webhook mode with `npm run webhook:set`.

## Environment variables

Declared in `convex/convex.config.ts` (deploy-time validated) and available as
the typed `env` import in functions.

| Name | Required | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | ✅ | Classic Bot API token |
| `WEBHOOK_SECRET` | ✅ | `setWebhook` secret_token; verified on every delivery |
| `FAL_KEY` | fal services | fal.ai API key |
| `COMFYUI_BASE_URL` | comfyui services | ComfyUI-compatible endpoint URL |
| `COMFYUI_API_KEY` | optional | Bearer for hosted ComfyUI |

## How it works

### Money

- Users buy Stars with a real Telegram invoice (`sendInvoice`, currency `XTR`).
  The payment arrives as `message.successful_payment` and credits the internal
  wallet (`users.balance`) — the credit amount is trusted from Telegram's
  `total_amount`, never from a callback payload.
- A generation **debits** the wallet and writes a `payments` row in the same
  transaction that creates the job (`jobs.createJob`).
- Every `failed` / `timed_out` / `cancelled` job **refunds** in the same
  transaction that flips the status. Convex serializes mutations, so double
  refunds and double delivery are structurally impossible.
- Idempotency: each `update_id` is claimed exactly once in
  `processed_updates` before any money moves (webhook delivery is
  at-least-once).

### Jobs

`queued → submitted → processing → complete | failed | timed_out | cancelled`,
owned exclusively by `convex/jobs.ts`.

1. Trigger (photo or command) → `createJob` (balance gate + debit + row).
2. `submitJob` resolves the photo (Telegram `getFile` → bytes → provider
   upload), builds the service payload, submits to fal/ComfyUI, flips to
   `submitted`, and — atomically — schedules the first poll.
3. `pollJob` checks the provider; while running it re-schedules itself after
   `pollAfterMs`; past `maxJobAgeMs` it times out + refunds. fal completions
   also arrive via the `/fal/webhook` accelerator (which merely triggers an
   immediate poll — spoofing it is harmless).
4. Completion → `beginDelivery` (exactly-one lock) → send media → `completeJob`
   or refund on delivery failure.
5. A cron sweep (every minute) is the belt-and-braces safety net: it times out
   aged jobs and re-kicks polls that fell behind.

## Adding a service

**Never add a second service folder to this repo.** Clone it, add your service
folder, register it, and deploy in the new repository — full recipe in
[`services/README.md`](services/README.md).

A service is three pure files:

- `convex/lib/services/<name>/config.ts` — name, title, cost, provider,
  `pollAfterMs`, `maxJobAgeMs`, trigger.
- `convex/lib/services/<name>/fal_workflow.ts` and/or `comfy_workflow.ts` —
  model + input template / API-format workflow.
- `convex/lib/services/<name>/index.ts` — `buildProviderPayload()`.

Then register it in `convex/lib/services/registry.ts` and route the trigger in
`convex/updates.ts`. No schema change, no state-machine change.

## Limits worth knowing

- Bot API media uploads cap at 50 MB per file — over-sized provider outputs
  fail delivery and refund automatically.
- HTTP action request/response bodies cap at 20 MB (updates are tiny).
- Callback payloads ≤ 64 bytes (`check:<convex-id>` fits).
- fal video is billed per second of output; `fal-ai/veo3.1/image-to-video` at
  720p/8s costs roughly $1.6 — price your Stars accordingly (this example:
  100 ⭐).
