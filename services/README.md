# Spinning up a new SaaS service — the recipe

The base repo ships **no services and no providers** — it is pure plumbing
with two extension points. A new SaaS is a **new repository** cloned from the
base, carrying one service + one provider, its own Convex project, and its
own bot.

## 0. Before you start

- New Telegram bot in @BotFather (Serverless **off**) and its classic Bot API
  token.
- Provider account + credentials, and its API documentation (the bot will
  call it with raw HTTP from your provider adapter).

## 1. Create the repository

```bash
git clone git@github.com:<you>/my-saas-boilerplate.git <service-name>-saas
cd <service-name>-saas
git remote rename origin upstream          # pull plumbing updates from here later
# …create the GitHub repo, then:
git remote add origin git@github.com:<you>/<service-name>-saas.git
```

## 2. Add the service

`convex/lib/services/<service_name>/`:

- `config.ts` — `name`, `title`, `description`, `provider` (a registry key you
  choose, e.g. `"my_provider"`), `pollAfterMs`, `maxJobAgeMs`, `trigger`
  (`{ kind: "photo" }` or `{ kind: "prompt", command: "/imagine" }`), plus any
  provider-specific injection knobs you need. **No price** (that's the
  `SERVICE_COST` env var) and **no committed payloads/workflows** — templates
  belong in your provider adapter or a `PROVIDER_*` env var you add yourself.
- `index.ts` — `buildProviderPayload(input, images)`: assemble the submission
  payload from `input.prompt` / `input.photoFileId(s)` / `input.details` and
  the resolved image refs. Pure function — no network, no DB. The return
  value is passed verbatim to your provider's `submit()`.

## 3. Add the provider

`convex/lib/providers/<name>.ts` implementing `Provider` from
`convex/lib/providers/types.ts`:

```ts
export interface Provider {
  name: string;                                   // must match config.provider
  resolveImages(photoIds: string[]): Promise<ImageRefs>;
  submit(job: JobRow, payload: unknown): Promise<SubmitResult>;  // return fast, never await output
  getJobStatus(job: JobRow): Promise<JobPollResult>;             // one status check
  cancel(job: JobRow): Promise<{ alreadyCompleted: boolean }>;
  downloadOutput?(url: string): Promise<Uint8Array>;             // for authed result URLs
}
```

Register it in `convex/lib/providers/registry.ts`:

```ts
import { myProvider } from "./my_provider";
export const PROVIDERS: Record<string, Provider> = { my_provider: myProvider };
```

Add your provider's secrets to `convex/convex.config.ts` + `.env.example`.

## 4. Register the service

`convex/lib/services/registry.ts`:

```ts
export const SERVICES: Record<string, Service> = {
  my_service: myService,
};
```

## 5. Route the trigger in `convex/updates.ts`

- Photo services: handled generically (photo → `photoService()`), including
  single photos and media-group albums (buffered + debounced, caption →
  `details`).
- Prompt services: the generic `/` command path picks up `trigger.command`
  automatically (e.g. `/imagine`). Update `helpText()` for custom wording.

## 6. Local verification

```bash
npm install
npm run typecheck      # tsc on convex/ + scripts/
```

## 7. Deploy

```bash
npx convex dev                       # login + create the new Convex project
npx convex env set BOT_TOKEN '…'
npx convex env set WEBHOOK_SECRET "$(openssl rand -hex 16)"
npx convex env set SERVICE_COST '100'   # Stars per generation — change anytime, no redeploy
npx convex env set <PROVIDER_SECRETS> …
npm run deploy
cp .env.example .env.local           # fill BOT_TOKEN + WEBHOOK_SECRET
WEBHOOK_URL=https://<deployment>.convex.site npm run webhook:set
```

## 8. Tailor the repo, push

- `README.md` — service name, trigger, price (reference `SERVICE_COST`),
  provider.
- `package.json` — `name` (e.g. `text-to-image-saas`).
- `AGENTS.md` — service-specific notes (keep the base rules).
- Commit and push.

## Pulling plumbing updates later

The base repo's plumbing (`jobs`, `wallet`, `sweep`, `http`, `updates`) is
shared; your service + provider folders are the only repo-specific parts.

```bash
git fetch upstream
git merge upstream/main   # fix any conflicts in your service/provider files if paths moved
npm install
npx convex codegen --system-udfs --init
npm run typecheck
npm run deploy
```
