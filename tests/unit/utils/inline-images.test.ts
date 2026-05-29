import { describe, it, expect } from 'vitest';

import { bytesToBase64 } from '../../../src/utils/inline-images';

describe('bytesToBase64', () => {
  it('encodes bytes to base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
    expect(bytesToBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
  });

  it('handles a large buffer without overflowing the call stack', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(bytesToBase64(bytes).length).toBeGreaterThan(0);
  });
});
