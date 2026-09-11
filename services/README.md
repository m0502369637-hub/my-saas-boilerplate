# services/ — add a new SaaS in its own repository

> **Where the code actually lives:** `lib/services/` (this folder holds only
> the recipe). The platform deploys only `schema.js`, `lib/**`, and
> `handlers/*.js`, and `lib/` is the only directory that may nest — so the
> per-service folder system lives under `lib/services/`, importable by bare
> name (`lib/services/<name>/config`). Everything below still applies; just
> think `lib/services/` when you copy.

## The model: base repo + one repo per service

This boilerplate is the **base code** for every project — it must stay clean
of service accumulation. Each new SaaS ships as its **own repository**,
cloned from this one.

## The recipe

To ship a new business module (say `photo_upscale`):

```bash
# 1. Clone the base into the NEW service's repo (never edit the base for this).
git clone https://github.com/m0502369637-hub/my-saas-boilerplate photo_upscale_saas
cd photo_upscale_saas

# 2. Copy the reference service — it is a complete, working example.
cp -r lib/services/image_to_video lib/services/photo_upscale

# 3. Point its code at the right names and knobs.
#    lib/services/photo_upscale/config.js:
#      name: 'photo_upscale'
#      cost: 50                        # Stars per run
#      provider: 'fal_ai'              # or 'comfyui'
#      maxJobAgeMs: 10 * 60 * 1000     # per-service timeout window
#      fal: { model: 'fal-ai/flux-pro/v1.1-ultra', prompt: '…' }
#    (Replace the workflow templates with your model's payload / your
#     ComfyUI "Save (API Format)" export. Output kind — video or image —
#     is auto-detected; nothing in lib/ cares.)

# 4. Edit lib/services/photo_upscale/index.js — the only service-specific
#    code: how the user's input becomes provider input. The job queue,
#    payments, refunds, sweep, and relay handoff are all generic.

# 5. Register the service (one line):
#    lib/services/registry.js → SERVICES.photo_upscale = photoUpscale
#    (delete the image_to_video entry + folder if the example isn't needed)

# 6. Route it in handlers/message.js, next to the image_to_video route:
#    if (message.photo) return dispatchPhotoUpscale(user, fileId);
#    Update the HELP/COMMANDS text in the same file.

# 7. Point the clone at the new service's repo and ship it:
git remote set-url origin https://github.com/<you>/photo_upscale_saas.git
git push -u origin main

# 8. Deploy to the platform (new service needs no schema change — jobs and
#    payments are already generic):
npx tgcloud push
npx tgcloud run handlers/message '{ chat: { id: 1, type: "private" }, from: { id: 1, first_name: "Test" }, text: "/start" }' --ctx '{ update: { update_id: 1 } }'
```

Done. The new service inherits, for free: the Stars invoice flow, the job
state machine, the 🔄 Check Status / ❌ Cancel buttons, provider polling with
throttling, the piggyback sweep, the per-service timeout with refund, the
audit trail, and the relay notification path.

## Contract every service must honour

- `config.js` default-exports `{ name, cost, provider, maxJobAgeMs, pollAfterMs, … }`.
- `index.js` default-exports `dispatch(user, <input>, …)` that **never awaits
  generation output** — submit and return.
- All state transitions go through `lib/jobs.js`; never touch `jobs.status`
  directly.
- One service per repository — the base repo keeps only the worked example.
