/**
 * RobotsGate Pro — product constants, Polar checkout CTA, and license soft-fail gating.
 *
 * Product (Polar): slug robotsgate-pro, prefix RBTG, $9/mo.
 *
 * Soft-fail: missing/invalid/revoked/wrong-slug keys (or missing LICENSES binding) keep the
 * free tier. Only a valid robotsgate-pro grant gets Pro limits + x-robotsgate-plan: pro.
 * Never log full license keys — use maskLicenseKey().
 */
import { maskLicenseKey, validateFleetLicense } from './lib/fleet-license.js';

export const PRODUCT_SLUG = 'robotsgate-pro';
export const PRO_PRICE_USD_MONTH = 9;

/** Pro /api/check: 300 requests per 60 s (in-isolate; CF Rate Limiting binding skipped). */
export const PRO_CHECK_RATE = { limit: 300, windowMs: 60_000 };
/** Pro POST /api/generate + /api/validate: 600 per 60 s (in-isolate; CF binding skipped). */
export const PRO_POST_RATE = { limit: 600, windowMs: 60_000 };

/** Public Polar checkout link (full URL). Override with env.PRO_CHECKOUT_URL / PUBLIC_PRO_CHECKOUT_URL. */
export const PRO_CHECKOUT_URL = 'https://buy.polar.sh/polar_cl_pJjxZL8dDfTebUMNAEOnWNscJgTjNZPWbiIln3H3k6l';

/**
 * @param {Record<string, unknown>} [env]
 * @returns {string} Public checkout URL, or '' if unset.
 */
export function resolveCheckoutUrl(env = {}) {
  for (const v of [env.PRO_CHECKOUT_URL, env.PUBLIC_PRO_CHECKOUT_URL, PRO_CHECKOUT_URL]) {
    if (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v)) return v;
  }
  return '';
}

/**
 * Extract a presented license key from Authorization: Bearer or X-License-Key.
 * @param {Request} request
 * @returns {string|null}
 */
export function extractLicenseKey(request) {
  const auth = request.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)/i);
    if (m) return m[1].trim();
  }
  const x = request.headers.get('x-license-key');
  if (x && x.trim()) return x.trim();
  return null;
}

/**
 * Soft-fail Pro resolution.
 * - No key → free
 * - Key present but LICENSES missing / invalid / revoked / wrong slug → free (no Pro headers)
 * - Valid robotsgate-pro grant → pro (higher limits + x-robotsgate-plan)
 *
 * @param {Request} request
 * @param {{ LICENSES?: { get: Function } }} env
 * @returns {Promise<{ plan: 'free' } | { plan: 'pro', maskedKey: string }>}
 */
export async function resolveProAccess(request, env = {}) {
  const key = extractLicenseKey(request);
  if (!key) return { plan: 'free' };

  if (!env.LICENSES || typeof env.LICENSES.get !== 'function') {
    return { plan: 'free' };
  }

  let result;
  try {
    result = await validateFleetLicense(env.LICENSES, key, PRODUCT_SLUG);
  } catch {
    return { plan: 'free' };
  }

  if (!result || !result.valid) return { plan: 'free' };

  return { plan: 'pro', maskedKey: maskLicenseKey(key) };
}
