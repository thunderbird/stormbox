import { describe, expect, it } from 'vitest';

import { nextCopyName } from '../../../src/utils/copy-name';

describe('nextCopyName', () => {
  it('numbers copies from one', () => {
    expect(nextCopyName('Alice', ['Alice'])).toBe('Alice (Copy 1)');
  });

  it('continues the highest existing copy number', () => {
    expect(nextCopyName(
      'Alice',
      ['Alice', 'Alice (Copy 1)', 'Alice (Copy 3)', 'Bob (Copy 8)'],
    )).toBe('Alice (Copy 4)');
  });

  it('continues numbering when duplicating a copy', () => {
    expect(nextCopyName(
      'Alice (Copy 2)',
      ['Alice', 'Alice (Copy 1)', 'Alice (Copy 2)'],
    )).toBe('Alice (Copy 3)');
  });
});
