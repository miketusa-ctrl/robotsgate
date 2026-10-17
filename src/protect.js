// Abuse protection (Workers Paid plan, 2026-10-03; Pro path 2026-10-05).
//
// 1) Per-client rate limiting with the Workers Rate Limiting binding (free tier).
//    - /api/check: binding RATE_LIMITER (20 requests / 60 s per client IP, per Cloudflare
//      location). Its purpose is to stop /api/check being used to hammer third-party sites
//      and to probe for SSRF, so it is counted before URL validation.
//    - POST /api/generate and /api/validate: binding POST_LIMITER (60 / 60 s per client IP).
//      A CPU-cost guardrail (a max-size validate costs ~25 ms CPU warm, ~45-50 ms cold), far above
//      anything a person using the page would hit.
//    - Fallback: if a binding is missing (e.g. unit tests) or throws, an in-isolate
//      fixed-window limiter with the same numbers is used. That fallback is best-effort:
//      counters live in one isolate's memory and reset when the isolate is recycled.
//    - Pro (valid robotsgate-pro license): skip the CF binding; in-isolate limits keyed by
//      "pro:" + masked key — see PRO_CHECK_RATE / PRO_POST_RATE in pro.js (300 / 600 per 60 s).
// 2) Result caching per target origin for /api/check (5 min).
//    - In-isolate LRU memory cache (max 500 entries and 32 MB) + the Cache API (caches.default). Cloudflare documents
//      functional Cache API operations for custom domains; on *.workers.dev it may not
//      persist, which is why the memory layer exists too. This is about workers.dev, not
//      about the plan, so it stays.

export const CHECK_RATE = { limit: 20, windowMs: 60_000 }; // keep in sync with wrangler.toml RATE_LIMITER
export const POST_RATE = { limit: 60, windowMs: 60_000 }; // keep in sync with wrangler.toml POST_LIMITER
export const CACHE_TTL_S = 300;
const MAX_TRACKED_CLIENTS = 10_000;
const MAX_MEMORY_ENTRIES = 500;
// Byte budget for the in-memory result cache. Each entry can hold up to 512,000 bytes of
// robots.txt text, so 500 entries could reach ~256 MB, above the 128 MB isolate limit. Sizes
// are estimated at 2 bytes per character (worst case for JS strings) plus overhead.
export const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const ENTRY_OVERHEAD_BYTES = 1024;
export function estimateBytes(value) {
  const text = value && typeof value.text === 'string' ? value.text.length : 0;
  return text * 2 + ENTRY_OVERHEAD_BYTES;
}

export class InIsolateLimiter {
  constructor({ limit, windowMs }, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map(); // key -> { start, count }
  }

  /** Returns { success, remaining, retryAfter (seconds) } */
  hit(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || t - b.start >= this.windowMs) {
      b = { start: t, count: 0 };
      this.buckets.delete(key);
      this.buckets.set(key, b);
    }
    b.count++;
    if (this.buckets.size > MAX_TRACKED_CLIENTS) this.prune(t);
    const retryAfter = Math.max(1, Math.ceil((b.start + this.windowMs - t) / 1000));
    if (b.count > this.limit) return { success: false, remaining: 0, retryAfter };
    return { success: true, remaining: this.limit - b.count, retryAfter };
  }

  prune(t) {
    for (const [k, b] of this.buckets) {
      if (t - b.start >= this.windowMs) this.buckets.delete(k);
    }
    // Still too many: drop oldest insertions.
    while (this.buckets.size > MAX_TRACKED_CLIENTS) this.buckets.delete(this.buckets.keys().next().value);
  }
}

const fallbackLimiters = { check: new InIsolateLimiter(CHECK_RATE), post: new InIsolateLimiter(POST_RATE) };
const BINDINGS = { check: 'RATE_LIMITER', post: 'POST_LIMITER' };
const RATES = { check: CHECK_RATE, post: POST_RATE };

// Cloudflare sets cf-connecting-ip on every request and clients can't override it. Other
// headers (x-real-ip, x-forwarded-for, true-client-ip) are client-controlled, so they are
// never used.
export function clientKey(request) {
  const ip = request.headers.get('cf-connecting-ip');
  return ip ? ipBucket(ip) : 'unknown-client';
}

/**
 * anonymous rate-limit key. IPv4 as is; IPv6 → its /64, because one subscriber controls a whole /64. Same output as
 * workdayapi's ipBucket. Used by /api and /mcp (free plan only; Pro keys stay keyed by the masked license).
 */
export function ipBucket(ip) {
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1); // IPv4-mapped ::ffff:a.b.c.d
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}

/**
 * Rate-limit a client for a bucket ('check' | 'post').
 * Uses the Workers Rate Limiting binding when present; otherwise (or if it throws) the
 * in-isolate fallback limiter. Returns { success, retryAfter, remaining?, source, limit, windowS }.
 */
export async function rateLimit(request, env = {}, limiter, bucket = 'check') {
  const key = bucket + ':' + clientKey(request);
  const rate = RATES[bucket];
  const binding = env[BINDINGS[bucket]];
  const meta = { limit: rate.limit, windowS: rate.windowMs / 1000 };
  if (binding && typeof binding.limit === 'function') {
    try {
      const { success } = await binding.limit({ key });
      // The binding does not report time-to-reset; the window length is a safe upper bound.
      return { success, retryAfter: rate.windowMs / 1000, source: 'binding', ...meta };
    } catch {
      /* fall through to the in-isolate limiter */
    }
  }
  return { ...(limiter || fallbackLimiters[bucket]).hit(key), source: 'in-isolate', ...meta };
}

// Lazy Pro fallbacks so we do not import pro.js here (keeps protect free of product coupling
// in unit tests that only need free-tier limits). Keys are "check" / "post".
/** @type {{ check?: InIsolateLimiter, post?: InIsolateLimiter }} */
const proFallbackLimiters = {};

/**
 * Pro-tier rate limit: skips CF Rate Limiting bindings. Keys by "pro:" + maskedKey
 * (never the raw license). Pass PRO_CHECK_RATE / PRO_POST_RATE from pro.js as `rate`.
 * @param {string} maskedKey
 * @param {'check'|'post'} bucket
 * @param {InIsolateLimiter} [limiter]
 * @param {{ limit: number, windowMs: number }} rate
 */
export function rateLimitPro(maskedKey, bucket, limiter, rate) {
  const meta = { limit: rate.limit, windowS: rate.windowMs / 1000 };
  const key = 'pro:' + maskedKey;
  let lim = limiter;
  if (!lim) {
    if (!proFallbackLimiters[bucket] || proFallbackLimiters[bucket].limit !== rate.limit) {
      proFallbackLimiters[bucket] = new InIsolateLimiter(rate);
    }
    lim = proFallbackLimiters[bucket];
  }
  return { ...lim.hit(key), source: 'pro-in-isolate', ...meta };
}

export class ResultCache {
  constructor(ttlSeconds = CACHE_TTL_S, now = () => Date.now(), cacheStorage = globalThis.caches) {
    this.ttl = ttlSeconds;
    this.now = now;
    this.mem = new Map(); // key -> { expires, value, bytes }; Map order = LRU order (oldest first)
    this.bytes = 0;
    this.maxEntries = MAX_MEMORY_ENTRIES;
    this.maxBytes = MAX_MEMORY_BYTES;
    this.cacheStorage = cacheStorage;
  }

  cacheKey(robotsUrl) {
    // Synthetic URL on a reserved TLD so it can never collide with a real fetch.
    return 'https://robotsgate-cache.invalid/robots?u=' + encodeURIComponent(robotsUrl);
  }

  async get(robotsUrl) {
    const k = this.cacheKey(robotsUrl);
    const m = this.mem.get(k);
    if (m && m.expires > this.now()) {
      this.mem.delete(k); // refresh LRU position
      this.mem.set(k, m);
      return { value: m.value, layer: 'memory' };
    }
    if (m) this.drop(k);
    const c = this.cacheStorage && this.cacheStorage.default;
    if (c) {
      try {
        const hit = await c.match(k);
        if (hit) {
          const value = await hit.json();
          this.remember(k, value);
          return { value, layer: 'cache-api' };
        }
      } catch {
        /* cache is best-effort */
      }
    }
    return null;
  }

  async put(robotsUrl, value, waitUntil) {
    const k = this.cacheKey(robotsUrl);
    this.remember(k, value);
    const c = this.cacheStorage && this.cacheStorage.default;
    if (!c) return;
    const p = c
      .put(k, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${this.ttl}` } }))
      .catch(() => {});
    if (waitUntil) waitUntil(p);
    else await p;
  }

  remember(k, value) {
    this.drop(k);
    const bytes = estimateBytes(value);
    if (bytes > this.maxBytes) return; // never cache something bigger than the whole budget
    this.mem.set(k, { expires: this.now() + this.ttl * 1000, value, bytes });
    this.bytes += bytes;
    while (this.mem.size > this.maxEntries || this.bytes > this.maxBytes) this.drop(this.mem.keys().next().value);
  }

  drop(k) {
    const m = this.mem.get(k);
    if (!m) return;
    this.bytes -= m.bytes;
    this.mem.delete(k);
  }
}

export const defaultCache = new ResultCache();
