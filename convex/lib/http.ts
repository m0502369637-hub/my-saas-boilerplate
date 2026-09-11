// lib/http.ts — fetch with one retry on 5xx/network errors.
//
// Convex actions are never auto-retried, so transient provider 5xxs need an
// explicit retry here. GETs only by default: submission POSTs must NOT be
// retried (a timed-out submit may already have been accepted — retrying
// would double-bill the provider).

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  retries = 1,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status < 500) return res; // 4xx = provider answered; don't retry
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}
