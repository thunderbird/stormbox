import { describe, it, expect } from 'vitest';

import {
  DEFAULT_FOLDER_COLOR,
  folderCompare,
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

describe('folderCompare', () => {
  it('floats starred folders above unstarred peers', () => {
    const rows = [
      { role: null, name: 'Alpha', is_starred: 0 as const },
      { role: null, name: 'Zulu', is_starred: 1 as const },
      { role: null, name: 'Mike', is_starred: 0 as const },
    ];
    rows.sort(folderCompare);
    expect(rows.map((r) => r.name)).toEqual(['Zulu', 'Alpha', 'Mike']);
  });

  it('sorts starred folders amongst themselves by the normal name order', () => {
    const rows = [
      { role: null, name: 'Zulu', is_starred: 1 as const },
      { role: null, name: 'Alpha', is_starred: 1 as const },
    ];
    rows.sort(folderCompare);
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('never lets a star outrank role ordering', () => {
    const rows = [
      { role: null, name: 'Starred user folder', is_starred: 1 as const },
      { role: 'inbox' as const, name: 'Inbox', is_starred: 0 as const },
    ];
    rows.sort(folderCompare);
    expect(rows[0].name).toBe('Inbox');
  });

  it('treats a missing is_starred as unstarred', () => {
    const rows = [
      { role: null, name: 'Legacy' },
      { role: null, name: 'Pinned', is_starred: 1 as const },
    ];
    rows.sort(folderCompare);
    expect(rows[0].name).toBe('Pinned');
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
