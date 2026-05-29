import { describe, it, expect } from 'vitest';

import { base64ToBytes, bytesToBase64, extractDataUriImages } from '../../../src/utils/inline-images';

describe('extractDataUriImages', () => {
  it('rewrites a single data: image to a cid reference and returns its payload', () => {
    const b64 = btoa('hello-png');
    const html = `<div><img src="data:image/png;base64,${b64}" style="max-width:100%"></div>`;

    const { html: out, images } = extractDataUriImages(html);

    expect(images).toHaveLength(1);
    expect(images[0].type).toBe('image/png');
    expect(images[0].base64).toBe(b64);
    expect(images[0].cid).toMatch(/@stormbox$/);
    expect(out).toContain(`src="cid:${images[0].cid}"`);
    expect(out).not.toContain('data:image/');
    // Surrounding markup/attributes are preserved.
    expect(out).toContain('style="max-width:100%"');
  });

  it('handles multiple images with distinct cids in document order', () => {
    const a = btoa('a');
    const b = btoa('bb');
    const html = `<img src="data:image/png;base64,${a}"><img src="data:image/jpeg;base64,${b}">`;

    const { html: out, images } = extractDataUriImages(html);

    expect(images.map((i) => i.type)).toEqual(['image/png', 'image/jpeg']);
    expect(images[0].cid).not.toBe(images[1].cid);
    expect(out).toContain(`cid:${images[0].cid}`);
    expect(out).toContain(`cid:${images[1].cid}`);
    expect(out).not.toContain('data:image/');
  });

  it('strips whitespace embedded in the base64 payload', () => {
    const b64 = btoa('payload-with-some-length');
    const chunked = `${b64.slice(0, 4)}\n   ${b64.slice(4)}`;
    const html = `<img src="data:image/gif;base64,${chunked}">`;

    const { images } = extractDataUriImages(html);

    expect(images[0].base64).toBe(b64);
  });

  it('handles single-quoted src attributes', () => {
    const b64 = btoa('x');
    const html = `<img src='data:image/png;base64,${b64}'>`;

    const { html: out, images } = extractDataUriImages(html);

    expect(images).toHaveLength(1);
    expect(images[0].type).toBe('image/png');
    expect(out).toContain(`src="cid:${images[0].cid}"`);
  });

  it('leaves http(s) and existing cid images untouched', () => {
    const html = '<img src="https://example.com/a.png"><img src="cid:existing@x">';

    const { html: out, images } = extractDataUriImages(html);

    expect(images).toHaveLength(0);
    expect(out).toBe(html);
  });

  it('returns the input unchanged when there are no images', () => {
    expect(extractDataUriImages('<p>plain</p>')).toEqual({ html: '<p>plain</p>', images: [] });
    expect(extractDataUriImages('')).toEqual({ html: '', images: [] });
  });
});

describe('base64ToBytes', () => {
  it('decodes base64 into the original bytes', () => {
    const bytes = base64ToBytes(btoa('ABC'));
    expect(Array.from(bytes)).toEqual([65, 66, 67]);
  });

  it('round-trips a payload produced by extractDataUriImages', () => {
    const original = 'PNG\x00\x01\x02data';
    const html = `<img src="data:image/png;base64,${btoa(original)}">`;

    const { images } = extractDataUriImages(html);
    const bytes = base64ToBytes(images[0].base64);

    expect(String.fromCharCode(...bytes)).toBe(original);
  });
});

describe('bytesToBase64', () => {
  it('encodes bytes to base64 and round-trips through base64ToBytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(btoa(String.fromCharCode(...bytes)));
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
  });

  it('handles a large buffer without overflowing the call stack', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    const b64 = bytesToBase64(bytes);
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
  });
});
