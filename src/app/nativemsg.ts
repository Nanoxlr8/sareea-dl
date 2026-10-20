/**
 * Chrome native messaging framing, as the browser sees it. Pure. The host (host/SareeaHost.cs) implements
 * the same format in C#; this TypeScript side is what the tests and the end-to-end script use to talk to it.
 * Wire format (both directions): a 4-byte little-endian length, then that many bytes of UTF-8 JSON.
 */
import { MAX_NATIVE_MESSAGE_BYTES } from './browser-integration.ts';

export function encodeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('message too large');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export type FrameResult =
  | { status: 'need-more' }
  | { status: 'message'; text: string; rest: Buffer }
  | { status: 'error'; error: string };

/**
 * Accumulates bytes and yields one framed message. The length is checked as soon as the 4 header bytes
 * are in, so a hostile or broken sender cannot make us buffer more than the limit.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private readonly max: number;

  constructor(maxBytes: number = MAX_NATIVE_MESSAGE_BYTES) {
    this.max = maxBytes;
  }

  push(chunk: Uint8Array): FrameResult {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length < 4) return { status: 'need-more' };
    const len = this.buf.readUInt32LE(0);
    if (len === 0) return { status: 'error', error: 'empty message' };
    if (len > this.max) return { status: 'error', error: 'message too large' };
    if (this.buf.length < 4 + len) return { status: 'need-more' };
    const body = this.buf.subarray(4, 4 + len);
    const rest = this.buf.subarray(4 + len);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return { status: 'error', error: 'message is not valid UTF-8' };
    }
    return { status: 'message', text, rest: Buffer.from(rest) };
  }
}
