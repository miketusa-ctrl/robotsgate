// SSRF guards for /api/check.

export class SsrfError extends Error {}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.arpa', '.test', '.invalid', '.example'];

/** Validate and normalise a user-supplied site URL. Returns the robots.txt URL (string). */
export function toRobotsUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new SsrfError('Missing "url" parameter.');
  let s = input.trim();
  if (s.length > 2048) throw new SsrfError('URL is too long (max 2048 characters).');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s; // allow bare hostnames
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new SsrfError('Not a valid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('Only http and https URLs are allowed.');
  if (u.username || u.password) throw new SsrfError('URLs with credentials are not allowed.');
  if (u.port && u.port !== '80' && u.port !== '443') throw new SsrfError('Only default ports (80/443) are allowed.');
  checkHostname(u.hostname);
  return `${u.protocol}//${u.host}/robots.txt`;
}

export function checkHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) throw new SsrfError('Missing hostname.');
  if (h === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s))) throw new SsrfError('Local or internal hostnames are not allowed.');
  if (h.startsWith('[') || h.includes(':')) {
    const v6 = h.replace(/^\[|\]$/g, '');
    if (isPrivateIPv6(v6)) throw new SsrfError('Private, loopback or reserved IP addresses are not allowed.');
    return;
  }
  if (/^[0-9.]+$/.test(h) || /^0x/i.test(h)) {
    if (!isIPv4(h) || isPrivateIPv4(h)) throw new SsrfError('Private, loopback or reserved IP addresses are not allowed.');
    return;
  }
  if (!h.includes('.')) throw new SsrfError('Hostname must be a public domain name.');
}

export function isIPv4(s) {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isPrivateIPv4(ip) {
  if (!isIPv4(ip)) return true;
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

export function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // hex-form mapped: reject conservatively
  return (
    /^f[cd]/.test(s) || // unique local fc00::/7
    /^fe[89ab]/.test(s) || // link-local fe80::/10
    /^ff/.test(s) || // multicast
    s.startsWith('2001:db8') || // documentation
    s.startsWith('64:ff9b') || // NAT64
    s.startsWith('100:') || // discard
    s.startsWith('::') // other IPv4-compatible / unspecified forms
  );
}

/** Raised when the DNS safety check cannot be completed (fail closed). */
export class DnsCheckError extends Error {}

/**
 * Resolve a hostname via DNS-over-HTTPS (Cloudflare 1.1.1.1 JSON API) and reject private answers.
 * FAILS CLOSED: if a DoH query errors, times out, returns non-OK, returns unparseable JSON, or
 * reports a DNS server failure, a DnsCheckError is thrown and the request is refused (502).
 * NXDOMAIN / no answers is allowed through (the subsequent fetch simply fails).
 */
export async function assertPublicDns(hostname, fetchImpl, timeoutMs = 3000) {
  const h = hostname.toLowerCase();
  if (isIPv4(h) || h.includes(':') || h.startsWith('[')) return { checked: false, reason: 'ip-literal' };
  const answers = [];
  for (const type of ['A', 'AAAA']) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let j;
    try {
      const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new DnsCheckError(`DNS safety check failed (DoH HTTP ${res.status}).`);
      j = await res.json();
    } catch (e) {
      if (e instanceof DnsCheckError) throw e;
      throw new DnsCheckError(e && e.name === 'AbortError' ? 'DNS safety check timed out.' : 'DNS safety check failed (DoH request error).');
    } finally {
      clearTimeout(t);
    }
    // RCODE 0 = NOERROR, 3 = NXDOMAIN; anything else (e.g. 2 SERVFAIL, 5 REFUSED) is a failure.
    if (!j || typeof j !== 'object' || (j.Status !== undefined && j.Status !== 0 && j.Status !== 3)) {
      throw new DnsCheckError(`DNS safety check failed (DNS status ${j && j.Status}).`);
    }
    for (const a of j.Answer || []) {
      if (a.type === 1 || a.type === 28) answers.push(a.data);
    }
  }
  for (const ip of answers) {
    if ((isIPv4(ip) && isPrivateIPv4(ip)) || (ip.includes(':') && isPrivateIPv6(ip))) {
      throw new SsrfError('Hostname resolves to a private, loopback or reserved IP address.');
    }
  }
  return { checked: true, answers: answers.length };
}
