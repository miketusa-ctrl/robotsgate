/**
 * Agent-discovery documents (v0.2.9, shared agent-ready recipe steps 3-4 and §13.2): /llms.txt (llmstxt.org format),
 * /openapi.json (OpenAPI 3.1) and /.well-known/mcp/server-card.json (Smithery static server card, SEP-1649 shape).
 * Generated from code constants so limits, versions, tools and URLs can't drift from what the Worker enforces.
 * test/v029-agent.test.js checks them against the real router.
 */
import { VERSION } from './version.js';
import { CHECK_RATE, POST_RATE, CACHE_TTL_S } from './protect.js';
import { PRO_CHECK_RATE, PRO_POST_RATE, PRO_PRICE_USD_MONTH, PRO_CHECKOUT_URL } from './pro.js';
import { MAX_ROBOTS_BYTES } from './robots.js';
import { CATEGORIES, LIMITS } from './generate.js';
import {
  TOOLS, SERVER_INFO, INSTRUCTIONS, SUPPORTED_VERSIONS, MAX_BODY_BYTES, MAX_BATCH, DISCOVERY_PER_MIN,
  MCP_MAX_ROBOTS_CHARS, NOT_AFFILIATED,
} from './mcp.js';

export const CONTACT_EMAIL = 'digitalpromohub.support@gmail.com';
export const GUIDES = [
  ['/guides/block-gptbot-ai-crawlers', 'How to block GPTBot and other AI crawlers'],
  ['/guides/allow-ai-search-block-ai-training', 'Allow AI search, block AI training'],
  ['/guides/check-which-ai-bots-can-crawl-your-site', 'Check which AI bots can crawl your site'],
  ['/guides/cloudflare-ai-crawler-settings-robots-txt', 'Cloudflare AI crawler settings and robots.txt'],
  ['/guides/should-i-let-muse-agents-onto-my-site', 'Should I let Meta\'s Muse agents onto my site?'],
];
const fmt = (n) => n.toLocaleString('en-US');
const WINDOW_S = CHECK_RATE.windowMs / 1000;

export function mcpClientConfig(origin) {
  return { mcpServers: { robotsgate: { type: 'http', url: `${origin}/mcp` } } };
}

export function llmsTxt(origin) {
  return `# RobotsGate

> Free robots.txt generator, validator and live-site checker for AI crawlers such as GPTBot, ClaudeBot, Google-Extended and PerplexityBot, built on a sourced AI crawler registry. Public JSON API plus a remote MCP server for AI agents.

robots.txt is voluntary and is not access control: it only reaches crawlers that read and follow it. Crawler details come from each operator's own documentation (linked per crawler in the registry). ${NOT_AFFILIATED}

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP at \`${origin}/mcp\` (POST only, stateless, JSON responses, no sessions). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')} (2026-07-28 per-request \`_meta\`; older versions use \`initialize\`). Tools: \`list_crawlers\` (optional \`category\`: ${CATEGORIES.join(', ')}), \`generate_robots\` (\`categories\`, \`agents\`, \`default\`, \`disallow_paths\`, \`allow_paths\`, \`sitemaps\`, \`custom_rules\`, \`sitemap\`, \`date\`, all optional), \`validate_robots\` (\`robots_txt\` required, up to ${fmt(MCP_MAX_ROBOTS_CHARS)} characters, and the whole request must fit in ${fmt(MAX_BODY_BYTES)} bytes; optional \`path\`) and \`check_site\` (\`url\` required, optional \`path\`). All read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API
- [JSON API docs](${origin}/docs): human-readable API reference with examples
- [MCP server card](${origin}/.well-known/mcp/server-card.json): static description of the MCP server and its tools

## JSON API

- \`GET ${origin}/api/crawlers\` (optional \`?category=training|dataset|search|user_fetch|other\`): the AI crawler registry (\`crawlers[]\` with \`name\`, \`operator\`, \`category\`, \`respects_robots\`, \`docs_url\`; plus \`unverified\`, \`categories\`, \`notes\`).
- \`POST ${origin}/api/generate\` (JSON body: \`categories\`, \`agents\`, \`default\`, \`disallow_paths\`, \`allow_paths\`, \`sitemaps\`, \`custom_rules\`, \`sitemap\`, \`date\`): \`{ robots_txt, summary, notes, custom_rules_diagnostics, personal_agents_note }\`.
- \`POST ${origin}/api/validate\` (JSON body: \`robots_txt\` up to ${fmt(MAX_ROBOTS_BYTES)} bytes, optional \`path\`): \`valid\`, \`errors\`, \`warnings\`, \`info\`, \`diagnostics\`, \`stats\`, \`ai_crawlers[]\` (per crawler: \`status\` allowed/blocked, \`deciding_rule\`), \`personal_agents\`.
- \`GET ${origin}/api/check?url=example.com\` (optional \`&path=/\`): fetches the site's /robots.txt (default ports only; private and internal addresses refused; cached ${CACHE_TTL_S / 60} minutes) and returns the validate fields plus \`http_status\`, \`final_url\`, \`robots_found\`, \`interpretation\`.
- \`GET ${origin}/api/health\`: \`{ "ok": true, "version": "${VERSION}" }\`
- Errors: \`{ "error": { "code", "message", "details"? } }\` with HTTP 400 \`invalid_input\`/\`invalid_json\`/\`url_not_allowed\`, 405 \`method_not_allowed\`, 413 \`payload_too_large\`, 415 \`unsupported_media_type\`, 422 \`too_complex\`, 429 \`rate_limited\` (see \`Retry-After\`), 500 \`internal_error\`, 502 \`dns_check_failed\`/\`upstream_error\`/\`too_many_redirects\`, 504 \`upstream_timeout\`.

## Limits, keys and pricing

- Free (no key): about ${CHECK_RATE.limit} \`/api/check\` requests and ${POST_RATE.limit} \`/api/generate\` + \`/api/validate\` requests (shared) per ${WINDOW_S} seconds per client IP (an IPv6 client counts per /64), counted per Cloudflare location. \`/api/crawlers\` has no per-client limit.
- RobotsGate Pro, $${PRO_PRICE_USD_MONTH}/mo via Polar: ${PRO_CHECK_RATE.limit} checks and ${PRO_POST_RATE.limit} generate/validate requests per ${PRO_CHECK_RATE.windowMs / 1000} seconds per license. Send \`Authorization: Bearer RBTG-…\` or \`X-License-Key: RBTG-…\`. A missing, invalid or expired key is not an error: the request just gets the free limits. [Subscribe](${PRO_CHECKOUT_URL})
- The MCP endpoint uses the same keys and the same counters: each \`check_site\` call counts as one \`/api/check\` request, and each \`generate_robots\` or \`validate_robots\` call counts against the shared generate/validate limit. \`list_crawlers\`, \`initialize\`, \`tools/list\` and other non-check messages don't use those counters, but have a light cap of about ${DISCOVERY_PER_MIN} per minute per IP (over it: HTTP 429 with \`Retry-After\`; for \`list_crawlers\`, a tool result with \`isError: true\`). Over an API limit, the tool result has \`isError: true\` with the reason and \`retryAfterSeconds\`.
- MCP request caps: ${fmt(MAX_BODY_BYTES)}-byte body, one \`tools/call\` per HTTP request, JSON-RPC batches (legacy versions only) of at most ${MAX_BATCH} messages.

## Guides

${GUIDES.map(([p, t]) => `- [${t}](${origin}${p})`).join('\n')}

## Optional

- [Homepage, generator, validator and site check](${origin}/)
- Contact: ${CONTACT_EMAIL}
`;
}

const errorSchema = { $ref: '#/components/schemas/Error' };
const errResp = (description, extraHeaders) => ({
  description,
  ...(extraHeaders ? { headers: extraHeaders } : {}),
  content: { 'application/json': { schema: errorSchema } },
});
const mcpNotAllowed = (m) => ({
  tags: ['mcp'],
  operationId: `mcp_${m}_not_allowed`,
  summary: 'Not supported (stateless server: no SSE stream, no sessions)',
  responses: {
    405: { description: 'Always 405 with `Allow: POST, OPTIONS` and a JSON-RPC error body', headers: { Allow: { schema: { type: 'string', const: 'POST, OPTIONS' } } }, content: { 'application/json': { schema: { type: 'object' } } } },
  },
});
const retryAfter = { 'Retry-After': { description: 'Seconds to wait before retrying', schema: { type: 'integer' } } };
const planHeaders = {
  'x-robotsgate-plan': { description: '`pro` when a valid RobotsGate Pro license was sent (absent on the free plan)', schema: { type: 'string', enum: ['pro'] } },
  'x-ratelimit-remaining': { description: 'Requests left in the current window. Only sent when the in-isolate limiter decided the request (Pro licenses, or if the Cloudflare rate-limit binding is unavailable); the normal free path does not send it.', schema: { type: 'integer' } },
};
const security = [{}, { bearerAuth: [] }, { licenseKeyHeader: [] }];
const jsonBody = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const postErrors = {
  400: errResp('`invalid_input` (see `details`) or `invalid_json`'),
  405: errResp('`method_not_allowed`: use POST'),
  413: errResp('`payload_too_large`: body over 1,000,000 bytes (or robots_txt over the limit)'),
  415: errResp('`unsupported_media_type`: Content-Type must be application/json'),
  429: errResp('`rate_limited`: the shared generate/validate limit', retryAfter),
  500: errResp('`internal_error`'),
};

export function openApiSpec(origin) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'RobotsGate API',
      version: VERSION,
      summary: 'Generate, validate and check robots.txt rules for AI crawlers.',
      description: `Free JSON API behind ${origin}. No key needed: about ${CHECK_RATE.limit} /api/check requests and ${POST_RATE.limit} /api/generate + /api/validate requests per ${WINDOW_S} s per client IP. RobotsGate Pro ($${PRO_PRICE_USD_MONTH}/mo, ${PRO_CHECKOUT_URL}) raises them to ${PRO_CHECK_RATE.limit} and ${PRO_POST_RATE.limit}; a missing or invalid key falls back to the free limits instead of failing. A 429 carries Retry-After. /api/check results are cached for ${CACHE_TTL_S / 60} minutes per target. robots.txt is voluntary and is not access control. AI agents can also use the remote MCP server at ${origin}/mcp (see /llms.txt). ${NOT_AFFILIATED}`,
      contact: { name: 'RobotsGate', email: CONTACT_EMAIL, url: origin },
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Human-readable API docs', url: `${origin}/docs` },
    tags: [{ name: 'robots' }, { name: 'meta' }, { name: 'mcp' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Optional RobotsGate Pro license key (prefix `RBTG`). Invalid keys fall back to the free plan.' },
        licenseKeyHeader: { type: 'apiKey', in: 'header', name: 'X-License-Key', description: 'Same license key as bearerAuth, alternative header.' },
      },
      schemas: {
        Error: {
          type: 'object', required: ['error'],
          properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } },
        },
        GenerateRequest: {
          type: 'object',
          properties: {
            categories: { type: 'object', properties: Object.fromEntries(CATEGORIES.map((c) => [c, { type: 'string', enum: ['allow', 'block', 'omit'] }])), additionalProperties: false },
            agents: { type: 'object', maxProperties: LIMITS.maxAgents, additionalProperties: { type: 'string', enum: ['allow', 'block', 'omit'] } },
            default: { type: 'string', enum: ['allow', 'block'] },
            disallow_paths: { type: 'array', maxItems: LIMITS.maxPaths, items: { type: 'string', maxLength: LIMITS.maxPathLen } },
            allow_paths: { type: 'array', maxItems: LIMITS.maxPaths, items: { type: 'string', maxLength: LIMITS.maxPathLen } },
            sitemaps: { type: 'array', maxItems: LIMITS.maxSitemaps, items: { type: 'string', maxLength: 2048 } },
            sitemap: { type: 'string', maxLength: 2048 },
            custom_rules: { type: 'string', maxLength: LIMITS.maxCustomBytes },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
        GenerateResult: {
          type: 'object', required: ['robots_txt', 'summary', 'notes', 'custom_rules_diagnostics', 'personal_agents_note'],
          properties: { robots_txt: { type: 'string' }, summary: { type: 'array', items: { type: 'object' } }, notes: { type: 'array', items: { type: 'string' } }, custom_rules_diagnostics: {}, personal_agents_note: { type: 'string' } },
        },
        ValidateRequest: {
          type: 'object', required: ['robots_txt'],
          properties: { robots_txt: { type: 'string', description: `Up to ${MAX_ROBOTS_BYTES} bytes (UTF-8)` }, path: { type: 'string', maxLength: 2048, pattern: '^/' } },
        },
        ValidateResult: {
          type: 'object', required: ['valid', 'errors', 'warnings', 'info', 'diagnostics', 'stats', 'path', 'ai_crawlers', 'personal_agents'],
          properties: {
            valid: { type: 'boolean' }, errors: { type: 'array', items: { type: 'object' } }, warnings: { type: 'array', items: { type: 'object' } },
            info: { type: 'array', items: { type: 'object' } }, diagnostics: { type: 'object' }, stats: { type: 'object' }, path: { type: 'string' },
            ai_crawlers: { type: 'array', items: { type: 'object' } }, personal_agents: { type: 'object' },
          },
        },
        CheckResult: {
          type: 'object', required: ['url', 'final_url', 'http_status', 'redirects', 'fetched_at', 'cache', 'robots_found', 'interpretation'],
          properties: {
            url: { type: 'string' }, final_url: { type: 'string' }, http_status: { type: 'integer' }, redirects: { type: 'integer' }, fetched_at: { type: 'string', format: 'date-time' },
            cache: { type: 'object', properties: { hit: { type: 'boolean' }, layer: { type: ['string', 'null'] }, ttl_seconds: { type: 'integer' } } },
            robots_found: { type: 'boolean' }, interpretation: { type: 'string', enum: ['parsed', 'unavailable', 'unreachable'] }, message: { type: 'string' }, path: { type: 'string' },
            ai_crawlers: { type: ['array', 'null'] }, personal_agents: { type: ['object', 'null'] },
          },
        },
        JsonRpcMessage: {
          type: 'object', required: ['jsonrpc'],
          properties: { jsonrpc: { const: '2.0' }, id: { type: ['string', 'integer'] }, method: { type: 'string' }, params: { type: 'object' } },
        },
      },
    },
    paths: {
      '/api': {
        get: {
          tags: ['meta'], operationId: 'apiIndex', summary: 'API name, version, endpoint list and Pro details', security: [{}],
          responses: { 200: { description: 'Index', content: { 'application/json': { schema: { type: 'object', required: ['name', 'version', 'endpoints'], properties: { name: { type: 'string' }, version: { type: 'string' }, endpoints: { type: 'array', items: { type: 'string' } }, note: { type: 'string' }, pro: { type: 'object' } } } } } } },
        },
      },
      '/api/health': {
        get: {
          tags: ['meta'], operationId: 'health', summary: 'Liveness and deployed version', security: [{}],
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', required: ['ok', 'version'], properties: { ok: { const: true }, version: { type: 'string', examples: [VERSION] } } } } } },
            405: errResp('`method_not_allowed`: use GET'),
          },
        },
      },
      '/api/crawlers': {
        get: {
          tags: ['robots'], operationId: 'listCrawlers', summary: 'The AI crawler registry', security: [{}],
          parameters: [{ name: 'category', in: 'query', required: false, schema: { type: 'string', enum: CATEGORIES } }],
          responses: {
            200: { description: 'Registry (cache-control: public, max-age=3600)', content: { 'application/json': { schema: { type: 'object', required: ['categories', 'crawlers'], properties: { schema_version: { type: 'integer' }, generated: { type: 'string' }, categories: { type: 'object' }, crawlers: { type: 'array', items: { type: 'object' } }, unverified: { type: 'array', items: { type: 'object' } } } } } } },
            405: errResp('`method_not_allowed`: use GET'),
          },
        },
      },
      '/api/generate': {
        post: {
          tags: ['robots'], operationId: 'generateRobots', summary: 'Generate a robots.txt for AI crawlers', security,
          requestBody: jsonBody({ $ref: '#/components/schemas/GenerateRequest' }),
          responses: { 200: { description: 'Generated file', headers: planHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/GenerateResult' } } } }, ...postErrors },
        },
      },
      '/api/validate': {
        post: {
          tags: ['robots'], operationId: 'validateRobots', summary: 'Validate robots.txt text and test one path for every registry AI crawler', security,
          requestBody: jsonBody({ $ref: '#/components/schemas/ValidateRequest' }),
          responses: {
            200: { description: 'Validation result', headers: planHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidateResult' } } } },
            ...postErrors,
            422: errResp('`too_complex`: the file needs more work than the per-request limit allows (`details.stage`)'),
          },
        },
      },
      '/api/check': {
        get: {
          tags: ['robots'], operationId: 'checkSite', summary: 'Fetch a site\'s /robots.txt and report which AI crawlers it allows', security,
          parameters: [
            { name: 'url', in: 'query', required: true, description: 'Site URL or bare hostname. http/https on default ports only; private, loopback and internal hosts are refused.', schema: { type: 'string', maxLength: 2048 }, example: 'example.com' },
            { name: 'path', in: 'query', required: false, description: 'URL path to test (default "/").', schema: { type: 'string', maxLength: 2048, pattern: '^/' } },
          ],
          responses: {
            200: {
              description: 'Check result (also for 4xx/5xx robots.txt responses: see `interpretation`)',
              headers: { 'x-robotsgate-cache': { description: '`MISS`, `HIT-memory` or `HIT-cache-api`', schema: { type: 'string', enum: ['MISS', 'HIT-memory', 'HIT-cache-api'] } }, ...planHeaders },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckResult' } } },
            },
            400: errResp('`url_not_allowed` (missing, invalid, non-http(s), credentials, non-default port, private or internal host) or `invalid_input` (bad path)'),
            405: errResp('`method_not_allowed`: use GET'),
            422: errResp('`too_complex`: the site\'s robots.txt needs more work than the per-request limit allows'),
            429: errResp('`rate_limited`', retryAfter),
            500: errResp('`internal_error`'),
            502: errResp('`dns_check_failed`, `upstream_error` or `too_many_redirects`'),
            504: errResp('`upstream_timeout`: robots.txt took longer than 8 s'),
          },
        },
      },
      '/mcp': {
        post: {
          tags: ['mcp'],
          operationId: 'mcp',
          summary: 'Remote MCP server (Streamable HTTP, JSON-RPC 2.0)',
          description: `Model Context Protocol endpoint. Stateless, JSON responses only (no SSE, no Mcp-Session-Id). Supported protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Modern (2026-07-28) requests carry params._meta and the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers; legacy clients use initialize. Tools: ${TOOLS.map((t) => t.name).join(', ')}. Same keys and limits as the JSON API (soft-fail: never 401). Body max ${MAX_BODY_BYTES} bytes; one tools/call per HTTP request; legacy batches max ${MAX_BATCH} messages.`,
          security,
          parameters: [
            { name: 'MCP-Protocol-Version', in: 'header', required: false, schema: { type: 'string', enum: SUPPORTED_VERSIONS } },
            { name: 'Mcp-Method', in: 'header', required: false, description: 'Required for 2026-07-28; must equal the body method', schema: { type: 'string' } },
            { name: 'Mcp-Name', in: 'header', required: false, description: 'Required for 2026-07-28 tools/call; must equal params.name', schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/JsonRpcMessage' }, { type: 'array', maxItems: MAX_BATCH, items: { $ref: '#/components/schemas/JsonRpcMessage' } }] } } },
          },
          responses: {
            200: { description: 'JSON-RPC response (or batch of responses). Tool failures, including input errors and rate limits, are results with isError: true (Retry-After set on rate limits).', headers: retryAfter, content: { 'application/json': { schema: { type: ['object', 'array'] } } } },
            202: { description: 'Notification(s) accepted; no body' },
            400: { description: 'Parse error (-32700), invalid request (-32600), header mismatch (-32020), unsupported protocol version (-32022) or missing _meta (-32602)', content: { 'application/json': { schema: { type: 'object' } } } },
            403: { description: 'Origin header present but not allowed', content: { 'application/json': { schema: { type: 'object' } } } },
            404: { description: 'Unknown method in a 2026-07-28 request (-32601)', content: { 'application/json': { schema: { type: 'object' } } } },
            413: { description: 'Body larger than the cap', content: { 'application/json': { schema: { type: 'object' } } } },
            429: { description: 'Too many non-check MCP messages from this IP', headers: retryAfter, content: { 'application/json': { schema: { type: 'object' } } } },
            500: errResp('Unexpected internal error (`internal_error`); per-message failures are JSON-RPC -32603 inside a 200 response instead'),
          },
        },
        get: mcpNotAllowed('get'),
        delete: mcpNotAllowed('delete'),
      },
    },
  };
}

/** Smithery static server card (recipe §13.2; SEP-1649 shape). serverInfo and tools are the same objects /mcp serves. */
export function serverCard(origin) {
  return {
    serverInfo: SERVER_INFO,
    description: `Generate and validate robots.txt rules for AI crawlers, check which AI bots a live site allows, and look up a sourced AI crawler registry. Free: ${CHECK_RATE.limit} checks and ${POST_RATE.limit} generate/validate calls per minute; Pro $${PRO_PRICE_USD_MONTH}/mo. ${NOT_AFFILIATED}`,
    homepage: `${origin}/`,
    contact: { email: CONTACT_EMAIL },
    transport: { type: 'streamable-http', endpoint: '/mcp', url: `${origin}/mcp` },
    protocolVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false, schemes: ['bearer'] },
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    resources: [],
    prompts: [],
  };
}
