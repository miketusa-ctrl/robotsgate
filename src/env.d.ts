/** Cloudflare Worker env bindings (ambient). */
interface Env {
  ASSETS?: Fetcher;
  PUBLIC_URL?: string;
  /** Optional override for the Polar Pro checkout URL (defaults to PRO_CHECKOUT_URL in pro.js). */
  PRO_CHECKOUT_URL?: string;
  PUBLIC_PRO_CHECKOUT_URL?: string;
  RATE_LIMITER?: RateLimit;
  POST_LIMITER?: RateLimit;
  /** Shared Polar Pro licenses KV (the license gateway). Soft-fail to free if missing. */
  LICENSES?: KVNamespace;
}
