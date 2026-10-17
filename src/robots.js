// robots.txt parsing, validation and matching (RFC 9309 semantics).
import registry from './crawlers-data.js';

export const MAX_ROBOTS_BYTES = 512000; // Google documents a 500 KiB processing limit.
const KNOWN_RULE_KEYS = new Set(['allow', 'disallow']);
const KNOWN_OTHER_KEYS = new Set(['sitemap', 'crawl-delay', 'host', 'clean-param']);
const KEY_TYPOS = {
  'useragent': 'user-agent', 'user agent': 'user-agent', 'user_agent': 'user-agent',
  'dissallow': 'disallow', 'disalow': 'disallow', 'dissalow': 'disallow', 'disallows': 'disallow',
  'allows': 'allow', 'site-map': 'sitemap', 'site map': 'sitemap', 'crawldelay': 'crawl-delay',
};
const TOKEN_RE = /^[A-Za-z_-]+$/; // RFC 9309 product-token charset
const LOOSE_TOKEN_RE = /^[A-Za-z0-9_.-]+$/;

const ASCII_ONLY = /^[\x00-\x7f]*$/;
export function byteLength(str) {
  // ASCII fast path avoids allocating a copy of large inputs (up to 512 KB) just to count bytes.
  if (ASCII_ONLY.test(str)) return str.length;
  return new TextEncoder().encode(str).length;
}

/**
 * Max entries kept in each diagnostics list (errors, warnings, info) per parse. Later
 * entries are counted (parsed.diagnostics) but not built or returned, so a file of junk
 * lines can't produce a multi-MB response.
 */
export const MAX_DIAGNOSTICS = 500;
/**
 * Max distinct User-agent tokens per parse that get the near-miss ("Did you mean ...?") check.
 * Later unknown tokens are still parsed and matched normally; they just get no typo suggestion,
 * and one info entry says how many were skipped.
 */
export const MAX_NEAR_MISS_CHECKS = 200;

/**
 * A file whose parse alone would exceed the budget stops early with TooComplexError (422), and
 * parse plus matching together can never exceed it.
 */
export const PARSE_UNITS = Object.freeze({ char: 0.5, line: 2, field: 29, group: 35, entry: 28 });
const PU_LINE = PARSE_UNITS.line;
const PU_FIELD = PARSE_UNITS.field;
const PU_GROUP = PARSE_UNITS.group;
const PU_ENTRY = PARSE_UNITS.entry;
const PARSE_FLUSH = 8192;

/**
 * Parse robots.txt text into groups, sitemaps and diagnostics.
 * Returns { groups:[{agents:[], rules:[{type,path,line}], crawlDelay, line}], sitemaps, errors, warnings, info,
 *           diagnostics: { truncated, limit, errors, warnings, info } (totals before the cap) }
 */
export function parseRobots(text, budget = UNLIMITED) {
  const errors = [];
  const warnings = [];
  const info = [];
  const groups = [];
  const sitemaps = [];
  if (typeof text !== 'string') text = '';
  // Each list keeps its first MAX_DIAGNOSTICS entries; E()/W()/I() count every diagnostic and
  // return false once the list is full, so the message string is never built.
  const total = { errors: 0, warnings: 0, info: 0 };
  const E = () => total.errors++ < MAX_DIAGNOSTICS;
  const W = () => total.warnings++ < MAX_DIAGNOSTICS;
  const I = () => total.info++ < MAX_DIAGNOSTICS;
  const near = { n: 0 }; // distinct tokens that reached the near-miss step (checked or skipped)

  const size = byteLength(text);
  if (size > MAX_ROBOTS_BYTES && W()) {
    warnings.push(msg(0, 'size', `File is ${size} bytes; Google only processes the first 500 KiB (${MAX_ROBOTS_BYTES} bytes).`));
  }
  if (text.charCodeAt(0) === 0xfeff) {
    if (I()) info.push(msg(1, 'bom', 'File starts with a UTF-8 byte order mark (BOM). Most parsers ignore it, but it is safer to remove it.'));
    text = text.slice(1);
  }
  if (text.trim() === '' && I()) {
    info.push(msg(0, 'empty', 'robots.txt is empty: no restrictions are expressed, so compliant crawlers may crawl everything.'));
  }

  // Lines are taken one at a time with indexOf (same lines as split('\n')): no array holding
  // every line alive, so short-lived line strings die young and GC stays cheap. CRLF and lone
  // CR end a line too (the same lines as replace(/\r\n?/g, '\n')), found with two cached
  // indexOf positions instead of building a CR-free copy of the text.
  const src = text;
  const srcLen = src.length;
  let pos = 0;
  let nextLf = -1;
  let nextCr = src.indexOf('\r') >= 0 ? -1 : srcLen; // srcLen: no CR anywhere
  let current = null; // current group
  let lastWasAgent = false;
  // Agent index used by selectRules: lower-cased agent -> { groups: [] (in file order), x (matcher cache) }.
  // Built here, in one pass with duplicate-agent detection. Duplicate-agent notes are collected
  // separately and appended to info after the loop, so info keeps its v0.2.1 order.
  const index = new Map();
  const otherSpellings = new Map(); // token-check memo for spellings other than an entry's first
  const dupInfo = [];
  let dupTotal = 0;
  // An exact repeat of the previous line, when that line was a clean rule in the same group,
  // cannot change any result (same pattern, same type; the first occurrence wins ties), so it
  // is counted but not stored again. This keeps repetitive 512 KB files cheap.
  let prevCleanRule = null;
  let duplicateRules = 0;
  let ruleCount = 0; // stored rules (stats.rules = ruleCount + duplicateRules)

  let work = Math.ceil(srcLen * PARSE_UNITS.char); // parse units not yet charged (charged every PARSE_FLUSH units and at the end)
  for (let lineNo = 1; pos <= srcLen; lineNo++) {
    if ((work += PU_LINE) >= PARSE_FLUSH) {
      budget.spend(work, 'parse');
      work = 0;
    }
    if (nextLf < pos) {
      nextLf = src.indexOf('\n', pos);
      if (nextLf < 0) nextLf = srcLen;
    }
    if (nextCr < pos) {
      nextCr = src.indexOf('\r', pos);
      if (nextCr < 0) nextCr = srcLen;
    }
    let nl = nextLf;
    let next = nl + 1;
    if (nextCr < nextLf) {
      nl = nextCr;
      next = nextLf === nl + 1 ? nl + 2 : nl + 1;
    }
    const raw = src.slice(pos, nl);
    pos = next;
    if (raw === prevCleanRule) {
      duplicateRules++;
      continue;
    }
    prevCleanRule = null;
    const hashAt = raw.indexOf('#');
    const content = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).trim();
    if (content === '') continue; // blank/comment lines don't break groups (RFC 9309)
    if (raw.length > 2000 && W()) warnings.push(msg(lineNo, 'long-line', 'Very long line (over 2000 characters).'));

    const colon = content.indexOf(':');
    if (colon >= 0) work += PU_FIELD;
    else {
      if (E()) errors.push(msg(lineNo, 'syntax', `Line is not a "field: value" pair: "${truncate(content)}"`));
      continue;
    }
    // Fast path for the common fields (no allocation); otherwise lower-case the key.
    const fast = fastKey(content);
    const rawKey = fast ? fast : content.slice(0, colon).trim();
    const key = fast ? fast : rawKey.toLowerCase();
    const value = content.slice(colon + 1).trim();

    if (KEY_TYPOS[key]) {
      if (W()) warnings.push(msg(lineNo, 'typo', `Unknown field "${rawKey}". Did you mean "${KEY_TYPOS[key]}"? Crawlers will ignore this line.`));
      continue;
    }

    if (key === 'user-agent') {
      if (value === '') {
        if (E()) errors.push(msg(lineNo, 'empty-agent', 'User-agent line has no value.'));
        continue;
      }
      if (!lastWasAgent || !current) {
        // m: matcher state, created only for groups a request evaluates (markUse); not output.
        // agents starts as an exact one-element array (a push onto [] reserves 17 slots
        current = { agents: [value], rules: [], crawlDelay: null, line: lineNo, m: null };
        work += PU_GROUP;
        groups.push(current);
      } else current.agents.push(value);
      const k = value === '*' ? value : value.toLowerCase();
      let e = index.get(k);
      if (e === undefined) {
        index.set(k, (e = newEntry(current, value, checkAgentToken(value, near, k))));
        work += PU_ENTRY;
      } else {
        const eg = e.groups;
        if (eg[0] !== current && dupTotal++ < MAX_DIAGNOSTICS) {
          dupInfo.push(msg(current.line, 'duplicate-agent', `"${value}" appears in more than one group; RFC 9309 crawlers combine the rules of all matching groups.`));
        }
        if (eg[eg.length - 1] !== current) eg.push(current);
      }
      // Token check, memoised per exact spelling (it lives on the case-folded index entry; other
      // spellings of the same token, e.g. "GPTbot" vs "gptbot", get their own memo slot).
      let w;
      if (e.chkFor === value) w = e.chk;
      else {
        w = otherSpellings.get(value);
        if (w === undefined) otherSpellings.set(value, (w = checkAgentToken(value, near)));
      }
      if (w && W()) warnings.push(msg(lineNo, w.code, w.message));
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;

    if (KNOWN_RULE_KEYS.has(key)) {
      if (!current) {
        if (E()) errors.push(msg(lineNo, 'rule-outside-group', `"${content.slice(0, colon).trim()}" appears before any User-agent line and will be ignored.`));
        continue;
      }
      if (value === '') {
        if (key === 'disallow') {
          if (I()) info.push(msg(lineNo, 'empty-disallow', 'Empty "Disallow:" means nothing is disallowed for this group.'));
        } else {
          if (W()) warnings.push(msg(lineNo, 'empty-allow', 'Empty "Allow:" has no effect.'));
        }
        ruleCount++;
        addRule(current, { type: key, path: '', line: lineNo });
        continue;
      }
      let clean = raw.length <= 2000;
      if (!value.startsWith('/') && !value.startsWith('*')) {
        if (W()) warnings.push(msg(lineNo, 'path-prefix', `Path "${truncate(value)}" should start with "/". Some crawlers will ignore it.`));
        clean = false;
      }
      if ((value.charCodeAt(0) | 0x20) === 0x68 && /^https?:\/\//i.test(value)) {
        if (E()) errors.push(msg(lineNo, 'absolute-url-rule', 'Allow/Disallow values must be paths (e.g. /private/), not full URLs.'));
        clean = false;
      }
      ruleCount++;
      addRule(current, { type: key, path: value, line: lineNo });
      if (clean) prevCleanRule = raw;
      continue;
    }

    if (key === 'sitemap') {
      if (!/^https?:\/\/[^\s]+$/i.test(value)) {
        if (E()) errors.push(msg(lineNo, 'sitemap-url', `Sitemap must be an absolute http(s) URL; got "${truncate(value)}".`));
      } else {
        sitemaps.push(value);
      }
      continue;
    }

    if (key === 'crawl-delay') {
      if (!current) {
        if (W()) warnings.push(msg(lineNo, 'rule-outside-group', 'Crawl-delay appears before any User-agent line.'));
      } else if (!/^\d+(\.\d+)?$/.test(value)) {
        if (W()) warnings.push(msg(lineNo, 'crawl-delay', `Crawl-delay should be a number of seconds; got "${truncate(value)}".`));
      } else {
        current.crawlDelay = Number(value);
        if (I()) info.push(msg(lineNo, 'crawl-delay-support', 'Crawl-delay is non-standard: some crawlers honor it (e.g. ClaudeBot), others ignore it (e.g. Google, Applebot, Amazonbot).'));
      }
      continue;
    }

    if (KNOWN_OTHER_KEYS.has(key)) {
      if (I()) info.push(msg(lineNo, 'nonstandard', `"${rawKey}" is a non-standard field supported only by some crawlers.`));
      continue;
    }
    if (key === 'noindex' || key === 'nofollow') {
      if (W()) warnings.push(msg(lineNo, 'unsupported', `"${rawKey}" is not supported in robots.txt by major crawlers. Use a robots meta tag or X-Robots-Tag header instead.`));
      continue;
    }
    if (W()) warnings.push(msg(lineNo, 'unknown-field', `Unknown field "${truncate(rawKey)}" will be ignored by most crawlers.`));
  }

  budget.spend(work, 'parse');

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.rules.length === 0 && g.crawlDelay === null && W()) {
      warnings.push(msg(g.line, 'empty-group', `Group for ${agentList(g.agents)} has no Allow/Disallow rules, so it allows everything for those agents (and they will not use the "*" group).`));
    }
  }

  // Duplicate agent groups (RFC 9309: crawlers combine them, but it is easy to get wrong).
  for (let i = 0; i < dupInfo.length; i++) if (I()) info.push(dupInfo[i]);
  total.info += dupTotal - dupInfo.length; // notes beyond the cap were counted but not built

  const skipped = near.n - MAX_NEAR_MISS_CHECKS;
  if (skipped > 0 && I()) {
    info.push(msg(0, 'agent-typo-limit', `Typo suggestions were checked for the first ${MAX_NEAR_MISS_CHECKS} distinct unrecognised User-agent tokens only; ${skipped} more were not checked.`));
  }

  const diagnostics = {
    truncated: total.errors > errors.length || total.warnings > warnings.length || total.info > info.length,
    limit: MAX_DIAGNOSTICS,
    errors: total.errors,
    warnings: total.warnings,
    info: total.info,
  };
  const parsed = { groups, sitemaps, errors, warnings, info, diagnostics, size, duplicateRules, ruleCount };
  Object.defineProperty(parsed, '_index', { value: index, enumerable: false });
  return parsed;
}

/** Append a rule; a group's first rule gets an exact one-element array (see agents above). */
function addRule(g, r) {
  if (g.rules.length === 0) g.rules = [r];
  else g.rules.push(r);
}

/** Agent-index entry: groups in file order, matcher cache x (built on first evaluation) and the token-check memo for the first spelling. */
function newEntry(g, value, chk) {
  return { groups: [g], x: null, chkFor: value, chk };
}

/** Returns 'allow' | 'disallow' | 'user-agent' if content[0..colon) is that key (any case, optional trailing spaces). */
// One native regex test per line (v0.2.2): a JS character loop here was a large share of cold
// (not yet JIT-compiled) parse time on 512 KB files.
const ALLOW_RE = /^allow[ \t]*:/i;
const DISALLOW_RE = /^disallow[ \t]*:/i;
const USER_AGENT_RE = /^user-agent[ \t]*:/i;
function fastKey(content) {
  switch (content.charCodeAt(0) | 0x20) {
    case 0x61: return ALLOW_RE.test(content) ? 'allow' : null;
    case 0x64: return DISALLOW_RE.test(content) ? 'disallow' : null;
    case 0x75: return USER_AGENT_RE.test(content) ? 'user-agent' : null;
    default: return null;
  }
}

// Registry names pre-normalised once at module load: lower-cased for the exact check,
// letters-only for the near-miss check, kept in registry order so the first near miss wins.
const REGISTRY_LOWER = new Set(registry.crawlers.map((c) => c.name.toLowerCase()));
const lettersOnly = (x) => x.toLowerCase().replace(/[^a-z]/g, '');
const REGISTRY_NEAR = registry.crawlers.map((c) => ({ name: c.name, norm: lettersOnly(c.name) }));
// The short lists keep the 200 checks too cheap for the JIT to bother compiling them.
const NEAR_BY_LEN = [];
for (const r of REGISTRY_NEAR) {
  for (let len = Math.max(1, r.norm.length - 1); len <= r.norm.length + 1; len++) (NEAR_BY_LEN[len] ||= []).push(r);
}

/**
 * near: per-parse counter { n }. Each distinct token that reaches the near-miss step counts once;
 * only the first MAX_NEAR_MISS_CHECKS get the comparison (one always-executed counter, so the
 * JIT-compiled code doesn't bail out when the cap is reached).
 */
function checkAgentToken(value, near = { n: 0 }, lower = value.toLowerCase()) {
  if (value === '*') return null;
  if (value.includes('/')) {
    return { code: 'agent-version', message: `User-agent "${truncate(value)}" includes a version or URL. Use just the product token (e.g. "GPTBot").` };
  }
  if (!LOOSE_TOKEN_RE.test(value)) {
    return { code: 'agent-token', message: `User-agent "${truncate(value)}" contains characters not allowed in a product token; it may never match.` };
  }
  if (!TOKEN_RE.test(value)) {
    // digits/dots: tolerated by many parsers, but outside RFC 9309 charset
    return null;
  }
  if (REGISTRY_LOWER.has(lower)) return null;
  if (near.n++ >= MAX_NEAR_MISS_CHECKS) return null;
  // value is letters, "_" and "-" only here, so its letters-only form is lower minus "_"/"-".
  const hit = nearMiss(lower.indexOf('-') < 0 && lower.indexOf('_') < 0 ? lower : lettersOnly(value));
  if (hit) return { code: 'agent-typo', message: `User-agent "${value}" is not a documented AI crawler token. Did you mean "${hit.name}"?` };
  return null;
}

/**
 * First registry crawler (in registry order) whose letters-only name equals v or, for v of 6+
 * letters, is one edit away. Only names whose length is within 1 of v's are candidates
 * (NEAR_BY_LEN).
 */
function nearMiss(v) {
  const list = NEAR_BY_LEN[v.length];
  if (list === undefined) return null;
  const allowEdit = v.length >= 6;
  for (let i = 0; i < list.length; i++) {
    const n = list[i].norm;
    if (n === v || (allowEdit && withinOneEdit(n, v))) return list[i];
  }
  return null;
}

/** True if a and b are at most one insertion, deletion or substitution apart. O(length). */
export function withinOneEdit(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  const m = a.length;
  const n = b.length;
  if (n - m > 1) return false;
  let i = 0;
  while (i < m && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i === m) return true; // equal, or b has one extra char at the end
  if (m === n) {
    // one substitution at i: the rest must be equal
    for (let k = i + 1; k < m; k++) if (a.charCodeAt(k) !== b.charCodeAt(k)) return false;
    return true;
  }
  // one insertion in b at i
  for (let k = i; k < m; k++) if (a.charCodeAt(k) !== b.charCodeAt(k + 1)) return false;
  return true;
}

function msg(line, code, message) {
  return { line, code, message };
}

function truncate(s, n = 80) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Max agents named in an empty-group warning. */
export const MAX_LISTED_AGENTS = 10;
/** '"a, b, c"', or the first MAX_LISTED_AGENTS (each cut to 80 chars) and "and N more". */
function agentList(agents) {
  if (agents.length <= MAX_LISTED_AGENTS && agents.every((a) => a.length <= 80)) return `"${agents.join(', ')}"`;
  const shown = agents.slice(0, MAX_LISTED_AGENTS).map((a) => truncate(a)).join(', ');
  const more = agents.length - MAX_LISTED_AGENTS;
  return more > 0 ? `"${shown}" and ${more} more` : `"${shown}"`;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// ---------- matching ----------
// Performance/safety design:
// - No RegExp is built from user patterns (v0.1.1's regex approach backtracked badly).
// - Literal segments between "*" are found with KMP search, which is linear in the path
//   length even on repetitive text such as "aaaa...". (String#indexOf can degrade to
//   O(path x segment) on that kind of input.)
// - Each parsed group is evaluated once per path. The per-crawler result combines the group
//   winners (longest pattern wins, Allow wins ties), so a group naming all 27 crawlers is
//   evaluated once, not 27 times.
// - Consecutive identical patterns share one compiled pattern, and its match result is
//   memoised per path (repetitive files cost one scan, not thousands).
// - Each request gets a matching work budget (characters scanned plus rules visited). If it
//   is exceeded, matching stops with TooComplexError, which the API returns as 422 too_complex.
// v0.2.2:
// - The requested path is normalised once per request (natively) and its normalised length is
//   charged. Every group visit costs 1 unit. Crawlers that select the same agent entry share one
//   evaluation (1 unit per shared hit).
// - Groups that belong to a single agent entry are evaluated as one merged rule list; only groups
//   shared between entries are evaluated (and memoised) per group. beats() breaks full ties by
//   line, so the result equals the merged-list result (and v0.2.1's) exactly.
// "$"-anchored wildcard rules also get a literal-suffix reject before compiling. v0.2.3: the budget covers ALL per-request work, not just
// matching.
// - Parsing is charged per character, line, field, group and agent entry (PARSE_UNITS), and
//   preparing a rule list per rule (LIST_UNITS) and per non-plain rule (LAZY_UNITS / PL_UNITS),
//   and the per-request group state (MARK_UNITS per evaluated entry and group).
// - Compiling a pattern is charged (COMPILE_UNITS + length/8), and so is the normalised-prefix
//   check that runs before it (1 + chars/8). v0.2.2 did not charge either, so ~27k rules with
//   Charging (not skipping) keeps every result identical to v0.2.2 whenever the work fits.
// - Weights come from a least-squares fit of cold-process CPU against event counts over the
//   ~4 ms fixed, so the 1.6M-unit limit corresponds to roughly 45-60 ms (bench/calibrate.mjs). Worker CPU time can't be read mid-request,
//   so a deterministic budget is the only portable limit; it also makes 422s reproducible.
// A 422 therefore always lands near the limit's time-equivalent, never later. v0.2.4: rule-path normalisation is charged as it runs, not
// after it.
// - normalizePath makes lone surrogates well-formed first (toWellFormed, so encodeURIComponent
//   cannot throw and the per-character fallback is gone) and rewrites %xx escapes with an indexOf
//   loop instead of a regex callback; output is identical to v0.2.3 (test/m4.test.js).
// - Rule compiling charges COMPILE_UNITS + length/8 BEFORE compiling, and normalising charges
//   PCT_UNITS per %xx escape rewritten and RUN_UNITS per run of non-visible characters (~6-10 units
//   of measured cost each, so 20 leaves a 2-3x margin), in batches, so a 512 KB rule of escapes or
//   lone surrogates stops with 422 in ~15-40 ms instead of costing 100-570 ms.
// - A first-character indexOf miss in kmpFind is charged n/8 + 1 (INDEXOF_SHIFT), not a full
//   scan: one native indexOf over 2,048 characters costs ~0.1 us cold, far under 257 units.
// - MATCH_BUDGET re-checked with bench/calibrate.mjs over all 122 inputs; it stays 1.6M.

/** Max work per request, in units of ~25 ns cold CPU (parse + list prep + compile + path chars + rule/group visits). See QC_PACKET sections 9-12. */
export const MATCH_BUDGET = 1_600_000;

/**
 * Budget stages: the 422 says which stage ran out. parse = reading lines, groups and user-agents;
 * normalize = percent-encoding / unescaping rule and path text; compile = preparing rule lists and
 * compiling wildcard patterns; match = checking rules against the path.
 */
const STAGE_TEXT = {
  parse: 'parsing the file (too many lines, groups or user-agents)',
  normalize: 'normalising rule paths (too many %-escapes or non-ASCII characters)',
  compile: 'preparing rules (too many wildcard, %-escaped or non-ASCII rules)',
  match: 'matching rules against the path (too many wildcard rules for this path)',
};
const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export class TooComplexError extends Error {
  /** stage: parse | normalize | compile | match; limit: the budget in work units. */
  constructor(stage = 'match', limit = MATCH_BUDGET, forSite = false) {
    const why = `ran out while ${STAGE_TEXT[stage] || stage}; limit ${fmtInt(limit)} work units, about 50 ms of CPU`;
    // on /api/check, only the match stage depends on the path, so only that message suggests
    // checking a shorter path.
    const hint = stage === 'match' ? ' Checking a shorter path (the path parameter) may fit within the limit.' : '';
    super(forSite
      ? `The site's robots.txt is too large or complex for RobotsGate to analyse (${why}). This is a limit of this checker, not necessarily a problem with the file: Google reads robots.txt files up to 500 KiB.${hint}`
      : `This robots.txt needs more work than RobotsGate's per-request limit allows (${why}). Try a smaller file, fewer wildcard rules or a shorter path.`);
    this.name = 'TooComplexError';
    this.stage = stage;
    this.limit = limit;
    this.details = { stage, limit };
  }
  /** The same error, worded for /api/check (the file is the site's own robots.txt). */
  forSite() {
    return new TooComplexError(this.stage, this.limit, true);
  }
}

export class MatchBudget {
  constructor(limit = MATCH_BUDGET) {
    this.limit = limit;
    this.left = limit;
  }
  spend(n, stage = 'match') {
    this.left -= n;
    if (this.left < 0) throw new TooComplexError(stage, this.limit);
  }
  get used() {
    return this.limit - this.left;
  }
}
const UNLIMITED = { spend() {} };

// Visible ASCII except "%": nothing to normalise.
const PLAIN = /^[\x21-\x24\x26-\x7e]*$/;
const HEX = '0123456789ABCDEF';
function isUnreserved(c) {
  // RFC 3986 unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~"
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e || c === 0x5f || c === 0x7e;
}
function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

const NON_VISIBLE = /[^\x21-\x7e]/;
const NON_VISIBLE_RUNS = /[^\x21-\x7e]+/g;
/** Normalised form of a %XX escape of byte b: the character if unreserved, else upper-case hex. */
const ESC_OUT = Array.from({ length: 256 }, (_, b) => (isUnreserved(b) ? String.fromCharCode(b) : '%' + HEX[b >> 4] + HEX[b & 15]));

/**
 * Budget units charged per %XX escape and per run of non-visible characters normalised in a rule.
 * Measured cold: ~150 ns per rewritten escape and ~260-290 ns per run (one encodeURIComponent call
 * each), i.e. ~6 and ~10 units; 20 leaves a 2-3x margin. Charged in batches of NORM_BATCH while
 * normalising, so at most one batch of work runs uncharged.
 */
export const PCT_UNITS = 20;
export const RUN_UNITS = 20;
/**
 * units charged per "%" that does not start a valid %XX escape and is skipped ("%", "%%", "%G1",
 * "%4" at the end). Each skip is one indexOf step plus two charCodeAt reads, ~1 unit of measured
 * cost; v0.2.4 charged nothing, so 512 KB of "%" ran ~15-28 ms uncharged.
 */
export const BAD_PCT_UNITS = 1;
const NORM_BATCH = 256;

/**
 * Rewrites %XX escapes (same matches as /%([0-9A-Fa-f])([0-9A-Fa-f])/g, left to right): unreserved
 * bytes are decoded, others upper-cased. Escapes that are already normalised (reserved byte,
 * upper-case hex) are left in place without copying. Charges PCT_UNITS per escape to budget, and
 * BAD_PCT_UNITS per "%" that is skipped because no valid escape follows it.
 */
function fixEscapes(p, budget) {
  const n = p.length;
  let i = p.indexOf('%');
  let out = '';
  let last = 0;
  let k = 0;
  let bad = 0;
  while (i >= 0 && i + 2 < n) {
    const c1 = p.charCodeAt(i + 1);
    const c2 = p.charCodeAt(i + 2);
    const h = hexVal(c1);
    const l = hexVal(c2);
    if (h < 0 || l < 0) {
      if (++bad === NORM_BATCH) {
        budget.spend(NORM_BATCH * BAD_PCT_UNITS, 'normalize');
        bad = 0;
      }
      i = p.indexOf('%', i + 1);
      continue;
    }
    if (++k === NORM_BATCH) {
      budget.spend(NORM_BATCH * PCT_UNITS, 'normalize');
      k = 0;
    }
    const b = h * 16 + l;
    if (c1 <= 0x46 && c2 <= 0x46 && !isUnreserved(b)) {
      i = p.indexOf('%', i + 3); // already "%XY" with upper-case hex
      continue;
    }
    out += p.slice(last, i) + ESC_OUT[b];
    last = i + 3;
    i = p.indexOf('%', last);
  }
  budget.spend(k * PCT_UNITS + bad * BAD_PCT_UNITS, 'normalize');
  return last === 0 ? p : out + p.slice(last);
}

/**
 * Normalise a path or pattern for comparison (RFC 9309 section 2.2.2):
 * - characters outside visible ASCII are percent-encoded as UTF-8 octets (upper-case hex);
 * - %XX escapes of unreserved characters (ALPHA / DIGIT / - . _ ~) are decoded;
 * - all other %XX escapes are kept, with upper-cased hex (so %2f and %2F compare equal, and
 *   %2F never matches a literal "/").
 * "*" and "$" are left alone. Two passes: escapes in the input first (an indexOf loop since v0.2.4;
 * v0.2.2-v0.2.3 used a regex replace with a callback per escape), then runs of non-visible
 * characters (encodeURIComponent per run). The second pass only touches characters the first pass
 * never produces, so this equals a single left-to-right pass (test/m2.test.js checks it against
 * the v0.2.1 implementation, test/m4.test.js against v0.2.3). With a budget (rule compiling), each
 * escape and each non-visible run is charged (PCT_UNITS / RUN_UNITS) as it is processed.
 */
export function normalizePath(p, budget = UNLIMITED) {
  if (PLAIN.test(p)) return p;
  // lone surrogates become U+FFFD up front (what the old per-code-point fallback produced), so
  // encodeURIComponent never throws and no per-character fallback is needed.
  if (!p.isWellFormed()) p = p.toWellFormed();
  const out = p.indexOf('%') >= 0 ? fixEscapes(p, budget) : p;
  if (!NON_VISIBLE.test(out)) return out;
  if (budget === UNLIMITED) return out.replace(NON_VISIBLE_RUNS, encodeURIComponent);
  let k = 0;
  const res = out.replace(NON_VISIBLE_RUNS, (run) => {
    if (++k === NORM_BATCH) {
      budget.spend(NORM_BATCH * RUN_UNITS, 'normalize');
      k = 0;
    }
    return encodeURIComponent(run);
  });
  budget.spend(k * RUN_UNITS, 'normalize');
  return res;
}

const HEX_CODES = Array.from(HEX, (ch) => ch.charCodeAt(0));
const UTF8_LEAD = [0, 0xc0, 0xe0, 0xf0];
/** True if p continues with "%XY" for byte b (upper-case hex) at j. */
function pctAt(p, j, b) {
  return j + 2 < p.length && p.charCodeAt(j) === 0x25 && p.charCodeAt(j + 1) === HEX_CODES[b >> 4] && p.charCodeAt(j + 2) === HEX_CODES[b & 15];
}

/**
 * raw.slice(0, end) is the pattern's first segment (up to the first "*", or without a trailing
 * "$"); a pattern can only match if it is a prefix of p (globMatch checks that first), so false
 * means "no match" without compiling. Charged 1 unit plus 1 per 8 normalised characters compared.
 */
export function normPrefixOk(raw, end, p, budget = UNLIMITED) {
  const r = normPrefixLen(raw, end, p);
  budget.spend(1 + ((r < 0 ? ~r : r) >> 3), 'normalize');
  return r >= 0;
}

/**
 * Normalises raw.slice(0, end) on the fly with normalizePath's rules (escape fix-up, UTF-8
 * percent-encoding outside visible ASCII, U+FFFD for lone surrogates; nothing crosses a "*" or
 * "$") while comparing it with p, without allocating. Returns the normalised length if it is a
 * prefix of p, else ~(characters matched before the mismatch).
 */
function normPrefixLen(raw, end, p) {
  const pl = p.length;
  let j = 0;
  for (let i = 0; i < end; ) {
    const c = raw.charCodeAt(i);
    if (c === 0x25 && i + 2 < end) {
      const h = hexVal(raw.charCodeAt(i + 1));
      const l = hexVal(raw.charCodeAt(i + 2));
      if (h >= 0 && l >= 0) {
        const b = h * 16 + l;
        if (isUnreserved(b)) {
          if (j >= pl || p.charCodeAt(j) !== b) return ~j;
          j++;
        } else {
          if (!pctAt(p, j, b)) return ~j;
          j += 3;
        }
        i += 3;
        continue;
      }
    }
    i++;
    if (c >= 0x21 && c <= 0x7e) {
      if (j >= pl || p.charCodeAt(j) !== c) return ~j;
      j++;
      continue;
    }
    // Outside visible ASCII: the UTF-8 octets of the code point, each as %XY.
    let cp = c;
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = c <= 0xdbff && i < end ? raw.charCodeAt(i) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else cp = 0xfffd;
    }
    let n = cp < 0x80 ? 0 : cp < 0x800 ? 1 : cp < 0x10000 ? 2 : 3; // continuation octets
    if (!pctAt(p, j, UTF8_LEAD[n] | (cp >> (6 * n)))) return ~j;
    j += 3;
    while (n-- > 0) {
      if (!pctAt(p, j, 0x80 | ((cp >> (6 * n)) & 63))) return ~j;
      j += 3;
    }
  }
  return j;
}

/** Compile a pattern string: { len (normalised length), anchored, parts (split at runs of "*"), mp/mr (per-path memo) } */
function compilePattern(raw, head = '', from = 0, budget = UNLIMITED) {
  // head = the already-normalised raw.slice(0, from) (from = the first "*" or a trailing "$"):
  // normalising never crosses those characters, so this equals normalizePath(raw).
  const norm = from === 0 ? normalizePath(raw, budget) : head + normalizePath(raw.slice(from), budget);
  let body = norm;
  let anchored = false;
  if (body.endsWith('$')) {
    anchored = true;
    body = body.slice(0, -1);
  }
  // A run of "*" matches exactly what one "*" matches; collapsing runs keeps a 512 KB "/****..."
  // pattern from becoming a 512k-element parts array. len stays the full pattern length.
  if (body.indexOf('**') >= 0) body = body.replace(/\*\*+/g, '*');
  const parts = body.split('*');
  return { len: norm.length, anchored, parts, mp: null, mr: false };
}

/** A normalised path being matched. */
function pathCtx(p) {
  return { s: p };
}

/**
 * A native indexOf over the path is charged 1 unit per 2^INDEXOF_SHIFT characters scanned (v0.2.4).
 * Measured cold: a 2,048-character miss costs ~0.1-0.2 us, about 4-8 units; 1/8 charges 256.
 */
export const INDEXOF_SHIFT = 3;

// Scratch failure table shared by all kmpFind calls (matching is synchronous). v0.2.3: building
// per-pattern code/failure typed arrays was most of the garbage on wildcard-heavy files.
let KMP_F = new Int32Array(64);

/**
 * KMP search for segment seg in the path, starting at from; the match must end at or before end.
 * Linear in (end - from) + seg.length; charges the characters scanned. The failure table is only
 * built once a candidate first character is found with room for a match.
 */
function kmpFind(seg, ctx, from, end, budget) {
  const m = seg.length;
  const s = ctx.s;
  if (m === 1) {
    // Single character: one native indexOf, charged at INDEXOF_SHIFT.
    const idx = s.indexOf(seg, from);
    const found = idx >= 0 && idx < end;
    budget.spend((((found ? idx + 1 : end) - from) >> INDEXOF_SHIFT) + 1);
    return found ? idx : -1;
  }
  const c0 = seg[0];
  let i = s.indexOf(c0, from);
  if (i < 0 || i + m > end) {
    // First character absent (or too late): only the native indexOf ran. v0.2.3 charged this as
    // a full scan (1 unit per character), so only 734 "/*?x" rules fit a 2,048-character path.
    budget.spend(((end - from) >> INDEXOF_SHIFT) + 1);
    return -1;
  }
  if (KMP_F.length < m) KMP_F = new Int32Array(Math.max(m, KMP_F.length * 2));
  const f = KMP_F;
  f[0] = 0;
  for (let q = 1, k = 0; q < m; q++) {
    const ch = seg.charCodeAt(q);
    while (k > 0 && ch !== seg.charCodeAt(k)) k = f[k - 1];
    if (ch === seg.charCodeAt(k)) k++;
    f[q] = k;
  }
  let k = 0;
  while (i < end) {
    if (k === 0) {
      // Skip to the next occurrence of the first character natively (fast on typical text).
      const j = s.indexOf(c0, i);
      if (j < 0 || j >= end) break;
      i = j;
    }
    const ch = s.charCodeAt(i);
    while (k > 0 && ch !== seg.charCodeAt(k)) k = f[k - 1];
    if (ch === seg.charCodeAt(k)) {
      k++;
      if (k === m) {
        budget.spend(i + 1 - from);
        return i + 1 - m;
      }
    }
    i++;
  }
  budget.spend(end - from + 1);
  return -1;
}

/** Glob match of a compiled pattern against a normalised path. Linear in path + pattern length. */
function globMatch(c, ctx, budget) {
  const s = ctx.s;
  const parts = c.parts;
  const first = parts[0];
  if (!s.startsWith(first)) return false;
  const lastIdx = parts.length - 1;
  if (lastIdx === 0) return c.anchored ? s.length === first.length : true;
  let pos = first.length;
  const last = parts[lastIdx];
  let end = s.length;
  if (c.anchored) {
    end = s.length - last.length;
    if (end < pos || !s.endsWith(last)) return false;
  }
  for (let i = 1; i < lastIdx; i++) {
    const seg = parts[i];
    if (seg === '') continue;
    const idx = kmpFind(seg, ctx, pos, end, budget);
    if (idx < 0) return false;
    pos = idx + seg.length; // leftmost placement leaves the most room for later segments
  }
  if (c.anchored || last === '') return true;
  return kmpFind(last, ctx, pos, s.length, budget) >= 0;
}

function matchCompiled(c, ctx, budget) {
  if (c.mp === ctx.s) return c.mr; // identical pattern already tried against this path
  const r = globMatch(c, ctx, budget);
  c.mp = ctx.s;
  c.mr = r;
  return r;
}

/** RFC 9309 pattern match with * and $ support. */
export function patternMatches(pattern, path) {
  return globMatch(compilePattern(pattern), pathCtx(normalizePath(path)), UNLIMITED);
}

function prepPath(path) {
  if (!path.startsWith('/')) path = '/' + path;
  return path;
}

/**
 * A request path prepared once per request: { path (with leading "/"), robotsTxt, ctx (normalised
 * path + lazy code units) }. Normalising is charged to the budget (its normalised length).
 */
function preparePath(path, budget) {
  path = prepPath(path);
  if (path === '/robots.txt') return { path, robotsTxt: true, ctx: null };
  const p = normalizePath(path);
  budget.spend(p.length, 'normalize');
  return { path, robotsTxt: false, ctx: pathCtx(p) };
}

// Visible ASCII without "$", "%" or "*": the pattern is a plain prefix and needs no compiling.
const PLAIN_PREFIX = /^[\x21-\x23\x26-\x29\x2b-\x7e]+$/;
const NON_PLAIN = /[^\x21-\x23\x26-\x29\x2b-\x7e]/;

/**
 * Prepare a rule list. Entries are:
 * - null: empty pattern (matches nothing);
 * - a string: plain prefix pattern (match = startsWith, length = string length), or, when
 *   out.pl[i] === 1, a pattern without "*" or trailing "$" that needs normalising (match and
 *   length from normPrefixLen; never compiled);
 * - a lazy entry { pre, suf, nf, raw, c }: pre is a plain literal prefix every match must start
 *   with, suf a plain literal suffix every match of a "$"-anchored wildcard pattern must end with,
 *   nf > 0 the length of a first segment that is not plain (checked with normPrefixOk instead of
 *   pre). They let most rules be rejected without compiling; c is compiled on first use, and
 *   compiling is charged to the budget (COMPILE_UNITS plus 1 per 8 normalised characters).
 */
function compileList(rules, budget) {
  budget.spend(rules.length * LIST_UNITS, 'compile');
  const out = new Array(rules.length);
  // Indices of the rules that can match "/" at all: only a pattern whose first segment is ""
  // or "/" can (it starts with "*", or is "/", "/*..." or "/$..."). The "/" pass of a request
  // (root_blocked) visits only these.
  const root = [];
  let lazy = 0;
  let npl = 0;
  let pl = null; // pl[i] === 1: out[i] is a string that needs normalising (see below)
  for (let i = 0; i < rules.length; i++) {
    const path = rules[i].path;
    if (path === '') {
      out[i] = null;
      continue;
    }
    const c0 = path.charCodeAt(0);
    if (c0 === 0x2a || (c0 === 0x2f && (path.length === 1 || path.charCodeAt(1) === 0x2a || path.charCodeAt(1) === 0x24))) root.push(i);
    const k = path.search(NON_PLAIN); // first character that is not plain, or -1
    if (k < 0) out[i] = path;
    // Consecutive duplicate patterns share one entry (and so its per-path memo).
    else if (i > 0 && path === rules[i - 1].path) {
      out[i] = out[i - 1];
      if (pl !== null) pl[i] = pl[i - 1];
    } else {
      const star = path.indexOf('*');
      const segEnd = star >= 0 ? star : path.charCodeAt(path.length - 1) === 0x24 ? path.length - 1 : path.length;
      if (segEnd === path.length) {
        // No "*" and no trailing "$" (e.g. non-ASCII, "%XX", spaces or controls): the whole
        // pattern is one segment, so normPrefixLen alone decides the match and gives its length.
        // Kept as a string flagged in pl; never compiled.
        if (pl === null) pl = new Uint8Array(rules.length);
        pl[i] = 1;
        out[i] = path;
        npl++;
        continue;
      }
      // First segment plain (no non-plain character before segEnd): use it as a literal prefix.
      const pre = k >= segEnd ? path.slice(0, segEnd) : '';
      const nf = pre === '' ? segEnd : 0;
      let suf = '';
      if (star >= 0 && path.charCodeAt(path.length - 1) === 0x24) {
        suf = path.slice(path.lastIndexOf('*') + 1, -1);
        if (!PLAIN_PREFIX.test(suf)) suf = '';
      }
      out[i] = { pre, suf, nf, raw: path, c: null };
      lazy++;
    }
  }
  out.root = root;
  out.pl = pl;
  budget.spend(lazy * LAZY_UNITS + npl * PL_UNITS, 'compile');
  return out;
}

/** Budget units charged per pattern compiled (plus 1 per 8 normalised characters); see MATCH_BUDGET. */
export const COMPILE_UNITS = 40;
/** Budget units charged per rule when a rule list is prepared for matching (compileList). */
export const LIST_UNITS = 6;
/** Extra budget units per rule that needs a lazy (wildcard / "$", non-plain) entry when its list is prepared. */
export const LAZY_UNITS = 35;
/** Extra budget units per rule without "*" or a trailing "$" that still needs normalising (non-ASCII, "%XX", ...). */
export const PL_UNITS = 4;

/** Longest-match evaluation over one rule list (no /robots.txt special case). */
function evalRules(rules, cc, ctx, budget) {
  const p = ctx.s;
  let best = null;
  let bestLen = -1;
  const idx = p === '/' ? cc.root : null; // "/": only rules that can match it (compileList)
  const pl = cc.pl;
  const n = idx === null ? rules.length : idx.length;
  let visits = 0; // 1 unit per rule visited, charged in batches (same total)
  for (let t = 0; t < n; t++) {
    if (++visits === 256) {
      budget.spend(256);
      visits = 0;
    }
    const i = idx === null ? t : idx[t];
    const c = cc[i];
    if (c === null) continue; // empty pattern
    const r = rules[i];
    let len;
    if (pl !== null && pl[i] === 1) {
      const m = normPrefixLen(c, c.length, p); // normalised length if a prefix of p, else ~matched
      budget.spend(1 + ((m < 0 ? ~m : m) >> 3), 'normalize');
      if (m < 0) continue;
      len = m;
      if (len < bestLen || (len === bestLen && (r.type !== 'allow' || best.type === 'allow'))) continue;
    } else if (typeof c === 'string') {
      len = c.length;
      if (len < bestLen || (len === bestLen && (r.type !== 'allow' || best.type === 'allow'))) continue;
      if (!p.startsWith(c)) continue;
    } else {
      if (c.pre !== '' && !p.startsWith(c.pre)) continue; // cheap rejects before compiling
      if (c.suf !== '' && !p.endsWith(c.suf)) continue;
      if (c.c === null) {
        let head = '';
        if (c.nf > 0) {
          // Non-plain first segment: check it normalised on the fly; if it is a prefix of p, that
          // prefix of p IS its normalised form, so compiling only normalises the rest.
          const m = normPrefixLen(c.raw, c.nf, p);
          budget.spend(1 + ((m < 0 ? ~m : m) >> 3), 'normalize');
          if (m < 0) continue;
          head = p.slice(0, m);
        }
        // charged BEFORE compiling (COMPILE_UNITS + 1 per 8 raw characters); normalizePath charges
        // each %XX escape and non-visible run as it goes, and any growth of the normalised pattern
        // over the raw length is charged after (native encodeURIComponent).
        const rawLen = c.raw.length - c.nf;
        budget.spend(COMPILE_UNITS + (rawLen >> 3), 'compile');
        c.c = compilePattern(c.raw, head, c.nf, budget);
        const grow = c.c.len - head.length - rawLen;
        if (grow > 0) budget.spend(grow >> 3, 'compile');
      }
      len = c.c.len;
      if (len < bestLen || (len === bestLen && (r.type !== 'allow' || best.type === 'allow'))) continue;
      if (!matchCompiled(c.c, ctx, budget)) continue;
    }
    best = r;
    bestLen = len;
  }
  budget.spend(visits);
  return { best, bestLen };
}

function result(best, path) {
  if (path === '/robots.txt') return { allowed: true, rule: null, reason: '/robots.txt is always allowed' };
  if (!best) return { allowed: true, rule: null, reason: 'no matching rule' };
  return { allowed: best.type === 'allow', rule: { type: best.type, path: best.path, line: best.line }, reason: 'longest matching rule' };
}

/** Decide allow/disallow for a path given a rule list. Longest match wins; ties go to Allow. */
export function evaluate(rules, path, budget = UNLIMITED) {
  const pp = preparePath(path, budget);
  if (pp.robotsTxt) return result(null, pp.path);
  return result(evalRules(rules, compileList(rules, budget), pp.ctx, budget).best, pp.path);
}

function groupIndex(parsed) {
  if (parsed._index) return parsed._index;
  // parseRobots builds the index; this fallback covers hand-built parsed objects.
  const idx = new Map();
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      const k = a.toLowerCase();
      const e = idx.get(k);
      if (!e) idx.set(k, newEntry(g, a, null));
      else if (e.groups[e.groups.length - 1] !== g) e.groups.push(g);
    }
  }
  Object.defineProperty(parsed, '_index', { value: idx, enumerable: false });
  return idx;
}

function mergedRules(e) {
  return e.groups.flatMap((g) => g.rules);
}

/**
 * Select the rules that apply to a product token.
 * fallbackTokens: tokens the operator documents as fallbacks (e.g. Applebot -> Googlebot).
 * Returns { matched: 'exact'|'fallback'|'wildcard'|'none', matchedAgent, rules, groups }
 */
export function selectRules(parsed, token, fallbackTokens = []) {
  const idx = groupIndex(parsed);
  const sel = (matched, matchedAgent, e) => ({
    matched,
    matchedAgent,
    groups: e.groups,
    entry: e,
    // Merged rule list, built only if a caller asks for it (the summary works per group).
    get rules() {
      return mergedRules(e);
    },
  });
  let e = idx.get(token.toLowerCase());
  if (e) return sel('exact', token, e);
  for (const fb of fallbackTokens) {
    e = idx.get(fb.toLowerCase());
    if (e) return sel('fallback', fb, e);
  }
  e = idx.get('*');
  if (e) return sel('wildcard', '*', e);
  return { matched: 'none', matchedAgent: null, rules: [], groups: [], entry: null };
}

/** True if rule r (pattern length len) beats the current winner: longer wins; on equal length Allow
 * beats Disallow; on a full tie the earlier line wins (= the first rule in the merged list). */
function beats(r, len, best, bestLen) {
  if (len !== bestLen) return len > bestLen;
  if ((r.type === 'allow') !== (best.type === 'allow')) return r.type === 'allow';
  return r.line < best.line;
}

/**
 * Mark the groups of the entries one request will evaluate: g.m.uc = how many of those entries
 * contain g (stamp identifies the request). A group used by only one evaluated entry can be
 * merged into that entry's rule list, even if other agents (never looked up) share it.
 */
function markUse(entries, stamp, budget = UNLIMITED) {
  for (const e of entries) {
    if (e === null) continue;
    const gs = e.groups;
    budget.spend(gs.length * MARK_UNITS);
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      const m = g.m;
      if (!m) g.m = { us: stamp, uc: 1, cc: null, mk: null, mv: null };
      else if (m.us !== stamp) {
        m.us = stamp;
        m.uc = 1;
      } else m.uc++;
    }
  }
}

/**
 * Evaluate an agent-index entry (the groups selected for a token) for a prepared path
 * (preparePath). Same result as evaluating the merged rule list of all its groups:
 * - groups that no other entry evaluated in this request uses (markUse), and small shared
 *   groups, are evaluated together as one merged list (memoised per entry and path);
 * - larger groups shared with other evaluated entries (e.g. one big group naming several
 *   crawlers) are evaluated once per path each (memoised per group) and combined with beats().
 * Every group visit costs 1 budget unit, memo hit or not.
 */
const MERGE_SHARED_RULES = 16;
/** Budget units per (evaluated entry, group) pair marked by markUse (per-request group state). */
export const MARK_UNITS = 12;
function evalEntry(e, pp, budget, stamp) {
  if (pp.robotsTxt || e === null) return result(null, pp.path);
  const ctx = pp.ctx;
  const p = ctx.s;
  let x = e.x;
  if (x === null || x.stamp !== stamp) {
    let rules = [];
    const shared = [];
    let nx = 0;
    let only = null; // the merged group, while there is exactly one
    for (let i = 0; i < e.groups.length; i++) {
      const g = e.groups[i];
      // Merge groups no other evaluated entry uses, and small shared groups. Merged rules stay
      // in file order.
      const uc = g.m.uc;
      if (uc === 1 || g.rules.length * (uc - 1) <= MERGE_SHARED_RULES) {
        nx++;
        only = nx === 1 ? g : null;
        for (let j = 0; j < g.rules.length; j++) rules.push(g.rules[j]);
      } else shared.push(g);
    }
    // A single merged group is evaluated on its own rule list and compiled-rule cache.
    let cc;
    if (only !== null) {
      rules = only.rules;
      cc = only.m.cc || (only.m.cc = compileList(rules, budget));
    } else cc = compileList(rules, budget);
    x = e.x = { stamp, rules, cc, nx, shared, mk: null, mb: null, ml: -1 };
  }
  budget.spend(x.nx);
  let best = null;
  let bestLen = -1;
  if (x.rules.length > 0) {
    if (x.mk !== p) {
      const w = evalRules(x.rules, x.cc, ctx, budget);
      x.mk = p;
      x.mb = w.best;
      x.ml = w.bestLen;
    }
    best = x.mb;
    bestLen = x.ml;
  }
  for (let i = 0; i < x.shared.length; i++) {
    const g = x.shared[i];
    const m = g.m;
    budget.spend(1);
    if (!m.cc) m.cc = compileList(g.rules, budget);
    // One-slot memo: a request evaluates every group for its path, then every group for "/".
    let w = m.mk === p ? m.mv : null;
    if (!w) {
      w = evalRules(g.rules, m.cc, ctx, budget);
      m.mk = p;
      m.mv = w;
    }
    if (w.best && (best === null || beats(w.best, w.bestLen, best, bestLen))) {
      best = w.best;
      bestLen = w.bestLen;
    }
  }
  return result(best, pp.path);
}

export function isAllowed(parsed, token, path = '/', fallbackTokens = []) {
  const sel = selectRules(parsed, token, fallbackTokens);
  const stamp = {};
  markUse([sel.entry], stamp);
  const ev = evalEntry(sel.entry, preparePath(path, UNLIMITED), UNLIMITED, stamp);
  return { ...ev, matched: sel.matched, matchedAgent: sel.matchedAgent };
}

// Documented fallbacks: Apple and ImageSift say they follow Googlebot rules when not named.
export const FALLBACKS = { applebot: ['Googlebot'], imagesiftbot: ['Googlebot'] };

/**
 * Longer paths are cut to this many characters (never splitting a surrogate pair) and the echoed
 * rule gets path_truncated: true; its line number still identifies the full rule.
 */
export const MAX_ECHO_PATH = 256;
function echoRule(rule) {
  if (rule === null || rule.path.length <= MAX_ECHO_PATH) return rule;
  let n = MAX_ECHO_PATH;
  const c = rule.path.charCodeAt(n - 1);
  if (c >= 0xd800 && c <= 0xdbff) n--;
  return { type: rule.type, path: rule.path.slice(0, n), line: rule.line, path_truncated: true };
}

/** Per-AI-crawler summary for a path. Throws TooComplexError if the work budget runs out. */
export function aiCrawlerSummary(parsed, path = '/', budget = new MatchBudget()) {
  const sels = registry.crawlers.map((c) => selectRules(parsed, c.name, FALLBACKS[c.name.toLowerCase()] || []));
  const stamp = {};
  markUse(new Set(sels.map((sel) => sel.entry)), stamp, budget);
  // Each path is prepared (normalised) once. Crawlers that select the same entry (e.g. all
  // crawlers falling back to "*") share one evaluation; a shared hit costs 1 unit.
  const evalAll = (pp) => {
    const byEntry = new Map();
    return sels.map((sel) => {
      let r = byEntry.get(sel.entry);
      if (r) budget.spend(1);
      else byEntry.set(sel.entry, (r = evalEntry(sel.entry, pp, budget, stamp)));
      return r;
    });
  };
  // All groups for the requested path first, then for "/", so per-pattern memos stay warm.
  const atPath = evalAll(preparePath(path, budget));
  const atRoot = evalAll(preparePath('/', budget));
  return registry.crawlers.map((c, i) => {
    const sel = sels[i];
    const r = atPath[i];
    return {
      name: c.name,
      operator: c.operator,
      category: c.category,
      status: r.allowed ? 'allowed' : 'blocked',
      root_blocked: !atRoot[i].allowed,
      matched_group: sel.matchedAgent,
      match_type: sel.matched,
      deciding_rule: echoRule(r.rule),
      respects_robots: c.respects_robots,
      note: c.respects_robots === 'no_user_triggered'
        ? 'User-triggered fetcher: the operator says it may not follow robots.txt.'
        : c.respects_robots === 'not_stated' ? 'Operator documentation does not state robots.txt behaviour.' : undefined,
      docs_url: c.docs_url,
    };
  });
}

export function validateRobots(text, path = '/', budget = new MatchBudget()) {
  return validateRobotsParsed(text, path, budget).result;
}

/** validateRobots plus the parsed file (v0.2.7: the API layer adds personal_agents from it). */
export function validateRobotsParsed(text, path = '/', budget = new MatchBudget()) {
  const parsed = parseRobots(text, budget);
  const ai = aiCrawlerSummary(parsed, path, budget);
  const result = {
    valid: parsed.diagnostics.errors === 0,
    errors: parsed.errors,
    warnings: parsed.warnings,
    info: parsed.info,
    diagnostics: parsed.diagnostics,
    stats: {
      bytes: parsed.size,
      groups: parsed.groups.length,
      rules: parsed.ruleCount + parsed.duplicateRules,
      sitemaps: parsed.sitemaps,
    },
    path,
    ai_crawlers: ai,
  };
  return { result, parsed };
}
