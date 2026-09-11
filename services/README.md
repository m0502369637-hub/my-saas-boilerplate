# services/ — add a new SaaS in ~4 minutes

> **Where the code actually lives:** `lib/services/` (this folder holds only
> the recipe). The platform deploys only `schema.js`, `lib/**`, and
> `handlers/*.js`, and `lib/` is the only directory that may nest — so the
> per-service folder system lives under `lib/services/`, importable by bare
> name (`lib/services/<name>/config`). Everything below still applies; just
> think `lib/services/` when you copy.

## The recipe

To ship a new business module (say `photo_upscale`):

```bash
# 1. Copy the reference service — it is a complete, working example.
cp -r lib/services/image_to_video lib/services/photo_upscale

# 2. Point its code at the right names and knobs.
#    lib/services/photo_upscale/config.js:
#      name: 'photo_upscale'
#      cost: 50                        # Stars per run
#      provider: 'fal_ai'              # or 'comfyui'
#      maxJobAgeMs: 10 * 60 * 1000     # per-service timeout window
#      fal: { model: 'fal-ai/flux-pro/v1.1-ultra', prompt: '…' }
#    (Replace the workflow templates with your model's payload / your
#     ComfyUI "Save (API Format)" export.)

# 3. Edit lib/services/photo_upscale/index.js — the only service-specific
#    code: how the user's input becomes provider input. The job queue,
#    payments, refunds, sweep, and relay handoff are all generic.

# 4. Register the service (one line):
#    lib/services/registry.js → SERVICES.photo_upscale = photoUpscale

# 5. Route it in handlers/message.js, next to the image_to_video route:
#    if (message.photo) return dispatchPhotoUpscale(user, fileId);

# 6. Deploy + migrate (new service needs no schema change — jobs/payments are
#    already generic):
npx tgcloud push
npx tgcloud run handlers/message '{ chat: { id: 1, type: "private" }, from: { id: 1, first_name: "Test" }, text: "/start" }' --ctx '{ update: { update_id: 1 } }'
```

Done. The new service inherits, for free: the Stars invoice flow, the job
state machine, the 🔄 Check Status / ❌ Cancel buttons, provider polling with
throttling, the piggyback sweep, the 15-minute (per-service) timeout with
refund, the audit trail, and the relay notification path.

## Contract every service must honour

- `config.js` default-exports `{ name, cost, provider, maxJobAgeMs, pollAfterMs, … }`.
- `index.js` default-exports `dispatch(user, <input>, …)` that **never awaits
  generation output** — submit and return.
- All state transitions go through `lib/jobs.js`; never touch `jobs.status`
  directly.
