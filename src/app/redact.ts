/** Strips secrets from text before it is logged. Pure. */

const URL_RE = /\b(https?:\/\/)([^\s"'<>]+)/gi;
const HEADER_RE = /\b(cookie|set-cookie|authorization|proxy-authorization|x-api-key)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]*)/gi;
const BEARER_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/**
 * - URLs keep scheme, host and path; credentials, query string and fragment are dropped
 * - Cookie / Authorization style header values are replaced
 * - Bearer / Basic tokens are replaced
 */
export function redact(text: string): string {
  let out = text.replace(URL_RE, (_m, scheme: string, rest: string) => {
    let r = rest;
    const at = r.indexOf('@');
    const slash = r.indexOf('/');
    if (at >= 0 && (slash < 0 || at < slash)) r = '[redacted]@' + r.slice(at + 1);
    const cut = r.search(/[?#]/);
    if (cut >= 0) r = r.slice(0, cut) + (r[cut] === '?' ? '?[redacted]' : '');
    return scheme + r;
  });
  out = out.replace(HEADER_RE, (_m, name: string, sep: string) => `${name}${sep}[redacted]`);
  out = out.replace(BEARER_RE, (_m, kind: string) => `${kind} [redacted]`);
  return out;
}
