/**
 * v0.3.0 RapidAPI marketplace route /rapidapi/v1/* (shared pattern: HeaderGuard v0.5.0 src/lib/rapidapi.js, itself from
 * DnsGuard v0.8.0 / MeetZone). RapidAPI's proxy adds X-RapidAPI-Proxy-Secret (must equal the Worker secret
 * RAPIDAPI_PROXY_SECRET), X-RapidAPI-Subscription (BASIC/PRO) and X-RapidAPI-User. Compare is constant time (SHA-256
 * digests + XOR). Secret unset → 503 rapidapi_not_configured; wrong/missing → 401 unauthorized. Hard per-tier limits:
 * RapidAPI enforces the monthly quota (hard limit, no overage); the Worker enforces the per-minute plan limit per RapidAPI
 * user on its own bindings (RAPIDAPI_BASIC_LIMITER 7941 / RAPIDAPI_PRO_LIMITER 7942, key "rapidapi-<tier>:<hash>"), so
 * RapidAPI traffic never eats the free per-IP pools (7701/7702) or a Polar Pro budget. Same work functions as /api
 * (checkSite / generateRobots / validateBody: SSRF, cache, budgets). /api/*, /mcp and Polar RBTG keys are untouched. Error
 * codes emitted only here: rapidapi_not_configured, unauthorized, not_found.
 */
export const RAPIDAPI_PREFIX = '/rapidapi';
export const RAPIDAPI_TIERS = ['BASIC', 'PRO'];
/** Per-minute plan limits */
export const RAPIDAPI_PER_MIN = { BASIC: 10, PRO: 120 };
/** Monthly hard quotas, enforced by RapidAPI (Studio plan settings). */
export const RAPIDAPI_PER_MONTH = { BASIC: 100, PRO: 50_000 };
export const RAPIDAPI_PRICE_USD = { BASIC: 0, PRO: 15 };
export const RAPIDAPI_BINDING = { BASIC: 'RAPIDAPI_BASIC_LIMITER', PRO: 'RAPIDAPI_PRO_LIMITER' };

export function isRapidApiPath(path) { return path === RAPIDAPI_PREFIX || path.startsWith(`${RAPIDAPI_PREFIX}/`); }

async function digest(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)))); }

/** Constant-time equality over fixed-length SHA-256 digests. */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export function rapidTier(request) {
  const t = String(request.headers.get('x-rapidapi-subscription') || '').trim().toUpperCase();
  return RAPIDAPI_TIERS.includes(t) ? t : 'BASIC';
}

/** Limiter key (16 hex): hashed X-RapidAPI-User (fallback: caller's IP bucket). Never stores the raw username. */
export async function rapidUserKey(request, fallback) {
  const u = String(request.headers.get('x-rapidapi-user') || '').trim().slice(0, 128);
  const src = u ? `u:${u}` : `ip:${fallback}`;
  return [...(await digest(src))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** null when allowed, else { status, code, message }. Never echoes the secret. */
export async function rapidGate(request, env) {
  const secret = typeof env.RAPIDAPI_PROXY_SECRET === 'string' ? env.RAPIDAPI_PROXY_SECRET : '';
  if (!secret) return { status: 503, code: 'rapidapi_not_configured', message: 'The RapidAPI route is not configured yet. Use the free API at /api directly.' };
  const presented = request.headers.get('x-rapidapi-proxy-secret');
  if (!presented || !(await safeEqual(presented, secret))) {
    return { status: 401, code: 'unauthorized', message: 'Missing or invalid RapidAPI proxy secret. Subscribe on RapidAPI, or use the free public API at /api.' };
  }
  return null;
}

/** In-isolate fallback per tier (binding missing, e.g. tests/dev), same numbers. */
const fallback = new Map();
async function limitHit(env, tier, key) {
  const binding = env[RAPIDAPI_BINDING[tier]];
  if (binding && typeof binding.limit === 'function') {
    try { return (await binding.limit({ key })).success; } catch { /* fall through */ }
  }
  const now = Date.now();
  const w = fallback.get(key);
  if (!w || now - w.start >= 60_000) {
    if (fallback.size > 10_000) fallback.clear();
    fallback.set(key, { start: now, n: 1 });
    return true;
  }
  w.n++;
  return w.n <= RAPIDAPI_PER_MIN[tier];
}

/**
 * Route handler. h = { json, errorJson, errorInfo, checkSite, readJsonBody, validateBody, generateRobots, ipBucket, version }.
 * Bodies are the same JSON as the public /api routes; check adds "plan":"rapidapi". Header x-robotsgate-plan: rapidapi-<tier>.
 */
export async function handleRapidApi(request, env, deps, path, url, h) {
  const denied = await rapidGate(request, env);
  if (denied) return h.errorJson(denied.status, denied.code, denied.message);
  const tier = rapidTier(request);
  const tierHeaders = { 'x-robotsgate-plan': `rapidapi-${tier.toLowerCase()}` };
  const perMin = RAPIDAPI_PER_MIN[tier];
  const err = (status, code, message, details, extra = {}) => h.errorJson(status, code, message, details, { ...extra, ...tierHeaders });
  const limited = async () => {
    const key = `rapidapi-${tier.toLowerCase()}:${await rapidUserKey(request, h.ipBucket)}`;
    return !(await limitHit(env, tier, key));
  };
  const rateErr = () => err(429, 'rate_limited', `Too many requests for your RapidAPI ${tier} plan (about ${perMin} per minute). Please wait a minute.`, { plan: 'rapidapi', tier, limitPerMin: perMin }, { 'retry-after': '60' });
  const wrap = async (fn) => {
    try { return await fn(); } catch (e) { const i = h.errorInfo(e); return err(i.status, i.code, i.message, i.details); }
  };

  if (path === '/rapidapi/v1/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return err(405, 'method_not_allowed', 'Use GET /rapidapi/v1/health.', undefined, { allow: 'GET' });
    return h.json({ ok: true, service: 'robotsgate', version: h.version, tier }, 200, tierHeaders);
  }
  if (path === '/rapidapi/v1/check') {
    if (request.method !== 'GET') return err(405, 'method_not_allowed', 'Use GET /rapidapi/v1/check?url=…', undefined, { allow: 'GET' });
    if (await limited()) return rateErr();
    return wrap(async () => {
      const r = await h.checkSite({ target: url.searchParams.get('url'), rawPath: url.searchParams.get('path'), access: { plan: 'free' }, rl: null, env, deps, fetchImpl: h.fetchImpl });
      return h.json({ ...r.body, plan: 'rapidapi' }, 200, { 'x-robotsgate-cache': r.headers['x-robotsgate-cache'], ...tierHeaders });
    });
  }
  if (path === '/rapidapi/v1/generate' || path === '/rapidapi/v1/validate') {
    if (request.method !== 'POST') return err(405, 'method_not_allowed', `Use POST ${path} with a JSON body.`, undefined, { allow: 'POST' });
    if (await limited()) return rateErr();
    return wrap(async () => {
      const body = await h.readJsonBody(request);
      return h.json(path.endsWith('/generate') ? h.generateRobots(body) : h.validateBody(body), 200, tierHeaders);
    });
  }
  return err(404, 'not_found', 'Unknown RapidAPI endpoint. Use /rapidapi/v1/check, /rapidapi/v1/generate, /rapidapi/v1/validate or /rapidapi/v1/health.');
}
