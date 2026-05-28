import { describe, it, expect } from 'vitest';

import {
  DEFAULT_FOLDER_COLOR,
  folderPresentation,
  folderSortKey,
  isMainFolder,
} from '../../../src/utils/folder-presentation';

describe('folderPresentation', () => {
  it('returns the role icon and accent for a JMAP role', () => {
    const inbox = folderPresentation({ role: 'inbox', name: 'Inbox' });
    const trash = folderPresentation({ role: 'trash', name: 'Trash' });
    expect(inbox.icon).toMatch(/<svg/);
    expect(inbox.color).toBe('#1a73e8');
    expect(trash.color).toBe('#5f6368');
  });

  it('falls back to the named-folder map for non-role folders', () => {
    const newsletters = folderPresentation({ role: null, name: 'Newsletters' });
    const feeds = folderPresentation({ role: null, name: 'Feeds' });
    expect(newsletters.color).toBe('#7378a6');
    expect(feeds.color).toBe('#f97316');
  });

  it('returns the default folder colour for plain user folders', () => {
    expect(folderPresentation({ role: null, name: 'Project A' }).color)
      .toBe(DEFAULT_FOLDER_COLOR);
  });
});

describe('folderSortKey', () => {
  it('orders inbox first, drafts/sent/archive next, junk and trash last among role folders', () => {
    expect(folderSortKey({ role: 'inbox' })).toBeLessThan(folderSortKey({ role: 'drafts' }));
    expect(folderSortKey({ role: 'drafts' })).toBeLessThan(folderSortKey({ role: 'sent' }));
    expect(folderSortKey({ role: 'sent' })).toBeLessThan(folderSortKey({ role: 'archive' }));
    expect(folderSortKey({ role: 'archive' })).toBeLessThan(folderSortKey({ role: 'junk' }));
    expect(folderSortKey({ role: 'junk' })).toBeLessThan(folderSortKey({ role: 'trash' }));
  });

  it('puts non-role folders after every role folder', () => {
    const userFolderKey = folderSortKey({ role: null });
    expect(userFolderKey).toBeGreaterThan(folderSortKey({ role: 'trash' }));
  });
});

describe('isMainFolder', () => {
  it('is true for any role with a known icon', () => {
    expect(isMainFolder({ role: 'inbox' })).toBe(true);
    expect(isMainFolder({ role: 'sent' })).toBe(true);
    expect(isMainFolder({ role: 'drafts' })).toBe(true);
    expect(isMainFolder({ role: 'archive' })).toBe(true);
    expect(isMainFolder({ role: 'trash' })).toBe(true);
    expect(isMainFolder({ role: 'junk' })).toBe(true);
  });

  it('is false for null roles and roles without a dedicated icon', () => {
    expect(isMainFolder({ role: null })).toBe(false);
    expect(isMainFolder({ role: 'flagged' })).toBe(false);
    expect(isMainFolder({ role: 'all' })).toBe(false);
  });
});
