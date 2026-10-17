// RobotsGate Worker: JSON API for AI-crawler robots.txt generation, validation and checking.
import registry from './crawlers-data.js';
import { validateRobotsParsed, MAX_ROBOTS_BYTES, byteLength, TooComplexError } from './robots.js';
import { personalAgentSummary } from './personal-agents.js';
import { generateRobots, InputError } from './generate.js';
import { toRobotsUrl, assertPublicDns, checkHostname, SsrfError, DnsCheckError } from './ssrf.js';
import { rateLimit, rateLimitPro, defaultCache, CACHE_TTL_S } from './protect.js';
import { handleMcp } from './mcp.js';
import { isRapidApiPath, handleRapidApi } from './lib/rapidapi.js';
import { ipBucket } from './protect.js';
import { llmsTxt, openApiSpec, serverCard } from './agentdocs.js';
import {
  PRO_CHECK_RATE,
  PRO_POST_RATE,
  PRO_PRICE_USD_MONTH,
  PRODUCT_SLUG,
  resolveCheckoutUrl,
  resolveProAccess,
} from './pro.js';

import { VERSION } from './version.js';
import { GLAMA_JSON } from './glama.js';
export { VERSION };
// Body cap only needs to exceed the 512,000-byte robots_txt limit after JSON escaping.
export const MAX_BODY_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const DEFAULT_PUBLIC_URL = 'https://robotsgate.mike-tusa.workers.dev';
export function userAgent(env = {}) {
  const contact = typeof env.PUBLIC_URL === 'string' && /^https:\/\/[^\s()]+$/.test(env.PUBLIC_URL) ? env.PUBLIC_URL : DEFAULT_PUBLIC_URL;
  return `RobotsGate/${VERSION} (+${contact}; robots.txt checker; fetches /robots.txt only)`;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-license-key',
  'access-control-max-age': '86400',
  // Let cross-origin callers read the rate-limit, plan, and cache headers.
  'access-control-expose-headers': 'retry-after, x-robotsgate-cache, x-ratelimit-remaining, x-robotsgate-plan',
};

export function json(data, status = 200, extra = {}) {
  // Compact JSON: pretty-printing large validate/check results cost CPU and bytes.
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...CORS, ...extra },
  });
}

export function errorJson(status, code, message, details, extraHeaders = {}) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return json({ error }, status, extraHeaders);
}

async function readJsonBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415, code: 'unsupported_media_type' });
  }
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) throw Object.assign(new Error(`Body exceeds ${MAX_BODY_BYTES} bytes.`), { status: 413, code: 'payload_too_large' });
  const text = await readLimited(request.body, MAX_BODY_BYTES).catch((e) => {
    if (e.code === 'too_large') throw Object.assign(new Error(`Body exceeds ${MAX_BODY_BYTES} bytes.`), { status: 413, code: 'payload_too_large' });
    throw e;
  });
  try {
    return JSON.parse(text.text || '{}');
  } catch {
    throw Object.assign(new Error('Body is not valid JSON.'), { status: 400, code: 'invalid_json' });
  }
}

/** Read a stream up to maxBytes. Returns { text, truncated }. Throws code too_large if strict. */
async function readLimited(stream, maxBytes, { truncate = false } = {}) {
  if (!stream) return { text: '', truncated: false };
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      if (!truncate) {
        reader.cancel().catch(() => {});
        throw Object.assign(new Error('too large'), { code: 'too_large' });
      }
      chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(buf), truncated };
}

function cleanPath(p) {
  if (p === undefined || p === null || p === '') return '/';
  if (typeof p !== 'string' || p.length > 2048) throw new InputError('path must be a string up to 2048 characters.');
  if (!p.startsWith('/')) throw new InputError('path must start with "/".');
  if (/[\r\n]/.test(p)) throw new InputError('path must not contain newlines.');
  return p;
}

async function handleGenerate(request) {
  const body = await readJsonBody(request);
  return json(generateRobots(body));
}

/** /api/validate work on an already-parsed body (shared with the MCP validate_robots tool). Throws like the route. */
export function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Body must be a JSON object.');
  if (typeof body.robots_txt !== 'string') throw new InputError('"robots_txt" (string) is required.');
  if (byteLength(body.robots_txt) > MAX_ROBOTS_BYTES) {
    throw Object.assign(new Error(`robots_txt exceeds ${MAX_ROBOTS_BYTES} bytes.`), { status: 413, code: 'payload_too_large', inRoute: true });
  }
  const path = cleanPath(body.path);
  return validateWithAgents(body.robots_txt, path);
}

/** validateRobots result plus the additive personal_agents field (v0.2.7). */
export function validateWithAgents(text, path) {
  const { result, parsed } = validateRobotsParsed(text, path);
  result.personal_agents = personalAgentSummary(parsed, result.ai_crawlers);
  return result;
}

async function handleValidate(request) {
  const body = await readJsonBody(request);
  try {
    return json(validateBody(body));
  } catch (e) {
    // v0.2.8 returned this 413 as a response inside the route (so the plan headers are added); keep that exactly.
    if (e.inRoute) return errorJson(e.status, e.code, e.message);
    throw e;
  }
}

/** Fetch robots.txt with manual redirect handling (each hop re-validated), timeout and size cap. */
export async function fetchRobots(robotsUrl, fetchImpl, ua = userAgent()) {
  let url = robotsUrl;
  const hops = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const u = new URL(url);
      checkHostname(u.hostname);
      if (u.port && u.port !== '80' && u.port !== '443') throw new SsrfError('Redirect to a non-default port is not allowed.');
      await assertPublicDns(u.hostname, fetchImpl);
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': ua, accept: 'text/plain, */*;q=0.5' },
      });
      hops.push({ url, status: res.status });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new SsrfError('Redirect to a non-http(s) URL is not allowed.');
        if (res.body) res.body.cancel().catch(() => {});
        url = next.toString();
        continue;
      }
      const body = res.status >= 200 && res.status < 300 ? await readLimited(res.body, MAX_ROBOTS_BYTES, { truncate: true }) : { text: '', truncated: false };
      if (!(res.status >= 200 && res.status < 300) && res.body) res.body.cancel().catch(() => {});
      return { finalUrl: url, status: res.status, contentType: res.headers.get('content-type') || '', hops, ...body };
    }
    throw Object.assign(new Error(`Too many redirects (>${MAX_REDIRECTS}).`), { status: 502, code: 'too_many_redirects' });
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error(`Timed out after ${FETCH_TIMEOUT_MS} ms fetching robots.txt.`), { status: 504, code: 'upstream_timeout' });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 429 details for a failed rate-limit result (shared by /api and /mcp). */
export function rateLimitedInfo(what, rl) {
  return { status: 429, code: 'rate_limited', message: `Too many ${what} requests. Limit is ${rl.limit} per ${rl.windowS} seconds per client; retry after ${rl.retryAfter} s.`, headers: { 'retry-after': String(rl.retryAfter) } };
}

function tooMany(what, rl) {
  const i = rateLimitedInfo(what, rl);
  return errorJson(i.status, i.code, i.message, undefined, i.headers);
}

/** Map a thrown error to the REST error tuple. /api and /mcp use the same mapping. */
export function errorInfo(e) {
  if (e instanceof InputError) return { status: 400, code: 'invalid_input', message: e.message, details: e.details };
  if (e instanceof SsrfError) return { status: 400, code: 'url_not_allowed', message: e.message };
  if (e instanceof DnsCheckError) return { status: 502, code: 'dns_check_failed', message: e.message };
  if (e instanceof TooComplexError) return { status: 422, code: 'too_complex', message: e.message, details: e.details };
  if (e.status && e.code) return { status: e.status, code: e.code, message: e.message };
  return { status: 500, code: 'internal_error', message: 'Unexpected error.' };
}

/**
 * Key gate shared by /api and /mcp (recipe step 1). Soft-fail: a missing, invalid, revoked or wrong-product key is the
 * free plan, never an error, so this never returns 401. Returns { plan: 'free' } | { plan: 'pro', maskedKey }.
 */
export const authenticate = (request, env) => resolveProAccess(request, env);

/** Apply free (CF binding / IP) or Pro (in-isolate, masked key) rate limit for a bucket. */
export async function applyPlanRateLimit(request, env, deps, bucket, access) {
  if (access.plan === 'pro') {
    const rate = bucket === 'check' ? PRO_CHECK_RATE : PRO_POST_RATE;
    const lim = bucket === 'check' ? deps.proCheckLimiter : deps.proPostLimiter;
    return rateLimitPro(access.maskedKey, bucket, lim, rate);
  }
  const lim = bucket === 'check' ? deps.limiter : deps.postLimiter;
  return rateLimit(request, env, lim, bucket);
}

export function planHeaders(access, rl) {
  const headers = {};
  if (access.plan === 'pro') headers['x-robotsgate-plan'] = 'pro';
  if (rl && rl.remaining !== undefined) headers['x-ratelimit-remaining'] = String(rl.remaining);
  return headers;
}

async function handleCheck(request, url, env, deps, fetchImpl) {
  // Soft-fail Pro: invalid/missing license → free limits. Valid → skip CF binding, higher in-isolate limits.
  const access = await resolveProAccess(request, env);
  const rl = await applyPlanRateLimit(request, env, deps, 'check', access);
  if (!rl.success) return tooMany('/api/check', rl);
  const r = await checkSite({ target: url.searchParams.get('url'), rawPath: url.searchParams.get('path'), access, rl, env, deps, fetchImpl });
  return json(r.body, 200, r.headers);
}

/**
 * /api/check work after the key gate and rate limit (shared with the MCP check_site tool): URL/SSRF checks, result
 * cache, fetch, validation. Returns { body, headers }; throws the same errors as the route (mapped by errorInfo).
 */
export async function checkSite({ target, rawPath, access, rl, env = {}, deps = {}, fetchImpl }) {
  const path = cleanPath(rawPath);
  const robotsUrl = toRobotsUrl(target);
  const cache = deps.cache || defaultCache;
  let r;
  let cacheInfo = { hit: false, layer: null, ttl_seconds: CACHE_TTL_S };
  const cached = await cache.get(robotsUrl);
  if (cached) {
    r = cached.value;
    cacheInfo = { hit: true, layer: cached.layer, ttl_seconds: CACHE_TTL_S };
  } else {
    try {
      r = await fetchRobots(robotsUrl, fetchImpl, userAgent(env));
    } catch (e) {
      if (e instanceof SsrfError || e instanceof DnsCheckError || e.status) throw e;
      throw Object.assign(new Error(`Could not fetch robots.txt: ${e.message}`), { status: 502, code: 'upstream_error' });
    }
    r.fetchedAt = new Date().toISOString();
    await cache.put(robotsUrl, r, deps.waitUntil);
  }
  const headers = { ...planHeaders(access, rl), 'x-robotsgate-cache': cacheInfo.hit ? `HIT-${cacheInfo.layer}` : 'MISS' };
  const result = { url: robotsUrl, final_url: r.finalUrl, http_status: r.status, redirects: r.hops.length - 1, fetched_at: r.fetchedAt, cache: cacheInfo };
  if (r.status >= 200 && r.status < 300) {
    let v;
    try {
      v = validateWithAgents(r.text, path);
    } catch (e) {
      // On /api/check the file is the site's own robots.txt; say so (stage and limit kept).
      throw e instanceof TooComplexError ? e.forSite() : e;
    }
    // Fetch notes go first in warnings; keep the list within the diagnostics cap and the totals exact.
    const note = (w) => {
      v.warnings.unshift(w);
      v.diagnostics.warnings++;
      if (v.warnings.length > v.diagnostics.limit) {
        v.warnings.pop();
        v.diagnostics.truncated = true;
      }
    };
    if (r.truncated) note({ line: 0, code: 'truncated', message: `robots.txt is larger than ${MAX_ROBOTS_BYTES} bytes; only the first ${MAX_ROBOTS_BYTES} bytes were analysed.` });
    if (/text\/html/i.test(r.contentType) || /^\s*<(!doctype|html)/i.test(r.text)) {
      note({ line: 0, code: 'html', message: 'The server returned HTML instead of a plain-text robots.txt (content-type: ' + r.contentType + '). Crawlers may not parse it as intended.' });
    }
    return { body: { ...result, robots_found: true, interpretation: 'parsed', ...v }, headers };
  }
  if (r.status >= 400 && r.status < 500) {
    const empty = validateWithAgents('', path);
    return { body: { ...result, robots_found: false, interpretation: 'unavailable', message: 'robots.txt is unavailable (4xx). Under RFC 9309, crawlers may access any resource on this host.', path, ai_crawlers: empty.ai_crawlers, personal_agents: empty.personal_agents }, headers };
  }
  return { body: { ...result, robots_found: false, interpretation: 'unreachable', message: 'robots.txt is unreachable (5xx or unexpected status). Under RFC 9309, crawlers should assume complete disallow until it can be fetched.', path, ai_crawlers: null, personal_agents: null }, headers };
}

export async function handle(request, env = {}, deps = {}) {
  const fetchImpl = deps.fetch || ((...a) => fetch(...a));
  const url = new URL(request.url);
  const { pathname } = url;
  // /mcp answers its own preflight (MCP headers, POST only); everything else keeps the API CORS preflight.
  if (request.method === 'OPTIONS' && pathname !== '/mcp') return new Response(null, { status: 204, headers: CORS });
  try {
    if (pathname === '/api' || pathname === '/api/') {
      const checkout = resolveCheckoutUrl(env);
      return json({
        name: 'RobotsGate API',
        version: VERSION,
        endpoints: ['GET /api/crawlers', 'POST /api/generate', 'POST /api/validate', 'GET /api/check?url=', 'GET /api/health', 'POST /mcp', 'GET /llms.txt', 'GET /openapi.json', 'GET /.well-known/mcp/server-card.json'],
        note: 'robots.txt is voluntary and is not access control.',
        pro: {
          product: PRODUCT_SLUG,
          price_usd_month: PRO_PRICE_USD_MONTH,
          check_limit_per_min: PRO_CHECK_RATE.limit,
          post_limit_per_min: PRO_POST_RATE.limit,
          checkout_url: checkout || null,
          // License via Authorization: Bearer <RBTG…> or X-License-Key. Soft-fail: bad keys stay on free tier.
        },
      });
    }
    if (pathname === '/api/health' || pathname === '/health') { // v0.3.2: /health aliases /api/health
      if (request.method !== 'GET' && request.method !== 'HEAD') return errorJson(405, 'method_not_allowed', 'Use GET.');
      return json({ ok: true, version: VERSION });
    }
    if (pathname === '/api/crawlers') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return errorJson(405, 'method_not_allowed', 'Use GET.');
      const cat = url.searchParams.get('category');
      const data = cat ? { ...registry, crawlers: registry.crawlers.filter((c) => c.category === cat) } : registry;
      return json(data, 200, { 'cache-control': 'public, max-age=3600' });
    }
    if (pathname === '/api/generate') {
      if (request.method !== 'POST') return errorJson(405, 'method_not_allowed', 'Use POST with a JSON body.');
      const access = await resolveProAccess(request, env);
      const rl = await applyPlanRateLimit(request, env, deps, 'post', access);
      if (!rl.success) return tooMany('/api/generate + /api/validate', rl);
      const res = await handleGenerate(request);
      const ph = planHeaders(access, rl);
      for (const [k, v] of Object.entries(ph)) res.headers.set(k, v);
      return res;
    }
    if (pathname === '/api/validate') {
      if (request.method !== 'POST') return errorJson(405, 'method_not_allowed', 'Use POST with a JSON body.');
      const access = await resolveProAccess(request, env);
      const rl = await applyPlanRateLimit(request, env, deps, 'post', access);
      if (!rl.success) return tooMany('/api/generate + /api/validate', rl);
      const res = await handleValidate(request);
      const ph = planHeaders(access, rl);
      for (const [k, v] of Object.entries(ph)) res.headers.set(k, v);
      return res;
    }
    if (pathname === '/api/check') {
      if (request.method !== 'GET') return errorJson(405, 'method_not_allowed', 'Use GET.');
      return await handleCheck(request, url, env, deps, fetchImpl);
    }
    // v0.3.0 RapidAPI marketplace route (HeaderGuard pattern): proxy-secret gate first, own per-tier limiters,
    // same work functions as /api. Routed before the Polar key gate; RBTG keys are not read here.
    if (isRapidApiPath(pathname)) {
      return await handleRapidApi(request, env, deps, pathname, url, {
        json, errorJson, errorInfo, checkSite, readJsonBody, validateBody, generateRobots, fetchImpl, version: VERSION,
        ipBucket: ipBucket(request.headers.get('cf-connecting-ip') || 'unknown'),
      });
    }
    if (pathname.startsWith('/api/')) return errorJson(404, 'not_found', `No such endpoint: ${pathname}`);
    // v0.2.9: remote MCP server (Streamable HTTP, stateless, JSON responses). Same key gate, limiters and work
    // functions as /api; see src/mcp.js.
    if (pathname === '/mcp') {
      return await handleMcp(request, env, {
        ...deps,
        fetchImpl,
        origin: url.origin,
        allowedOrigins: env.MCP_ALLOWED_ORIGINS,
        security: { 'x-content-type-options': 'nosniff' },
        app: { authenticate, applyPlanRateLimit, rateLimitedInfo, planHeaders, errorInfo, checkSite, validateBody, generateRobots, registry },
      });
    }
    // v0.2.9: agent discovery documents, generated from code constants (src/agentdocs.js).
    if (pathname === '/llms.txt' || pathname === '/openapi.json' || pathname === '/.well-known/mcp/server-card.json' || pathname === '/.well-known/mcp-registry-auth' || pathname === '/.well-known/glama.json') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return errorJson(405, 'method_not_allowed', 'Use GET.', undefined, { allow: 'GET, HEAD, OPTIONS' });
      const head = request.method === 'HEAD';
      const doc = (body, type, cache = 'public, max-age=3600') => new Response(head ? null : body, { headers: { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff', ...CORS } });
      if (pathname === '/llms.txt') return doc(llmsTxt(url.origin), 'text/plain; charset=utf-8');
      if (pathname === '/openapi.json') return doc(JSON.stringify(openApiSpec(url.origin), null, 2), 'application/json; charset=utf-8');
      if (pathname === '/.well-known/mcp/server-card.json') return doc(JSON.stringify(serverCard(url.origin), null, 2), 'application/json; charset=utf-8');
      if (pathname === '/.well-known/glama.json') return doc(GLAMA_JSON, 'application/json');
      // Official MCP Registry HTTP namespace proof (recipe step 10). Only a PUBLIC key record, from a wrangler var;
      // 404 until it is set (it isn't in v0.2.9).
      const proof = String(env.MCP_REGISTRY_AUTH || '').trim();
      if (/^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/.test(proof)) return doc(`${proof}\n`, 'text/plain; charset=utf-8', 'no-store');
      return errorJson(404, 'not_found', 'Not found.');
    }
    // No MCP OAuth here (recipe v3 §2): clients that probe for it must get a 404, never a 200 page.
    if (pathname.startsWith('/.well-known/oauth-')) return errorJson(404, 'not_found', 'Not found.');
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return errorJson(404, 'not_found', 'Not found.');
  } catch (e) {
    const i = errorInfo(e);
    return errorJson(i.status, i.code, i.message, i.details);
  }
}
