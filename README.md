# Telegram Serverless SaaS Boilerplate

A production-ready, clone-and-reuse starter for monetised AI bots on
[Telegram Serverless](https://core.telegram.org/bots/serverless) — Telegram's
own V8-isolate backend platform. The worked example is a complete
**image → video** microservice (Fal AI **or** ComfyUI) costing
**100 Telegram Stars** per generation, built to survive the platform's
short-lived invocations and jobs that run from 30 seconds to 10+ minutes.

- 💰 Telegram Stars payments (XTR invoices, internal wallet, automatic refunds)
- 🎬 Multi-provider generation: **Fal AI queue API** and **ComfyUI** (self-hosted or hosted)
- 🔄 Async job state machine: `queued → submitted → processing → complete | failed | timed_out`
- 🛟 Three completion paths: provider webhook (relay), client polling, piggyback sweep
- 🧱 Drop-in `lib/services/` layer — a new SaaS is a copy-paste + one config edit
- 📜 Full audit trail (`job_events`, `payments`), idempotent delivery, race-safe refunds

---

## 1. Platform reality — read this first

This repo was written against the **official platform docs** and the
[Telegram Serverless agent skill](https://github.com/yousifraad01/Telegram-Serverless-Skill),
not against generic serverless assumptions. The platform:

| Has | Does **not** have |
| --- | --- |
| V8 isolates running `schema.js`, `lib/**`, `handlers/*.js` | Inbound HTTP endpoints (no third-party webhooks *into* the bot) |
| SQLite + Drizzle-style `sdk/db` | Cron / scheduled triggers / queues / workers |
| Bot API (`api.*`, XTR invoices), outbound `fetch` | npm packages, filesystem, Node builtins |
| Bare-name imports (`'sdk'`, `'schema'`, `'lib/x'`) | Environment access, `process.env`, a secrets store |
| At-least-once webhook delivery | Foreign keys (`.references()` throws at declaration) |

Every design decision below is a consequence of that table. Where a
conventional architecture would use a feature the platform lacks, this repo
uses the platform-legal equivalent:

| Conventional piece | Where it lives here |
| --- | --- |
| `handlers/webhook.js` (receive Fal webhook) | **`relay/relay.mjs`** — tiny user-hosted Node app; route `POST /webhook/:provider/:secret` is preserved there |
| `handlers/cron.js` (60s scheduled sweep) | **`lib/sweep.js`** — piggybacked on user activity, self-throttled to 1/min, budget ≤ 20s, concurrency ≤ 5 |
| Root `services/` folder | **`lib/services/`** — `lib/` is the only directory allowed to nest; bare-name imports resolve there |
| `fal_workflow.json` / `comfy_workflow.json` | **`.js` modules** — the platform deploys only `.js` files, no JSON assets |
| `.env` / `tgcloud secrets set` | **`lib/secrets.js`** — the only deployable place credentials can live (root `.env.example` documents it and feeds the relay only) |
| `npx tgcloud logs -f` | `npx tgcloud run …` (console output) and BotFather's in-chat runner |

## 2. Repository layout

```
my-saas-boilerplate/
├── schema.js                 # users, jobs, payments, job_events (+ claims, app_state)
├── handlers/                 # flat, one file per Telegram update type
│   ├── message.js            # commands, photos, successful_payment
│   ├── callback_query.js     # check:<job_id> / cancel:<job_id> / buy_100_stars
│   ├── pre_checkout_query.js # REQUIRED accept-step for XTR invoices
│   └── README.md             # why webhook.js/cron.js can't be handlers
├── lib/                      # shared modules (nestable — the real module system)
│   ├── secrets.js            # ★ provider credentials — edit before deploying
│   ├── jobs.js               # ★ the job state machine (single source of truth)
│   ├── sweep.js              # the cron replacement (timeouts + bounded polls)
│   ├── stars.js              # XTR invoices + internal wallet + payments rows
│   ├── fal_ai.js             # Fal queue client (submit/status/result/cancel/upload)
│   ├── comfyui.js            # ComfyUI client (upload/prompt/history/view/interrupt)
│   ├── http.js               # fetch + retry-once (no timers — undocumented)
│   ├── telegram.js, auth.js, ids.js, idempotency.js, app_state.js, db_util.js
│   └── services/             # ★ the SaaS layer — one folder per business module
│       └── image_to_video/   # the worked example (photo → video, Fal + ComfyUI)
├── services/                 # the drop-in recipe (pointer; code lives in lib/services/)
├── relay/                    # OPTIONAL webhook watcher (user-hosted Node, zero deps)
├── .env.example              # relay env + reference map to lib/secrets.js
└── AGENTS.md                 # constraints for AI coding agents
```

## 3. Quick start — deploy in five minutes

```bash
git clone <this-repo> my-saas && cd my-saas
npm install                        # installs @tgcloud/cli locally

# In @BotFather: your bot → Serverless → turn it on → CLI Access → Access token
# (an app123456:XXXX token — different from the Bot API token)
npx tgcloud login

# Put provider credentials in lib/secrets.js  ★
#   falKey:        from https://fal.ai/dashboard/keys        (for fal_ai)
#   comfyuiBaseUrl: https://your-comfyui.example.com          (for comfyui)

npx tgcloud status                  # offline diff: what will be deployed
npx tgcloud push                    # deploy all modules atomically
npx tgcloud migrate                 # apply schema.js (six tables; additive = "safe")
npx tgcloud webhook                 # confirm in sync: message, callback_query, pre_checkout_query

# Smoke-test without deploying (runs on the platform with real api/db — use a test chat id):
npx tgcloud run handlers/message '{ chat: { id: 1, type: "private" }, from: { id: 1, first_name: "Test" }, text: "/start" }' --ctx '{ update: { update_id: 1 } }'
```

> **Deploying never touches data.** `push` ships code; `migrate` is the
> separate, reviewed step that changes the database. Schema changes land in
> `migrate` as *safe* (additive) — confirm them there.
>
> There is no `tgcloud logs` command and no `tgcloud secrets` command. Live
> handler console output shows in `npx tgcloud run` and in BotFather's
> in-chat runner; secrets live in `lib/secrets.js`.

Open the bot in Telegram: send `/start`, then a photo. With no balance you
get an XTR invoice; pay it, resend the photo, and the job board appears:
`🔄 Check Status` / `❌ Cancel`. When it finishes — however it finishes — you
get the video or a refund message. Every transition lands in `job_events`.

## 4. Clone & build philosophy

The repo's core value is that **new business modules drop in without touching
the plumbing**. Copy the reference service, edit one config, register, route:

```bash
cp -r lib/services/image_to_video lib/services/memes_to_music
# 1. lib/services/memes_to_music/config.js  → name, cost, provider, prompt
# 2. lib/services/registry.js               → one line
# 3. handlers/message.js                    → one route
npx tgcloud push
```

Payments, the job queue, polling, timeouts, refunds, the sweep, the relay
handoff, and the audit trail are all generic `lib/` code — the new service
inherits them automatically. Full recipe: [`services/README.md`](services/README.md).

### One worked example — one repo per service

This repo is the **base code**, not a service catalog. It ships exactly one
worked service, `image_to_video` (photo → video, Fal AI or ComfyUI,
100 ⭐), plus the recipe. Each real SaaS becomes **its own repository**:

```bash
# 1. Clone the base into a fresh repo for the new service.
git clone https://github.com/m0502369637-hub/my-saas-boilerplate my-new-saas
cd my-new-saas

# 2. Follow services/README.md: copy lib/services/image_to_video/ →
#    lib/services/<your_name>/, edit config.js, register, wire one route.
#    Delete lib/services/image_to_video/ when you don't need the example.

# 3. Point the clone at the new service's repo and ship it.
git remote set-url origin https://github.com/<you>/my-new-saas.git
git push -u origin main
```

The plumbing generalises cleanly: the job state machine auto-adapts to the
output kind (video **or** image), fal submits work for any model
(`submitRequest`), invoice payloads are amount-agnostic, and providers are
per-service config. Two services built exactly this way are live in the same
GitHub account:

- [text-to-image-saas](https://github.com/m0502369637-hub/text-to-image-saas) — `/imagine <prompt>` → image, Fal FLUX.1 [pro] ultra, 50 ⭐
- [photo-restyle-saas](https://github.com/m0502369637-hub/photo-restyle-saas) — photo → restyled image, ComfyUI img2img, 75 ⭐

## 5. The async-job mental model

```
 user sends photo
       │
       ▼
 [message handler] ── balance ≥ 100⭐? ──no──▶ XTR invoice ─▶ user pays ─▶ resend photo
       │ yes
       ▼
 createJob  → status: queued        (job row + webhook_secret + expires_at)
       │
       ▼
 debit 100⭐ immediately             (payments: kind 'charge')
       │
       ▼
 upload photo, POST provider        (fal queue submit / ComfyUI /prompt)
       │  ← returns in <1s, never waits
       ▼
 status: submitted                  (provider_job_id + status_url stored)
       │
       ▼
 reply: [🔄 Check Status] [❌ Cancel]   ← handler RETURNS. That's the whole invocation.
       │
       ▼
 status: processing ───────────────┐
       │                           │
       ▼                           ▼
 ┌───────────── three completion paths ─────────────┐
 │ (A) RELAY       (B) CLIENT POLL   (C) PIGGYBACK SWEEP            │
 │ fal webhook →   user taps 🔄 →    any message/callback →         │
 │ relay nudges    one status call,  ≤5 polls/invocation,           │
 │ the user        delivers video    ≤20s budget, 1/min throttle    │
 └────────────────────────┬──────────────────────────┘
                          ▼
 status: complete ── send video ── 🎉          (or)
 status: failed / timed_out ── refund 100⭐ ── notify ── audit row
```

**Statuses** (`jobs.status`): `queued → submitted → processing → complete | failed | timed_out`.
**Timeout policy:** each job carries `expires_at = created_at + maxJobAgeMs`
(default **15 minutes**, per-service in `config.js`). The sweep (or any
check) past expiry marks it `timed_out`, refunds, and messages:

> ⚠️ Your generation took too long and was cancelled. Your 100 ⭐ have been refunded.

**Failure policy:** any provider 4xx/5xx at submit, any provider-reported
failure, any undeliverable video → `failed` + refund + notify. Nothing fails
silently. Every terminal transition is a conditional `UPDATE` guarded on the
current status, so racing pollers can never double-refund or double-send.

### The three completion paths, honestly

| Path | Works without anything extra? | Latency | Notes |
| --- | --- | --- | --- |
| (B) Client polling — 🔄 Check Status | ✅ always | user-driven | One status call per tap, throttled to ≤1/min per job (`pollAfterMs`). |
| (C) Piggyback sweep — `lib/sweep.js` | ✅ always | ≤~1 min after any user activity | The cron replacement: the platform has **no scheduled triggers**. If a future platform adds them, this module is the drop-in body for a real cron handler. |
| (A) Provider webhook — `relay/relay.mjs` | ⚠️ needs your relay | seconds | The platform has **no inbound HTTP**, so webhooks land on a tiny Node app you host; it nudges the user via the Bot API, and the tap on 🔄 drives the actual DB transition. Optional — the bot is fully resilient without it. |

## 6. Choosing a provider

Switch by editing one line in `lib/services/image_to_video/config.js`
(`provider: 'fal_ai'` ↔ `provider: 'comfyui'`) — the state machine,
payments, and UX are identical. A global override lives in
`lib/secrets.js` → `secrets.provider`.

| | **Fal AI** (`fal_ai`) | **ComfyUI** (`comfyui`) |
| --- | --- | --- |
| Model | `fal-ai/veo3.1/image-to-video` (managed, per-second billing) | Any workflow you build (your model, your GPU) |
| Setup | Just a `FAL_KEY` | `COMFYUI_BASE_URL` (+ optional bearer) — self-hosted `--listen`, RunComfy, … |
| Webhooks | ✅ native (`?fal_webhook=` → relay) | ❌ none — the relay polls `/history` instead |
| Input handling | Upload photo → fal CDN → `image_url` | Upload photo → `/upload/image` → `LoadImage` name |
| Output delivery | Public CDN URL → Telegram fetches it | Auth'd endpoints: bot downloads bytes (30 MB platform cap) and uploads; open endpoints: Telegram fetches the `/view` URL |
| Failure signal | `COMPLETED` status **with** `error` fields | `/history` → `status.status_str === 'error'` |
| Cancel | `PUT …/requests/<id>/cancel` | `POST /interrupt` |
| Best for | Zero-ops, instant start | Cost control, custom pipelines, on-prem |

The ComfyUI workflow file (`lib/services/image_to_video/comfy_workflow.js`) is
a placeholder skeleton in API-format; replace it with your own
“Save (API Format)” export — inputs are injected by walking the graph and
matching `class_type`, so node ids don't matter.

## 7. Money flow (Telegram Stars)

```
user pays 100⭐ via XTR invoice (sendInvoice, currency 'XTR')
        └─ pre_checkout_query → answer ok          (handlers/pre_checkout_query.js)
        └─ message.successful_payment → credit wallet (+payments 'charge')
generation starts → debit 100⭐ immediately          (+payments 'charge', job_id)
job fails / times out / cancelled → credit 100⭐ back (+payments 'refund', job_id)
```

- The **internal wallet** (`users.stars_balance`) is deliberate: refunds are
  instant, whole, and auditable without depending on Telegram's refund-API
  granularity. `payments.kind ∈ {charge, refund}`.
- Debits are conditional SQL updates (`balance >= cost`), so concurrent
  invocations cannot overdraw; refunds are idempotent per job.
- Telegram's `refundStarPayment` can be layered on later if you want real
  XTR refunds — the charge id is available on `successful_payment`.

## 8. Configuration reference

**`lib/secrets.js`** (deployed — treat as production secret material):

| Key | Used when | Value |
| --- | --- | --- |
| `falKey` | provider fal_ai | fal.ai API key |
| `comfyuiBaseUrl` | provider comfyui | ComfyUI base URL, no trailing slash |
| `comfyuiApiKey` | hosted comfyui | bearer token (optional) |
| `relayBaseUrl` | relay enabled | public relay URL (optional) |
| `provider` | always | `'fal_ai'` / `'comfyui'` override (optional) |

**Service `config.js`**: `name`, `cost` (Stars), `provider`, `maxJobAgeMs`
(default 15 min → timeout+refund), `pollAfterMs` (provider poll throttle,
default 60s), plus provider sections (model id, prompt, workflow template,
input/output node classes).

## 9. Timeout & troubleshooting checklist

Symptom: job sits in `submitted`/`processing` past its welcome.

1. **Is the job actually still alive upstream?** Check the provider console
   (fal dashboard → requests; ComfyUI `/queue`). If the provider errored,
   the next poll fails the job and refunds — the poll happens on 🔄 tap or
   within ~1 min of any bot activity (sweep).
2. **Relay configured but no nudges?** Is `secrets.relayBaseUrl` set and the
   relay reachable over HTTPS? `curl https://relay/healthz`. Fal webhooks
   need a public, non-loopback URL and are not retried through redirects —
   point `fal_webhook` at the final URL. Check fal's Webhooks dashboard for
   delivery attempts.
3. **Sweep not running?** It piggybacks on user activity — send the bot any
   message. Verify `app_state` has `sweep.last_run` (query via `tgcloud run`
   or an admin command). It self-throttles to once per minute by design.
4. **Provider status URL correct?** fal: `jobs.provider_status_url` must be
   the `status_url` from submit (not the response URL). ComfyUI: it is the
   `/history/<prompt_id>` URL. Both are stored at submit time — never
   hand-edited.
5. **Did the timeout fire?** Every active job has `expires_at`; past it, the
   next sweep/check marks `timed_out` and refunds. If you need longer runs,
   raise `maxJobAgeMs` in the service's `config.js` (and make sure your
   provider actually finishes in that window).
6. **Result never delivered?** fal URLs are public (fine). Auth'd ComfyUI
   `/view` URLs are downloaded by the bot and capped at **30 MB** by the
   platform fetch — keep generations under that, or serve ComfyUI without
   auth / behind a CDN. Delivery failures fail the job and refund (check
   `jobs.error` + `job_events`).
7. **Handler invoked twice?** Delivery is at-least-once; every money-moving
   handler is deduped on `update_id` (`processed_updates`). Check that table
   if a charge looks duplicated.

## 10. Security notes

- `lib/secrets.js` ships empty placeholders; **never commit real values**.
  Any `push` from a trusted machine uploads it — rotate on any leak.
  Strongest posture: keep provider keys out of the platform entirely by
  calling them through a proxy you host (the relay is that proxy's natural
  home).
- The platform documents no cryptographic RNG; job/webhook ids are
  unguessable-enough opaque tokens, not CSPRNG secrets. Treat
  `webhook_secret` as a bearer token over HTTPS.
- The relay only nudges chats the bot itself named in the URL; add fal's
  IP allowlist + ED25519 webhook verification for production (see
  `relay/README.md`).

## 11. Verify before you deploy

The Telegram Serverless skill ships a static linter that checks exactly the
rules that bite on this platform (bare imports, handler names, no FKs, no
timers, no stray root `.js`, …):

```bash
git clone https://github.com/yousifraad01/Telegram-Serverless-Skill /tmp/tss-skill
node /tmp/tss-skill/skills/telegram-serverless/scripts/lint-project.mjs .
```

This repo passes it clean (0 errors). Then:

```bash
npx tgcloud status && npx tgcloud diff     # review exactly what push will send
npx tgcloud push                           # atomic deploy
npx tgcloud migrate --dry-run              # review schema changes …
npx tgcloud migrate                        # … then apply (additive = safe)
npx tgcloud webhook                        # handlers in sync?
```

## 12. Files that ship in this repo

| Group | Files |
| --- | --- |
| DB | `schema.js` — `users`, `jobs`, `payments`, `job_events`, `processed_updates`, `app_state` |
| Handlers | `handlers/message.js`, `handlers/callback_query.js`, `handlers/pre_checkout_query.js` |
| Lib | `lib/{secrets,jobs,sweep,stars,fal_ai,comfyui,http,telegram,auth,ids,idempotency,app_state,db_util}.js` |
| Services | `lib/services/registry.js` + `lib/services/image_to_video/` (the worked example: `index.js`, `config.js`, workflow templates) |
| Docs/ops | `README.md`, `AGENTS.md`, `services/README.md`, `handlers/README.md`, `lib/README.md`, `relay/` |
