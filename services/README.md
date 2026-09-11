# Spinning up a new SaaS service — the recipe

This base repo ships **one worked example** (`image_to_video`) and must stay
that way. A new SaaS is a **new repository** cloned from the base, with a
single service folder, its own Convex project, and its own bot.

## 0. Before you start

- New Telegram bot in @BotFather (with Serverless **off** — you're self-hosting
  now) and its classic Bot API token.
- Provider account + key: fal.ai and/or a ComfyUI endpoint.

## 1. Create the repository

```bash
git clone git@github.com:<you>/my-saas-boilerplate.git <service-name>-saas
cd <service-name>-saas
git remote rename origin upstream          # pull plumbing updates from here later
# …create the GitHub repo, then:
git remote add origin git@github.com:<you>/<service-name>-saas.git
```

## 2. Add the service folder

```bash
cp -r convex/lib/services/image_to_video convex/lib/services/<service_name>
```

- `config.ts` — set `name` (registry key), `title`, `description`, `cost`
  (Stars), `provider` (`"fal"` or `"comfyui"`), `pollAfterMs`, `maxJobAgeMs`,
  `trigger` (`{ kind: "photo" }` or `{ kind: "prompt", command: "/imagine" }`),
  and the provider knobs.
- `fal_workflow.ts` — model id + input template (or delete for comfyui-only).
- `comfy_workflow.ts` — paste your "Save (API Format)" export (or delete for
  fal-only).
- `index.ts` — `buildProviderPayload(input, images)`: assemble the payload
  from `input.prompt` / `input.photoFileId` and the resolved image refs
  (`images.falUrl` / `images.comfyName`). Pure function — no network, no DB.

## 3. Register it (and drop the example)

`convex/lib/services/registry.ts`:

```ts
export const SERVICES: Record<string, Service> = {
  my_service: myService, // ← your entry; remove image_to_video
};
```

```bash
rm -rf convex/lib/services/image_to_video
```

## 4. Route the trigger in `convex/updates.ts`

- Photo services: handled generically (photo → `photoService()`). Nothing to
  do beyond the registry.
- Prompt services: the generic `/` command path picks up
  `trigger.command` automatically (e.g. `/imagine`). Update `helpText()` if
  you want custom wording.

## 5. Local verification

```bash
npm install
npm run typecheck      # tsc on convex/ + scripts/
```

## 6. Deploy

```bash
npx convex dev                       # login + create the new Convex project
npx convex env set BOT_TOKEN '…'
npx convex env set WEBHOOK_SECRET "$(openssl rand -hex 16)"
npx convex env set FAL_KEY '…'       # and/or COMFYUI_BASE_URL / COMFYUI_API_KEY
npm run deploy
cp .env.example .env.local           # fill BOT_TOKEN + WEBHOOK_SECRET
WEBHOOK_URL=https://<deployment>.convex.site npm run webhook:set
```

## 7. Tailor the repo, push

- `README.md` — service name, trigger, price, provider.
- `package.json` — `name` (e.g. `text-to-image-saas`).
- `AGENTS.md` — service-specific notes (keep the base rules).
- Commit and push.

## Pulling plumbing updates later

The base repo's plumbing (`jobs`, `wallet`, `sweep`, `http`, providers) is
shared; your service folder is the only service-specific part.

```bash
git fetch upstream
git merge upstream/main   # fix any conflicts in your service files if paths moved
npm install
npx convex codegen --system-udfs --init
npm run typecheck
npm run deploy
```
