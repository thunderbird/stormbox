import { describe, expect, it } from 'vitest';

import { resolveSetting, SETTING_DEFAULTS } from '../../../src/constants/settings';
import {
  DEFAULT_MESSAGE_TAGS,
  deriveTagKeyword,
  isMessageTagDefinitionList,
  isReservedKeyword,
  isSystemKeyword,
  isTagKeyword,
  isValidKeyword,
  MAX_KEYWORD_LENGTH,
  MAX_TAG_DEFINITIONS,
  randomTagColor,
  resolveMessageTags,
  TAG_COLOR_PALETTE,
  resolveTag,
  sortTagDefinitions,
  tagKeywordsOf,
  tagNameError,
  tagPresenceIndex,
  visibleTagDefinitions,
} from '../../../src/utils/message-tags';

describe('randomTagColor', () => {
  it('draws from the palette colors no tag uses, then from the whole palette', () => {
    // The five defaults take the first five palette colors.
    const unused = TAG_COLOR_PALETTE.slice(5);
    expect(randomTagColor(DEFAULT_MESSAGE_TAGS, () => 0)).toBe(unused[0]);
    expect(randomTagColor(DEFAULT_MESSAGE_TAGS, () => 0.999)).toBe(unused.at(-1));
    const draws = new Set(Array.from({ length: 200 }, () => randomTagColor(DEFAULT_MESSAGE_TAGS)));
    expect([...draws].every((color) => unused.includes(color))).toBe(true);

    const everyColor = TAG_COLOR_PALETTE.map((color, order) => ({
      keyword: `k${order}`, name: `k${order}`, color: color.toLowerCase(), order,
    }));
    expect(randomTagColor(everyColor, () => 0.5)).toBe(TAG_COLOR_PALETTE[6]);
  });
});

describe('isValidKeyword (RFC 8621 §4.1.1)', () => {
  it('accepts printable ASCII without the forbidden characters', () => {
    expect(isValidKeyword('$label1')).toBe(true);
    expect(isValidKeyword('receipts')).toBe(true);
    expect(isValidKeyword('a-b_c.d/e~f')).toBe(true);
  });

  it('rejects empty, whitespace, non-ASCII and the excluded punctuation', () => {
    expect(isValidKeyword('')).toBe(false);
    expect(isValidKeyword('to do')).toBe(false);
    expect(isValidKeyword('café')).toBe(false);
    for (const ch of ['(', ')', '{', ']', '%', '*', '"', '\\']) {
      expect(isValidKeyword(`a${ch}b`)).toBe(false);
    }
    expect(isValidKeyword('x'.repeat(256))).toBe(false);
    expect(isValidKeyword(42)).toBe(false);
  });
});

describe('deriveTagKeyword (MK-6.3)', () => {
  it('preserves complete UTF-8 characters when making room for a collision suffix', () => {
    const name = 'a'.repeat(95) + '😀éé é';
    const first = deriveTagKeyword(name)!;
    expect(first).toHaveLength(128);
    const second = deriveTagKeyword(name, [first])!;
    expect(second).toBe(first.slice(0, -6) + '2');
    expect(decodeURIComponent(second.replaceAll('=', '%'))).toBe(name.slice(0, -1) + '2');
  });
  it('lowercases ASCII and hex-escapes spaces, punctuation and Unicode', () => {
    expect(deriveTagKeyword('To Do')).toBe('to=20do');
    expect(deriveTagKeyword('Q3 (draft) *urgent*')).toBe('q3=20=28draft=29=20=2aurgent=2a');
    expect(deriveTagKeyword('日本語')).toBe('=e6=97=a5=e6=9c=ac=e8=aa=9e');
    expect(deriveTagKeyword('Café')).toBe('caf=c3=a9');
    expect(deriveTagKeyword('=e6')).toBe('=3de6');
  });

  it('lowercases only ASCII and escapes } as Thunderbird does', () => {
    expect(deriveTagKeyword('CAFÉ')).toBe('caf=c3=89');
    expect(deriveTagKeyword('Ωmega')).toBe('=ce=a9mega');
    expect(deriveTagKeyword('İstanbul')).toBe('=c4=b0stanbul');
    expect(deriveTagKeyword('a}b')).toBe('a=7db');
  });

  it('keeps a leading $, as Thunderbird does, but never yields a reserved keyword', () => {
    expect(deriveTagKeyword('$seen')).toBe('$seen2');
    expect(deriveTagKeyword('$Flagged')).toBe('$flagged2');
    expect(deriveTagKeyword('Seen')).toBe('seen');
    expect(deriveTagKeyword('$$Work')).toBe('$$work');
    expect(deriveTagKeyword('$')).toBe('$');
    expect(deriveTagKeyword('   ')).toBeNull();
    expect(deriveTagKeyword('   ', ['seen'])).toBeNull();
  });

  it('yields a hidden system keyword when the name spells it', () => {
    expect(deriveTagKeyword('NonJunk')).toBe('nonjunk');
    expect(deriveTagKeyword('Junk')).toBe('junk');
    expect(deriveTagKeyword(' $Todo ')).toBe('$todo');
    expect(deriveTagKeyword('$has_note')).toBe('$has_note');
    expect(deriveTagKeyword('$todo', ['$TODO'])).toBe('$todo2');
  });

  it('disambiguates against existing keywords case-insensitively', () => {
    expect(deriveTagKeyword('Work', ['work'])).toBe('work2');
    expect(deriveTagKeyword('work', ['Work', 'work2'])).toBe('work3');
  });

  it('caps at the server limit, leaving room for the suffix', () => {
    const long = 'a'.repeat(98) + '😀😀';
    const first = deriveTagKeyword(long);
    expect(first!.length).toBeLessThanOrEqual(MAX_KEYWORD_LENGTH);
    const second = deriveTagKeyword(long, [first!]);
    expect(second!.length).toBeLessThanOrEqual(MAX_KEYWORD_LENGTH);
    expect(second!.endsWith('2')).toBe(true);
    expect(isValidKeyword(second)).toBe(true);
    const capped = deriveTagKeyword('語'.repeat(100));
    expect(capped!.length).toBeLessThanOrEqual(MAX_KEYWORD_LENGTH);
    expect(deriveTagKeyword('語'.repeat(99) + '文', [capped!])).not.toBe(capped);
  });
});

describe('tag display names', () => {
  it('accepts Unicode and counts code points rather than UTF-16 units', () => {
    for (const name of ['日本語', 'العربية', '😀', '👩‍💻', '()%', '😀'.repeat(100)]) {
      expect(tagNameError(name)).toBeNull();
      expect(isValidKeyword(deriveTagKeyword(name))).toBe(true);
      expect(isMessageTagDefinitionList([{ keyword: 'tag', name, color: '#123456', order: 0 }])).toBe(true);
    }
  });

  it('rejects empty, oversized, control and malformed Unicode names', () => {
    for (const name of ['', '   ', '😀'.repeat(101), '日'.repeat(101), 'a\n', 'a\u0000', '\ud800']) {
      expect(tagNameError(name)).not.toBeNull();
      expect(deriveTagKeyword(name)).toBeNull();
    }
  });
});

describe('tagKeywordsOf', () => {
  it('returns non-system keywords, lowercased and deduplicated', () => {
    expect(tagKeywordsOf('{"$seen":true,"$flagged":true,"Work":true,"work":true,"$label1":true}'))
      .toEqual(['work', '$label1']);
  });

  it('ignores false values, malformed JSON and non-objects', () => {
    expect(tagKeywordsOf('{"work":false}')).toEqual([]);
    expect(tagKeywordsOf('not json')).toEqual([]);
    expect(tagKeywordsOf('[1]')).toEqual([]);
    expect(tagKeywordsOf(null)).toEqual([]);
  });

  it('treats every IANA-registered keyword as a system keyword', () => {
    const registered = [
      '$MDNSent', '$Forwarded', '$SubmitPending', '$Submitted', '$Junk', '$NotJunk', '$Phishing',
      '$Important', '$draft', '$seen', '$flagged', '$answered', '$recent', '$autosent',
      '$canunsubscribe', '$followed', '$hasattachment', '$hasmemo', '$hasnoattachment', '$imported',
      '$istrusted', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2', '$maskedemail', '$memo',
      '$muted', '$new', '$notify', '$unsubscribed',
    ];
    for (const keyword of registered) expect(isSystemKeyword(keyword)).toBe(true);
    expect(tagKeywordsOf(JSON.stringify(Object.fromEntries(registered.map((k) => [k, true]))))).toEqual([]);
  });

  it('treats the unprefixed junk-classifier keywords as system keywords', () => {
    expect(tagKeywordsOf('{"NonJunk":true,"Junk":true,"NotJunk":true,"receipts":true}')).toEqual(['receipts']);
  });

  it('treats status markers written by other clients and servers as system keywords', () => {
    const markers = [
      'NoJunk', 'JunkRecorded', '$NotPhishing', '$has_cal', '$has_note', '$ATTACHMENT', '$ENCRYPTED',
      '$ERROR', '$IGNORED', '$INVITATION', '$QUEUED', '$REPLIED', '$SENT', '$SIGNED', '$TODO',
      '$WATCHED', '$pinned', '$readreceipt', '$notdelivered', '$restored', '$snoozed', '$SieveFailed',
    ];
    for (const keyword of markers) expect(isSystemKeyword(keyword)).toBe(true);
    expect(tagKeywordsOf(JSON.stringify(Object.fromEntries([...markers, 'receipts'].map((k) => [k, true])))))
      .toEqual(['receipts']);
  });

  it('keeps label keywords and lookalikes of system keywords as tags', () => {
    expect(tagKeywordsOf('{"$label1":true,"$labelwork":true,"$label:q3":true,"important":true,"seen":true,"junkmail":true,"sent":true}'))
      .toEqual(['$label1', '$labelwork', '$label:q3', 'important', 'seen', 'junkmail', 'sent']);
  });
});

describe('tags defined over system keywords', () => {
  const definitions = [
    { keyword: 'work', name: 'Work', color: '#FF9900', order: 3 },
    { keyword: 'nonjunk', name: 'Not junk', color: '#009900', order: 0 },
    { keyword: '$Todo', name: 'To Do', color: '#3333FF', order: 1 },
    { keyword: '$seen', name: 'Read', color: '#FF0000', order: 2 },
  ];

  it('shows a hidden keyword once a definition names it, but never a reserved one', () => {
    const json = '{"NonJunk":true,"$TODO":true,"$seen":true,"$muted":true,"work":true}';
    expect(tagKeywordsOf(json)).toEqual(['work']);
    expect(tagKeywordsOf(json, definitions)).toEqual(['nonjunk', '$todo', 'work']);
    expect(resolveMessageTags(json, definitions).map((tag) => [tag.keyword, tag.name])).toEqual([
      ['nonjunk', 'Not junk'], ['$todo', 'To Do'], ['work', 'Work'],
    ]);
    expect(tagPresenceIndex([{ keywords_json: json }], definitions).presence('$Todo')).toBe('all');
  });

  it('applies the same rule to single keywords', () => {
    expect(isReservedKeyword('$Seen')).toBe(true);
    expect(isReservedKeyword('nonjunk')).toBe(false);
    expect(isTagKeyword('receipts')).toBe(true);
    expect(isTagKeyword('nonjunk')).toBe(false);
    expect(isTagKeyword('NonJunk', definitions)).toBe(true);
    expect(isTagKeyword('$seen', definitions)).toBe(false);
  });

  it('offers every definition except those over reserved keywords, in order', () => {
    expect(isMessageTagDefinitionList(definitions)).toBe(true);
    expect(visibleTagDefinitions(definitions).map((d) => d.keyword)).toEqual(['nonjunk', '$Todo', 'work']);
  });
});

describe('resolveTag / resolveMessageTags (MK-6.5)', () => {
  const definitions = [
    { keyword: 'work', name: 'Work', color: '#FF9900', order: 1 },
    { keyword: 'todo', name: 'To Do', color: '#3333FF', order: 0 },
  ];

  it('uses the definition when one exists and a neutral tag otherwise', () => {
    expect(resolveTag('WORK', definitions)).toEqual({
      keyword: 'work', name: 'Work', color: '#FF9900', defined: true,
    });
    expect(resolveTag('receipts', definitions)).toEqual({
      keyword: 'receipts', name: 'receipts', color: null, defined: false,
    });
  });

  it('lists defined tags in definition order, then undefined keywords', () => {
    const tags = resolveMessageTags('{"receipts":true,"work":true,"todo":true,"$seen":true}', definitions);
    expect(tags.map((t) => t.keyword)).toEqual(['todo', 'work', 'receipts']);
    expect(tags[2]).toMatchObject({ defined: false, color: null });
  });

  it('sorts definitions by order, then name', () => {
    expect(sortTagDefinitions(definitions).map((d) => d.keyword)).toEqual(['todo', 'work']);
  });
});

describe('messageTags setting', () => {
  it('preserves imported RFC-valid keywords beyond the generated-key limit', () => {
    for (const length of [129, 255]) {
      const tags = [...DEFAULT_MESSAGE_TAGS, { keyword: 'x'.repeat(length), name: 'Imported', color: '#123456', order: 5 }];
      expect(isMessageTagDefinitionList(tags)).toBe(true);
      expect(resolveSetting('messageTags', tags)).toEqual(tags);
    }
    expect(isMessageTagDefinitionList([{ keyword: 'x'.repeat(256), name: 'Invalid', color: '#123456', order: 0 }])).toBe(false);
  });
  it('defaults to the five Thunderbird tags (MK-6.1)', () => {
    expect(SETTING_DEFAULTS.messageTags).toEqual(DEFAULT_MESSAGE_TAGS);
    expect(DEFAULT_MESSAGE_TAGS.map((d) => [d.keyword, d.name, d.color])).toEqual([
      ['$label1', 'Important', '#FF0000'],
      ['$label2', 'Work', '#FF9900'],
      ['$label3', 'Personal', '#009900'],
      ['$label4', 'To Do', '#3333FF'],
      ['$label5', 'Later', '#993399'],
    ]);
  });

  it('accepts a well-formed list and rejects malformed entries, duplicates and overflow', () => {
    const good = [{ keyword: 'work', name: 'Work', color: '#ff9900', order: 0 }];
    expect(isMessageTagDefinitionList(good)).toBe(true);
    expect(isMessageTagDefinitionList([])).toBe(true);
    expect(isMessageTagDefinitionList([{ ...good[0], keyword: 'has space' }])).toBe(false);
    expect(isMessageTagDefinitionList([{ ...good[0], name: '  ' }])).toBe(false);
    expect(isMessageTagDefinitionList([{ ...good[0], color: 'red' }])).toBe(false);
    expect(isMessageTagDefinitionList([{ ...good[0], order: Number.NaN }])).toBe(false);
    expect(isMessageTagDefinitionList([good[0], { ...good[0], keyword: 'WORK' }])).toBe(false);
    expect(isMessageTagDefinitionList(
      Array.from({ length: MAX_TAG_DEFINITIONS + 1 }, (_, i) => ({ ...good[0], keyword: `t${i}` })),
    )).toBe(false);
    expect(isMessageTagDefinitionList('nope')).toBe(false);
  });

  it('falls back to the defaults for an invalid synced value', () => {
    expect(resolveSetting('messageTags', [{ keyword: 'bad key' }])).toEqual(DEFAULT_MESSAGE_TAGS);
    const good = [{ keyword: 'work', name: 'Work', color: '#ff9900', order: 0 }];
    expect(resolveSetting('messageTags', good)).toBe(good);
  });
});
