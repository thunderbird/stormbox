import { describe, expect, it } from 'vitest';

import {
  errorProperties,
  hasErrorProperty,
} from '../../../src/sync/backends/jmap/set-error';

describe('JMAP SetError properties', () => {
  it('normalizes string properties and ignores malformed entries', () => {
    expect(errorProperties({
      properties: ['/ReplyTo/0/email', 'BCC.1.email', 42, null],
    })).toEqual(['replyto/0/email', 'bcc.1.email']);
    expect(errorProperties({ properties: 'name' })).toEqual([]);
    expect(errorProperties(null)).toEqual([]);
  });

  it.each([
    'name',
    'name/value',
    'name.value',
    'name[0]',
  ])('matches %s as the named property or one of its children', (property) => {
    expect(hasErrorProperty([property], 'NAME')).toBe(true);
  });

  it('does not match unrelated properties that share a prefix', () => {
    expect(hasErrorProperty(['namespace'], 'name')).toBe(false);
  });
});
