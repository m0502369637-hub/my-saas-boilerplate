# relay/ — optional completion watcher (user-hosted, NOT deployed)

Telegram Serverless exposes no inbound HTTP endpoints, so this tiny Node app
runs on your own infrastructure to do the one thing the platform cannot:
receive a provider webhook.

## What it does

- `POST /webhook/fal_ai/<secret>?job_id=…&chat_id=…` — fal POSTs here when a
  queued generation finishes (the bot passes this URL as `fal_webhook` at
  submit time).
- `POST /track` — the bot calls this after every submit (both providers); the
  relay then polls the provider every 15 s until the job finishes and nudges
  the user via the Bot API.
- It **never** writes the bot's database and **never** marks jobs complete —
  the bot remains the single owner of job state. The nudge just tells the
  user to tap 🔄 Check Status, which drives the real transition + delivery.
  If the relay is down, the button and the piggyback sweep still finish jobs.

## Run it

```bash
# from the repo root
BOT_TOKEN=1234567890:AA…  PORT=8787  node relay/relay.mjs
# then set secrets.relayBaseUrl = 'https://your-relay.example.com' in
# lib/secrets.js and deploy the bot.
```

Expose it over HTTPS (a reverse proxy in front of port 8787 is fine). Fal
requires a public, non-loopback URL and does not follow redirects — point it
at the final https:// URL.

## Trust model — read this

The per-job `webhook_secret` proves a callback belongs to a job the bot
created, and the relay only ever messages the `chat_id` the bot itself
embedded in the same URL. Two tightening steps for production:

1. Put the relay behind an IP allowlist from fal's webhook ranges
   (https://api.fal.ai/v1/meta → `webhook_ip_ranges`).
2. If you want cryptographic verification of fal webhooks, add the ED25519
   signature check documented at
   https://fal.ai/docs/model-apis/inference/webhooks — it needs the raw
   request body, which this server already reads.

## Env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `BOT_TOKEN` | — | Bot API token (relay only — the platform never needs it). |
| `PORT` | 8787 | Listen port. |
| `RELAY_POLL_MS` | 15000 | Provider poll interval for `/track`ed jobs. |
| `RELAY_MAX_TRACK_MS` | 1200000 | Stop tracking a job after 20 min (the bot's own timeout/refund applies regardless). |
