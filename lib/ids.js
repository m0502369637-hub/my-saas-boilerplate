// lib/ids.js — id and secret generation.
//
// The platform's V8 isolate documents no cryptographic RNG, so identifiers
// are built from Date.now() + Math.random(). That is fine for job ids.
// webhook secrets should be treated as opaque bearer tokens (long, unguessable
// enough, HTTPS-only in transit) rather than cryptographic secrets. If you run
// the optional relay, consider tightening its auth (see relay/README.md).

const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
const FULL = LOWER + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randomString(len, alphabet = LOWER) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// Short, roughly sortable, unique-enough job id: jv_<base36 timestamp>_<rand>.
// Stays well under Telegram's 64-byte callback_data limit when used in
// `check:<id>` / `cancel:<id>` buttons.
export function randomId() {
  return `jv_${Date.now().toString(36)}_${randomString(6)}`;
}

// Per-job webhook secret handed to the provider (fal webhook URL) and the
// optional relay so a callback can be matched to its job.
export function newWebhookSecret() {
  return randomString(24, FULL);
}
