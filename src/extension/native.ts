/**
 * Messages to and from the native-messaging host (the Sareea DL exe). Pure.
 * The host adds the protocol version and id itself; see docs/protocol.md and docs/extension.md.
 */

export const NATIVE_HOST_NAME = 'com.sareea.dl';

export interface AddInput {
  url: string;
  fileName?: string | null;
  referrer?: string | null;
  pageUrl?: string | null;
  /** Cookie header value, only when the user granted this site. Travels to the host for this one download. */
  cookie?: string | null;
  userAgent?: string | null;
}

/** The "add" message. Fields that are empty are left out, so nothing meaningless is sent. */
export function buildAddMessage(input: AddInput): Record<string, unknown> {
  const msg: Record<string, unknown> = { type: 'add', url: input.url };
  if (input.fileName) msg.fileName = input.fileName;
  if (input.referrer) msg.referrer = input.referrer;
  if (input.pageUrl) msg.pageUrl = input.pageUrl;
  const headers: Record<string, string> = {};
  if (input.cookie) headers.cookie = input.cookie;
  if (input.userAgent) headers.userAgent = input.userAgent;
  if (Object.keys(headers).length > 0) msg.headers = headers;
  return msg;
}

/**
 * How a host exchange ended.
 *  ok               the app accepted the request
 *  host-missing     the browser has no registered host (integration not installed)
 *  app-not-running  the host could not reach the app and could not start it
 *  rejected         the app refused the request (error is the app's short English text, never a value from the request)
 *  failed           anything else (host crashed, bad reply)
 */
export type NativeOutcome =
  | { kind: 'ok' }
  | { kind: 'host-missing' }
  | { kind: 'app-not-running' }
  | { kind: 'rejected'; error: string }
  | { kind: 'failed' };

export function classifyReply(reply: unknown, lastErrorMessage: string | null): NativeOutcome {
  if (lastErrorMessage !== null) {
    return /not found|forbidden|not registered/i.test(lastErrorMessage) ? { kind: 'host-missing' } : { kind: 'failed' };
  }
  if (typeof reply !== 'object' || reply === null) return { kind: 'failed' };
  const r = reply as { ok?: unknown; error?: unknown };
  if (r.ok === true) return { kind: 'ok' };
  if (r.ok === false) {
    const e = typeof r.error === 'string' ? r.error.slice(0, 120) : '';
    if (e === 'app-not-running') return { kind: 'app-not-running' };
    return { kind: 'rejected', error: e || 'rejected' };
  }
  return { kind: 'failed' };
}

/** Text for the badge tooltip and the popup. */
export function outcomeText(o: NativeOutcome): string {
  switch (o.kind) {
    case 'ok':
      return 'Sareea DL is running.';
    case 'app-not-running':
      return 'Sareea DL not running';
    case 'host-missing':
      return 'Sareea DL browser integration is not installed';
    case 'rejected':
      return 'Sareea DL did not accept the download';
    default:
      return 'Could not reach Sareea DL';
  }
}
