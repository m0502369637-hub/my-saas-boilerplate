// lib/secrets.js — the ONE place provider credentials live.
//
// Telegram Serverless has NO secrets store and NO environment access: there
// is no runtime env object, no .env, and no `tgcloud secrets` command. The
// only way
// to give this bot credentials is to ship them in a deployed module — this
// one (`.env.example` at the repo root exists for the optional relay only).
//
// Operational rules:
//   1. Fill in the values below, then deploy from a trusted machine.
//      (`npx tgcloud push` uploads everything under lib/, this file included.)
//   2. Never commit real values; the repo ships empty placeholders so a
//      fresh clone still deploys and fails loudly instead of silently.
//   3. If a value leaks, rotate it at the provider immediately.
//   4. Stronger production posture: keep provider keys OUT of the platform
//      entirely by routing provider calls through a small backend proxy you
//      host (the platform's recommended pattern) — the relay/ folder is the
//      natural home for that proxy.
export const secrets = {
  falKey: '',            // fal.ai API key — https://fal.ai/dashboard/keys
  comfyuiBaseUrl: '',    // e.g. 'https://your-comfyui.example.com' (no trailing slash)
  comfyuiApiKey: '',     // optional bearer for hosted ComfyUI endpoints (RunComfy, …)
  relayBaseUrl: '',      // optional — your relay deployment, e.g. 'https://relay.example.com'
  provider: '',          // optional override — 'fal_ai' | 'comfyui' (falls back to the service default)
};
