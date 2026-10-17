// Personal-agent awareness (v0.2.7). Personal agents such as Meta's Muse browse in a real browser
// for one person; Meta publishes no Muse user-agent, IP list, robots.txt token or signature
// (checked 2026-10-08, registry.personal_agents). This module explains what a robots.txt can and
// can't do about them. It never changes ai_crawlers, errors, warnings or validity: it only adds
// the personal_agents object to /api/validate and /api/check responses.
//
// Cost: O(registry crawlers) over the already-computed ai_crawlers summary plus one first-character
// pass over the parser's distinct agent keys, so no work-budget units are charged.
import registry from './crawlers-data.js';

const PA = registry.personal_agents;
export const PERSONAL_AGENTS_AS_OF = PA.date_checked;
export const PERSONAL_AGENTS_GUIDE = PA.guide_url;

// Tokens a site owner might write for Muse. None is published by Meta; "muse-" is the pattern
// Cloudflare Radar lists. Matching is case-insensitive like the parser index (keys are lowercase).
export const MUSE_TOKENS = Object.freeze(['muse', 'muse-', 'musebot', 'muse-bot', 'muse-agent', 'meta-muse', 'metamuse', 'meta-muse-agent', 'museagent']);
const MUSE_SET = new Set(MUSE_TOKENS);
export const DISCLAIMER = PA.disclaimer; // 'RobotsGate is not affiliated with Meta.'

/**
 * Muse-style tokens named in the file, in first-seen order. product/version forms such as
 * "muse/1.0" or "Muse-Agent/2" are cut at the first "/" before the check. One pass over the
 * parser's distinct agent keys (already charged to the work budget at parse time as PU_ENTRY each);
 * keys not starting with "m" are rejected on the first character.
 */
function namedMuseTokens(idx) {
  const out = [];
  for (const k of idx.keys()) {
    if (k.charCodeAt(0) !== 109) continue; // 'm'
    const slash = k.indexOf('/');
    const base = slash < 0 ? k : k.slice(0, slash);
    if (MUSE_SET.has(base)) out.push(k);
  }
  return out;
}

const META_CRAWLERS = new Set(registry.crawlers.filter((c) => c.operator === 'Meta').map((c) => c.name));

const NO_ID = PA.agents
  .filter((a) => !a.operator_published.user_agent && !a.operator_published.robots_txt_token)
  .map((a) => `${a.name} (${a.operator})`);

function agentIndex(parsed) {
  return parsed && parsed._index instanceof Map ? parsed._index : null;
}

/**
 * @param {object} parsed  parseRobots() result
 * @param {Array} ai       aiCrawlerSummary() result for the same file and path
 * @returns personal_agents object (additive response field)
 */
export function personalAgentSummary(parsed, ai) {
  const findings = [];
  const add = (code, level, message) => findings.push({ code, level, message });
  const blocked = ai.filter((c) => c.status === 'blocked');
  const rootBlocked = ai.filter((c) => c.root_blocked);
  const idx = agentIndex(parsed);
  const museNamed = idx ? namedMuseTokens(idx) : [];
  const wildcardRoot = ai.some((c) => c.match_type === 'wildcard' && c.root_blocked);
  const metaBlocked = blocked.filter((c) => META_CRAWLERS.has(c.name)).map((c) => c.name);

  if (blocked.length > 0 || rootBlocked.length > 0) {
    add('declared_crawlers_only', 'notice',
      `This file asks ${blocked.length} of ${ai.length} declared AI crawlers not to crawl the tested path` +
      (rootBlocked.length !== blocked.length ? ` (${rootBlocked.length} at "/")` : '') +
      '. robots.txt only reaches crawlers that announce a user-agent token and choose to follow it. ' +
      "Personal agents such as Meta's Muse browse in their own cloud browser for one person and can look like a normal browser; " +
      `as of ${PERSONAL_AGENTS_AS_OF} Meta publishes no Muse user-agent, IP list or robots.txt token, so these rules don't reliably keep them out.`);
  }
  if (wildcardRoot) {
    add('wildcard_not_agent_block', 'notice',
      '"User-agent: *" with "Disallow: /" asks every compliant crawler (search engines included) to stay away, ' +
      'but it is not a block for personal agents: robots.txt is voluntary (RFC 9309) and Meta has not said Muse reads it. ' +
      'To actually restrict them, use server or CDN controls such as rate limits, challenges or login.');
  }
  if (metaBlocked.length > 0) {
    add('meta_crawlers_not_muse', 'info',
      `Blocking ${metaBlocked.join(', ')} does not cover Muse. Meta's crawler page lists no Muse crawler, ` +
      'and no Meta page says Muse uses these crawlers.');
  }
  if (museNamed.length > 0) {
    add('muse_token_unpublished', 'notice',
      `This file names ${museNamed.slice(0, 5).map((t) => `"${t.length > 64 ? t.slice(0, 64) + '…' : t}"`).join(', ')}` +
      (museNamed.length > 5 ? ` and ${museNamed.length - 5} more` : '') + '. Meta publishes no robots.txt token for Muse. ' +
      'Cloudflare Radar lists the user-agent pattern "muse-" for Muse. Meta hasn\'t said Muse reads or obeys robots.txt ' +
      '(Cloudflare lists Muse as "Verified" but publishes no Muse-specific detail), so treat this group as a request at most, not a block.');
  }
  if (findings.length === 0) {
    add('no_ai_blocks', 'info',
      "This file doesn't ask any declared AI crawler to stay out of the tested path. robots.txt doesn't govern personal agents " +
      "such as Muse either way; if you want them, check that your CDN or bot settings (for example Cloudflare's Agent control) aren't blocking them.");
  }
  return {
    robots_txt_controls_them: PA.robots_txt_controls_them,
    declared_ai_crawlers_blocked: blocked.length,
    agents_without_published_identifier: NO_ID,
    findings,
    guide_url: PERSONAL_AGENTS_GUIDE,
    as_of: PERSONAL_AGENTS_AS_OF,
    disclaimer: DISCLAIMER,
  };
}

/** One generator note (additive /api/generate field). */
export const GENERATE_NOTE =
  "These rules only reach crawlers that read robots.txt. Personal agents such as Meta's Muse browse in a real browser for one person; " +
  `as of ${PERSONAL_AGENTS_AS_OF} Meta publishes no Muse user-agent or robots.txt token, so robots.txt can't target them. ` +
  `See ${PERSONAL_AGENTS_GUIDE} for allow, rate-limit, challenge and login options. ${DISCLAIMER}`;
