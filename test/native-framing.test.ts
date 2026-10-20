import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, FrameDecoder } from '../src/app/nativemsg.ts';
import { MAX_NATIVE_MESSAGE_BYTES } from '../src/app/browser-integration.ts';

const frame = (text: string): Buffer => {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
};

describe('native messaging framing', () => {
  it('encodes a 4-byte little-endian length and UTF-8 JSON', () => {
    const b = encodeMessage({ ok: true, name: 'سريع' });
    const len = b.readUInt32LE(0);
    assert.equal(len, b.length - 4);
    assert.deepEqual(JSON.parse(b.subarray(4).toString('utf8')), { ok: true, name: 'سريع' });
  });

  it('refuses to encode a message over 1 MB', () => {
    assert.throws(() => encodeMessage({ x: 'a'.repeat(MAX_NATIVE_MESSAGE_BYTES) }), /too large/);
  });

  it('decodes a whole message, and one split into tiny pieces', () => {
    const f = frame('{"type":"ping"}');
    assert.deepEqual(new FrameDecoder().push(f), { status: 'message', text: '{"type":"ping"}', rest: Buffer.alloc(0) });
    const d = new FrameDecoder();
    for (let i = 0; i < f.length - 1; i++) assert.deepEqual(d.push(f.subarray(i, i + 1)), { status: 'need-more' });
    const last = d.push(f.subarray(f.length - 1));
    assert.equal(last.status, 'message');
    assert.equal(last.status === 'message' && last.text, '{"type":"ping"}');
  });

  it('keeps whatever follows the first message', () => {
    const r = new FrameDecoder().push(Buffer.concat([frame('{"a":1}'), Buffer.from('xyz')]));
    assert.equal(r.status === 'message' && r.rest.toString(), 'xyz');
  });

  it('decodes multi-byte characters that are split across chunks', () => {
    const f = frame('{"fileName":"ملف.zip"}');
    const d = new FrameDecoder();
    const mid = Math.floor(f.length / 2);
    assert.equal(d.push(f.subarray(0, mid)).status, 'need-more');
    const r = d.push(f.subarray(mid));
    assert.equal(r.status === 'message' && r.text, '{"fileName":"ملف.zip"}');
  });

  it('rejects a length over the limit as soon as the header is in, without buffering the body', () => {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    assert.deepEqual(new FrameDecoder().push(head), { status: 'error', error: 'message too large' });
    head.writeUInt32LE(0xffffffff, 0);
    assert.deepEqual(new FrameDecoder().push(head), { status: 'error', error: 'message too large' });
  });

  it('accepts exactly the limit and rejects a zero length and invalid UTF-8', () => {
    const body = Buffer.alloc(MAX_NATIVE_MESSAGE_BYTES, 0x20);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    assert.equal(new FrameDecoder().push(Buffer.concat([head, body])).status, 'message');
    assert.deepEqual(new FrameDecoder().push(Buffer.alloc(4)), { status: 'error', error: 'empty message' });
    const bad = Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from([0xff, 0xfe])]);
    assert.deepEqual(new FrameDecoder().push(bad), { status: 'error', error: 'message is not valid UTF-8' });
  });
});
