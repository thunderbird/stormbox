import { describe, expect, it } from 'vitest';

import {
  normalizeMessageId,
  normalizeMessageIds,
} from '../../../src/utils/message-id';

describe('Message-ID normalization', () => {
  it('removes one pair of transport angle brackets', () => {
    expect(normalizeMessageId('<message@example.com>')).toBe('message@example.com');
    expect(normalizeMessageId('message@example.com')).toBe('message@example.com');
  });

  it('normalizes the string and array forms returned by JMAP servers', () => {
    expect(normalizeMessageIds('<message@example.com>'))
      .toEqual(['message@example.com']);
    expect(normalizeMessageIds([
      '<first@example.com>',
      'second@example.com',
    ])).toEqual([
      'first@example.com',
      'second@example.com',
    ]);
    expect(normalizeMessageIds(null)).toEqual([]);
  });

  it('rejects unreadable Message-ID values', () => {
    expect(normalizeMessageIds({ 0: 'message@example.com' })).toBeNull();
    expect(normalizeMessageIds(['message@example.com', 42])).toBeNull();
  });
});
