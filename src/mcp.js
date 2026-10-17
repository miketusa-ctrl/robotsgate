/**
 * RobotsGate remote MCP server (v0.2.9). Hand-rolled JSON-RPC 2.0 over Streamable HTTP; no SDK, no dependencies. Transport
 * adapted from DnsGuard's src/lib/mcp.js (shared agent-ready recipe, steps 1-2). The tools and the key gate are
 * RobotsGate's own.
 *
 * Dual-era and stateless (same as DnsGuard):
 *  - Modern (MCP 2026-07-28): every request carries params._meta["io.modelcontextprotocol/protocolVersion"] plus the
 *    MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. Methods: server/discover, tools/list, tools/call.
 *  - Legacy (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05): initialize handshake, notifications/initialized, ping,
 *    tools/list, tools/call. JSON-RPC batches (max 10 messages, at most one tools/call) are accepted for legacy clients.
 *  - No sessions: no Mcp-Session-Id is ever issued; one sent by a client is ignored. GET/DELETE → 405 (no SSE stream).
 *  - Responses are always application/json (no SSE).
 *
 * Keys and limits are NOT re-implemented here. The router passes in the exact functions behind /api (deps.app):
 * authenticate() (soft-fail Pro gate: a missing or invalid key is the free plan, so /mcp never answers 401),
 * applyPlanRateLimit() (RATE_LIMITER 7701 / POST_LIMITER 7702 for free, in-isolate per masked key for Pro),
 * checkSite(), validateBody(), generateRobots() and errorInfo(). One tools/call = one request against the same
 * counter as the matching /api route:
 *   check_site      → /api/check bucket (free 20 / Pro 300 per 60 s)
 *   generate_robots → POST bucket shared by /api/generate + /api/validate (free 60 / Pro 600 per 60 s)
 *   validate_robots → same POST bucket
 *   list_crawlers   → like GET /api/crawlers it uses no API counter; it counts toward the light per-IP MCP cap below.
 * initialize / tools/list / ping / server/discover never touch API counters; together with list_crawlers they have a
 * light per-isolate cap per IP (DISCOVERY_PER_MIN).
 */
import { VERSION } from './version.js';
import { CATEGORIES, LIMITS } from './generate.js';
import { CHECK_RATE, POST_RATE, InIsolateLimiter, clientKey } from './protect.js';
import { PRO_CHECK_RATE, PRO_POST_RATE, PRO_PRICE_USD_MONTH } from './pro.js';
import { MAX_ROBOTS_BYTES } from './robots.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 10;
export const MAX_CHECKS_PER_REQUEST = 1; // one tools/call per HTTP request: bounds CPU per invocation (cpu_ms = 100)
export const DISCOVERY_PER_MIN = 120; // per IP per isolate: non-check messages + list_crawlers
// validate_robots over MCP: the 64 KB request cap leaves room for about this much robots.txt text. Larger files
// (up to MAX_ROBOTS_BYTES) go through POST /api/validate or check_site.
// 50,000 characters so a typical file still fits the 64 KB body after JSON escaping (each newline is 2 bytes as "\n").
export const MCP_MAX_ROBOTS_CHARS = 50_000;
export const NOT_AFFILIATED = 'RobotsGate is not affiliated with Meta or any other crawler or agent operator.';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
const ERROR_META = 'robotsgate/error';

// JSON-RPC / MCP error codes
export const E = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  SERVER: -32000, // implementation-defined (rate limit, body too large, forbidden origin)
  HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

export const MCP_CORS = {
  // Keys are explicit headers (never ambient cookies), so a wildcard origin without credentials is safe and lets
  // browser-based MCP inspectors work. Same policy as /api.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS', // GET/DELETE → 405 (no SSE stream, no sessions)
  'access-control-allow-headers': 'content-type, accept, authorization, x-license-key, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': 'mcp-protocol-version, retry-after, x-robotsgate-cache, x-ratelimit-remaining, x-robotsgate-plan',
  'access-control-max-age': '86400',
};

export const SERVER_INFO = { name: 'robotsgate', title: 'RobotsGate', version: VERSION };
export const INSTRUCTIONS = 'RobotsGate generates and validates robots.txt rules for AI crawlers and checks which AI crawlers a live site\'s robots.txt allows. '
  + 'Tools: list_crawlers (the sourced AI crawler registry), generate_robots (build a robots.txt from category/agent choices), '
  + 'validate_robots (RFC 9309 validation of robots.txt text, plus which AI crawlers it blocks for a path) and check_site (fetch a site\'s /robots.txt and analyse it). '
  + 'robots.txt is voluntary and is not access control; it only reaches crawlers that read and follow it. '
  + `Free limits per client IP: ${CHECK_RATE.limit} check_site calls and ${POST_RATE.limit} generate_robots/validate_robots calls per ${CHECK_RATE.windowMs / 1000} seconds, shared with the JSON API. `
  + `RobotsGate Pro ($${PRO_PRICE_USD_MONTH}/mo) raises them to ${PRO_CHECK_RATE.limit} and ${PRO_POST_RATE.limit}: send "Authorization: Bearer <RBTG license key>" or "X-License-Key: <key>". A missing or invalid key simply uses the free limits. `
  + NOT_AFFILIATED;

// ---------- tools ----------
const ACTION = { type: 'string', enum: ['allow', 'block', 'omit'] };
const pathList = (what) => ({
  type: 'array', maxItems: LIMITS.maxPaths,
  items: { type: 'string', minLength: 1, maxLength: LIMITS.maxPathLen },
  description: `${what} Each path starts with "/" or "*" and has no whitespace or "#". At most ${LIMITS.maxPaths}.`,
});
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const CATEGORY_HELP = 'training, dataset, search, user_fetch or other';

export const TOOLS = [
  {
    name: 'list_crawlers',
    title: 'List the AI crawler registry',
    description: 'Return RobotsGate\'s AI crawler registry: each crawler\'s robots.txt token, operator, category (' + CATEGORY_HELP + '), whether the operator says it respects robots.txt, and a link to the operator\'s documentation, plus unverified entries and notes. Read-only, no network access. Same data as GET /api/crawlers.',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', enum: CATEGORIES, description: 'Optional: only crawlers in this category.' } },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        schema_version: { type: 'integer' },
        generated: { type: 'string' },
        categories: { type: 'object' },
        crawlers: { type: 'array', items: { type: 'object' } },
        unverified: { type: 'array', items: { type: 'object' } },
      },
      required: ['categories', 'crawlers'],
    },
    annotations: { title: 'List AI crawlers', ...RO, openWorldHint: false },
  },
  {
    name: 'generate_robots',
    title: 'Generate a robots.txt for AI crawlers',
    description: 'Build a robots.txt from per-category choices (allow, block or omit for ' + CATEGORY_HELP + '), optional per-token overrides, a default policy for other bots, paths, sitemaps and custom rules. Returns the file text, a per-crawler summary and notes. Read-only: it only returns text and changes nothing. Same engine as POST /api/generate.',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'object',
          description: 'Action per crawler category. Omitted categories get no group of their own.',
          properties: Object.fromEntries(CATEGORIES.map((c) => [c, ACTION])),
          additionalProperties: false,
        },
        agents: {
          type: 'object',
          description: `Per-token overrides, e.g. {"GPTBot": "block"}. Tokens: letters, digits, "_", "." and "-", up to 64 characters (not "*"). At most ${LIMITS.maxAgents}.`,
          maxProperties: LIMITS.maxAgents,
          propertyNames: { pattern: '^[A-Za-z0-9_.-]{1,64}$' },
          additionalProperties: ACTION,
        },
        default: { type: 'string', enum: ['allow', 'block'], description: 'Policy for "User-agent: *" (default allow).' },
        disallow_paths: pathList('Paths to disallow for "*" and for allowed AI groups.'),
        allow_paths: pathList('Paths to allow explicitly.'),
        sitemaps: { type: 'array', maxItems: LIMITS.maxSitemaps, items: { type: 'string', maxLength: 2048 }, description: `Absolute http(s) sitemap URLs. At most ${LIMITS.maxSitemaps}.` },
        sitemap: { type: 'string', maxLength: 2048, description: 'A single sitemap URL (alternative to sitemaps).' },
        custom_rules: { type: 'string', maxLength: LIMITS.maxCustomBytes, description: `Extra robots.txt lines appended after validation (max ${LIMITS.maxCustomBytes} bytes).` },
        date: { type: 'string', maxLength: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Date for the header comment (YYYY-MM-DD). Default: today (UTC).' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        robots_txt: { type: 'string' },
        summary: { type: 'array', items: { type: 'object' } },
        notes: { type: 'array', items: { type: 'string' } },
        personal_agents_note: { type: 'string' },
      },
      required: ['robots_txt', 'summary', 'notes'],
    },
    annotations: { title: 'Generate robots.txt', ...RO, openWorldHint: false },
  },
  {
    name: 'validate_robots',
    title: 'Validate robots.txt text',
    description: `Validate robots.txt text against RFC 9309 and report errors, warnings and, for one URL path, which registry AI crawlers are allowed or blocked and by which rule. Read-only, no network access. Same engine as POST /api/validate. Up to ${MCP_MAX_ROBOTS_CHARS.toLocaleString('en-US')} characters over MCP (the whole JSON-RPC request must also fit in 64 KB); for larger files use POST /api/validate or check_site.`,
    inputSchema: {
      type: 'object',
      properties: {
        robots_txt: { type: 'string', maxLength: MCP_MAX_ROBOTS_CHARS, description: 'The robots.txt file content.' },
        path: { type: 'string', maxLength: 2048, description: 'URL path to test, starting with "/" (default "/").' },
      },
      required: ['robots_txt'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        valid: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'object' } },
        warnings: { type: 'array', items: { type: 'object' } },
        info: { type: 'array', items: { type: 'object' } },
        diagnostics: { type: 'object' },
        stats: { type: 'object' },
        path: { type: 'string' },
        ai_crawlers: { type: 'array', items: { type: 'object' } },
        personal_agents: { type: 'object' },
      },
      required: ['valid', 'errors', 'warnings', 'ai_crawlers'],
    },
    annotations: { title: 'Validate robots.txt', ...RO, openWorldHint: false },
  },
  {
    name: 'check_site',
    title: 'Check which AI crawlers a live site allows',
    description: `Fetch a site's /robots.txt (http/https on the default port only; private, loopback and internal addresses are refused; up to ${MAX_ROBOTS_BYTES.toLocaleString('en-US')} bytes; results cached for 5 minutes) and report, for one path, which registry AI crawlers are allowed or blocked, plus validation errors and warnings. Read-only: one GET of /robots.txt with a RobotsGate user-agent. Same engine as GET /api/check.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048, description: 'Site URL or bare hostname, e.g. example.com. Only the scheme and host are used.' },
        path: { type: 'string', maxLength: 2048, description: 'URL path to test, starting with "/" (default "/").' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        final_url: { type: 'string' },
        http_status: { type: 'integer' },
        redirects: { type: 'integer' },
        fetched_at: { type: 'string' },
        cache: { type: 'object' },
        robots_found: { type: 'boolean' },
        interpretation: { type: 'string', enum: ['parsed', 'unavailable', 'unreachable'] },
        path: { type: 'string' },
        ai_crawlers: { anyOf: [{ type: 'array', items: { type: 'object' } }, { type: 'null' }], description: 'Per-crawler results, or null when robots.txt was unreachable' },
        personal_agents: { anyOf: [{ type: 'object' }, { type: 'null' }], description: 'Object, or null when robots.txt was unreachable' },
      },
      required: ['url', 'final_url', 'http_status', 'robots_found', 'interpretation'],
    },
    annotations: { title: 'Check a live site', ...RO, openWorldHint: true },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function toolError(message, data) {
  return { content: [{ type: 'text', text: message }], isError: true, ...(data ? { _meta: { [ERROR_META]: data } } : {}) };
}

/** Short text for a validate/check body (content[0]); the full body is structuredContent. */
export function crawlerSummaryText(v) {
  const lines = [];
  if (typeof v.valid === 'boolean') {
    const d = v.diagnostics || {};
    lines.push(`robots.txt ${v.valid ? 'has no errors' : 'has errors'}: ${d.errors ?? (v.errors || []).length} errors, ${d.warnings ?? (v.warnings || []).length} warnings.`);
    for (const e of (v.errors || []).slice(0, 3)) lines.push(`- error (line ${e.line}): ${clip(String(e.message), 200)}`);
  }
  if (Array.isArray(v.ai_crawlers)) {
    const blocked = v.ai_crawlers.filter((c) => c.status === 'blocked').map((c) => c.name);
    const allowed = v.ai_crawlers.filter((c) => c.status !== 'blocked').map((c) => c.name);
    lines.push(`For path ${v.path ?? '/'}: ${blocked.length} of ${v.ai_crawlers.length} registry AI crawlers are blocked${blocked.length ? ` (${blocked.slice(0, 30).join(', ')}${blocked.length > 30 ? ', …' : ''})` : ''}; ${allowed.length} are allowed.`);
  }
  if (v.personal_agents && typeof v.personal_agents === 'object') {
    lines.push('robots.txt does not reliably reach personal agents that browse for one person; see structuredContent.personal_agents.');
  }
  lines.push('robots.txt is voluntary and is not access control.');
  return lines.join('\n');
}

function generateText(g) {
  const text = clip(g.robots_txt, 20_000);
  const out = [`Generated robots.txt (${g.robots_txt.length} characters${text !== g.robots_txt ? '; truncated here, the full file is in structuredContent.robots_txt' : ''}):`, '', text];
  if (g.notes && g.notes.length) out.push('', 'Notes:', ...g.notes.slice(0, 10).map((n) => `- ${clip(String(n), 300)}`));
  if (g.personal_agents_note) out.push('', g.personal_agents_note);
  return out.join('\n');
}

function registryText(r, category) {
  const by = {};
  for (const c of r.crawlers) (by[c.category] ||= []).push(c.name);
  const parts = Object.entries(by).map(([k, names]) => `${k}: ${names.join(', ')}`);
  return [`RobotsGate AI crawler registry (generated ${r.generated})${category ? `, category ${category}` : ''}: ${r.crawlers.length} crawlers.`, ...parts,
    `Unverified entries (not used for generation): ${(r.unverified || []).length}.`, NOT_AFFILIATED].join('\n');
}

function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** tools/call. Returns { result } or { error } (protocol error), plus HTTP headers to surface. */
async function callTool(params, deps) {
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;
  const tool = typeof name === 'string' ? TOOL_BY_NAME.get(name) : undefined;
  if (!tool) return { error: { code: E.INVALID_PARAMS, message: `Unknown tool: ${clip(String(name), 80)}` } };
  if (!asObject(args)) return { error: { code: E.INVALID_PARAMS, message: 'arguments must be an object' } };
  // Input problems are tool-execution errors (isError) so the model can correct itself. Nothing below this point
  // touches a limiter until the arguments have the right shape.
  const allowed = Object.keys(tool.inputSchema.properties);
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    return { result: toolError(`Unknown argument(s): ${clip(unknown.slice(0, 5).join(', '), 80)}. Allowed: ${allowed.join(', ')}.`, { code: 'invalid_arguments', httpStatus: 400 }) };
  }
  const bad = (msg) => ({ result: toolError(msg, { code: 'invalid_arguments', httpStatus: 400 }) });
  for (const k of ['path', 'url', 'robots_txt', 'sitemap', 'custom_rules', 'date', 'default']) {
    if (k in args && args[k] !== undefined && args[k] !== null && typeof args[k] !== 'string') return bad(`${k} must be a string.`);
  }
  for (const k of tool.inputSchema.required || []) if (typeof args[k] !== 'string') return bad(`${k} (string) is required.`);

  const { app, request, env } = deps;
  const fail = (info, headers = {}) => {
    const retry = info.headers && info.headers['retry-after'] ? Number(info.headers['retry-after']) : undefined;
    const details = Array.isArray(info.details) ? info.details.slice(0, 10).map((d) => clip(String(d), 200)) : undefined;
    const msg = `${info.message}${details ? ` ${details.join('; ')}` : ''}${retry ? ` (retry after ${retry} seconds)` : ''}`;
    return {
      result: toolError(msg, { code: info.code, httpStatus: info.status, ...(retry ? { retryAfterSeconds: retry } : {}), ...(details ? { details } : {}) }),
      headers: { ...headers, ...(info.headers || {}) },
    };
  };
  const run = async (fn) => {
    try { return { value: await fn() }; } catch (e) { return { info: app.errorInfo(e) }; }
  };

  if (tool.name === 'list_crawlers') {
    if (args.category !== undefined && !CATEGORIES.includes(args.category)) return bad(`category must be one of: ${CATEGORIES.join(', ')}.`);
    const hit = deps.discovery.hit(`mcp:${clientKey(request)}`);
    if (!hit.success) return fail({ status: 429, code: 'rate_limited', message: `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute).`, headers: { 'retry-after': String(hit.retryAfter) } });
    const r = app.registry;
    const data = args.category ? { ...r, crawlers: r.crawlers.filter((c) => c.category === args.category) } : r;
    return { result: { content: [{ type: 'text', text: registryText(data, args.category) }], structuredContent: data, isError: false } };
  }

  // Everything else uses the /api key gate and counters. Soft-fail: never an auth error.
  const access = await app.authenticate(request, env);
  if (tool.name === 'check_site') {
    const rl = await app.applyPlanRateLimit(request, env, deps, 'check', access);
    if (!rl.success) return fail(app.rateLimitedInfo('check_site (shared with /api/check)', rl), app.planHeaders(access, rl));
    const r = await run(() => app.checkSite({ target: args.url, rawPath: args.path, access, rl, env, deps, fetchImpl: deps.fetchImpl }));
    if (r.info) return fail(r.info, app.planHeaders(access, rl));
    return { result: { content: [{ type: 'text', text: `Checked ${r.value.body.url}: HTTP ${r.value.body.http_status}, ${r.value.body.interpretation}.\n${crawlerSummaryText(r.value.body)}` }], structuredContent: r.value.body, isError: false }, headers: r.value.headers };
  }

  // generate_robots / validate_robots: the POST bucket shared by /api/generate and /api/validate.
  if (tool.name === 'validate_robots' && args.robots_txt.length > MCP_MAX_ROBOTS_CHARS) {
    return fail({ status: 413, code: 'payload_too_large', message: `robots_txt is longer than ${MCP_MAX_ROBOTS_CHARS} characters, the MCP limit. Use POST /api/validate (up to ${MAX_ROBOTS_BYTES} bytes) or check_site.` });
  }
  const rl = await app.applyPlanRateLimit(request, env, deps, 'post', access);
  const headers = app.planHeaders(access, rl);
  if (!rl.success) return fail(app.rateLimitedInfo(`${tool.name} (shared with /api/generate + /api/validate)`, rl), headers);
  if (tool.name === 'generate_robots') {
    const r = await run(() => app.generateRobots(args));
    if (r.info) return fail(r.info, headers);
    return { result: { content: [{ type: 'text', text: generateText(r.value) }], structuredContent: r.value, isError: false }, headers };
  }
  const r = await run(() => app.validateBody(args));
  if (r.info) return fail(r.info, headers);
  return { result: { content: [{ type: 'text', text: crawlerSummaryText(r.value) }], structuredContent: r.value, isError: false }, headers };
}

// ---------- transport helpers (copied from DnsGuard src/lib/mcp.js) ----------

/** Origin policy: absent = OK (CLI / server-side clients). Present: must be a bare https origin or an http loopback
 * origin, or (if MCP_ALLOWED_ORIGINS is set) same-origin / listed. Malformed, "null" and plain-http remote → 403. */
export function originAllowed(origin, selfOrigin, allowList) {
  if (origin === null || origin === undefined) return true;
  if (origin === selfOrigin) return true;
  if (allowList) return String(allowList).split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

// MCP: "string or integer ID".
const isId = (id) => typeof id === 'string' || Number.isSafeInteger(id);
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * Handle one JSON-RPC message. Returns { response?, status?, headers?, isCheck? }.
 * `response` undefined = notification accepted (202 when it's the whole request).
 */
async function handleMessage(msg, { modern, request, deps, checkBudget }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request'), status: 400 };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.jsonrpc !== '2.0') return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'), status: 400 };
  if (typeof msg.method !== 'string') {
    // A JSON-RPC response or garbage. Legacy clients may POST responses → accept like a notification.
    if (!modern && hasId && ('result' in msg || 'error' in msg)) return {};
    return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: method is required'), status: 400 };
  }
  if (!hasId) return {}; // notification (notifications/initialized, cancelled, …): accepted, nothing to do
  if (!isId(msg.id)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request: id must be a string or integer'), status: 400 };
  const { id, method } = msg;
  const params = msg.params === undefined ? {} : msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { response: rpcError(id, E.INVALID_PARAMS, 'params must be an object') };

  // merge so a tool error's _meta[ERROR_META] survives under 2026-07-28.
  const done = (result) => ({ response: rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER]: SERVER_INFO } } : result) });
  const notFound = () => ({ response: rpcError(id, E.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`), status: modern ? 404 : 200 });

  if (modern) {
    // MCP 2026-07-28 per-request validation (version, capabilities, mirrored headers).
    const hName = decodeHeaderValue(request.headers.get('mcp-name'));
    if (request.headers.get('mcp-method') !== method) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing or does not match the body method'), status: 400 };
    if (!params._meta || typeof params._meta[META_CAPS] !== 'object' || params._meta[META_CAPS] === null) {
      return { response: rpcError(id, E.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`), status: 400 };
    }
    if (method === 'tools/call' && hName !== params.name) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), status: 400 };
    if (method === 'server/discover') {
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: 'public' });
    }
    if (method === 'tools/list') return done({ tools: TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method !== 'tools/call') return notFound(); // includes initialize and ping (removed in 2026-07-28)
  } else {
    if (method === 'initialize') {
      const req = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(req) ? req : LEGACY_VERSIONS[0];
      return done({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    if (method === 'ping') return done({});
    if (method === 'tools/list') return done({ tools: TOOLS });
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    if (method !== 'tools/call') return notFound();
  }

  // tools/call
  if (typeof params.name !== 'string') return { response: rpcError(id, E.INVALID_PARAMS, 'params.name (tool name) is required') };
  if (checkBudget.used >= MAX_CHECKS_PER_REQUEST) {
    return { response: rpcError(id, E.INVALID_REQUEST, `At most ${MAX_CHECKS_PER_REQUEST} tools/call per HTTP request; send each call as its own request.`) };
  }
  checkBudget.used++;
  const r = await callTool(params, deps);
  if (r.error) return { response: rpcError(id, r.error.code, r.error.message), isCheck: true };
  return { ...done(r.result), headers: r.headers, isCheck: true };
}

const defaultDiscovery = new InIsolateLimiter({ limit: DISCOVERY_PER_MIN, windowMs: 60_000 });

/**
 * Entry point from the router for every request to /mcp.
 * deps: { app, origin, allowedOrigins, security, fetchImpl, discovery?, ...the /api deps (limiters, cache, waitUntil) }
 */
export async function handleMcp(request, env, deps) {
  const base = { ...MCP_CORS, ...(deps.security || {}) };
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), 'cache-control': 'no-store', ...base, ...extra },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...MCP_CORS } });
  if (!originAllowed(request.headers.get('origin'), deps.origin, deps.allowedOrigins)) {
    return reply(403, rpcError(undefined, E.SERVER, 'Forbidden: Origin not allowed'));
  }
  if (request.method !== 'POST') {
    return reply(405, rpcError(undefined, E.SERVER, 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream, no sessions). Docs: /llms.txt'), { allow: 'POST, OPTIONS' });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, rpcError(undefined, E.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
  let payload;
  try { payload = JSON.parse(text); } catch { return reply(400, rpcError(null, E.PARSE, 'Parse error: body must be valid JSON')); }

  // Era detection. Modern = per-request _meta version or a modern MCP-Protocol-Version header.
  const hVer = request.headers.get('mcp-protocol-version');
  const single = !Array.isArray(payload);
  const metaVer = single && payload && typeof payload === 'object' && payload.params && typeof payload.params === 'object'
    && payload.params._meta && typeof payload.params._meta === 'object' ? payload.params._meta[META_VERSION] : undefined;
  const modern = metaVer !== undefined || MODERN_VERSIONS.includes(hVer);
  const idOf = (p) => (p && typeof p === 'object' && isId(p.id) ? p.id : null);
  if (modern) {
    if (!single) return reply(400, rpcError(null, E.INVALID_REQUEST, 'JSON-RPC batches are not supported in protocol 2026-07-28; send one message per POST'));
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      if (metaVer === undefined && typeof payload.method === 'string') {
        return reply(400, rpcError(idOf(payload), E.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`));
      }
      if (metaVer !== undefined && !SUPPORTED_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(String(metaVer), 40) }));
      }
      if (metaVer !== undefined && !MODERN_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, `Protocol version ${metaVer} uses the initialize handshake; per-request _meta requires one of: ${MODERN_VERSIONS.join(', ')}`, { supported: SUPPORTED_VERSIONS, requested: metaVer }));
      }
      if (hVer !== metaVer) return reply(400, rpcError(idOf(payload), E.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing or does not match _meta protocolVersion'));
    }
  } else if (hVer && !LEGACY_VERSIONS.includes(hVer)) {
    return reply(400, rpcError(single ? idOf(payload) : null, E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(hVer, 40) }));
  }

  const msgs = single ? [payload] : payload;
  if (!msgs.length) return reply(400, rpcError(null, E.INVALID_REQUEST, 'Invalid Request: empty batch'));
  if (msgs.length > MAX_BATCH) return reply(400, rpcError(null, E.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH} messages)`));

  // Light per-IP cap on non-check messages (tools/call is governed by the /api limits, or this cap for list_crawlers).
  const discovery = deps.discovery || defaultDiscovery;
  const nonCheck = msgs.filter((m) => !(m && m.method === 'tools/call')).length;
  for (let i = 0; i < nonCheck; i++) {
    const hit = discovery.hit(`mcp:${clientKey(request)}`);
    if (!hit.success) {
      return reply(429, rpcError(single ? idOf(payload) : null, E.SERVER, `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute). Retry in a minute.`, { code: 'rate_limited', retryAfterSeconds: hit.retryAfter }), { 'retry-after': String(hit.retryAfter) });
    }
  }

  // No auth step here: RobotsGate's key gate is soft-fail (a bad key = free plan), so there is no 401 path. The key
  // is read per tools/call by the same authenticate() as /api.
  const mdeps = { ...deps, discovery, request, env };
  const checkBudget = { used: 0 };
  const responses = [];
  let status = 200;
  let headers = {};
  for (const m of msgs) {
    let out;
    try {
      out = await handleMessage(m, { modern, request, deps: mdeps, checkBudget });
    } catch {
      out = { response: rpcError(idOf(m), E.INTERNAL, 'Internal error') };
    }
    if (out.response) responses.push(out.response);
    if (out.headers) headers = { ...headers, ...out.headers };
    if (single) status = out.status || 200;
  }
  if (!responses.length) return reply(202, null);
  const exposed = {};
  for (const h of ['retry-after', 'x-robotsgate-cache', 'x-ratelimit-remaining', 'x-robotsgate-plan']) if (headers[h]) exposed[h] = headers[h];
  return reply(status, single ? responses[0] : responses, exposed);
}
