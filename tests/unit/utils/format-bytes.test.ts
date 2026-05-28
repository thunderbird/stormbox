import { describe, it, expect } from 'vitest';

import { formatBytes } from '../../../src/utils/format-bytes';

describe('formatBytes', () => {
  it('returns null for missing values', () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(undefined)).toBeNull();
  });

  it('formats gigabytes without decimals', () => {
    expect(formatBytes(50 * 1024 ** 3)).toBe('50 GB');
  });

  it('formats megabytes and kilobytes', () => {
    expect(formatBytes(3 * 1024 ** 2)).toBe('3 MB');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
  });

  it('formats small byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
  });
});
