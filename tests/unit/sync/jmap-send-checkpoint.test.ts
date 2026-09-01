import { describe, expect, it } from 'vitest';

import {
  makeMessageId,
  newCheckpoint,
  readCheckpoint,
} from '../../../src/sync/backends/jmap/send-checkpoint';

function idRight(messageId: string): string {
  const match = messageId.match(/@([^>]*)>$/);
  if (!match) throw new Error(`Invalid Message-ID: ${messageId}`);
  return match[1];
}

describe('makeMessageId', () => {
  it('keeps a valid ASCII identity domain', () => {
    expect(idRight(makeMessageId('sender@example.com'))).toBe('example.com');
  });

  it('IDNA-normalizes an internationalized identity domain', () => {
    expect(idRight(makeMessageId('sender@bücher.example')))
      .toBe('xn--bcher-kva.example');
  });

  it('keeps a valid domain literal', () => {
    expect(idRight(makeMessageId('sender@[127.0.0.1]'))).toBe('[127.0.0.1]');
  });

  it.each([
    'sender@bad domain',
    'sender@example..com',
    'sender@example.com:443',
    'sender@example.com>',
    'not-an-address',
  ])('falls back for the malformed identity domain in %s', (identity) => {
    expect(idRight(makeMessageId(identity))).toBe('localhost');
  });

  it('does not let URL parsing discard a suffix from an internationalized domain', () => {
    expect(idRight(makeMessageId('sender@bücher.example/path'))).toBe('localhost');
  });
});

describe('newCheckpoint', () => {
  it('keeps every well-formed draft id and drops the rest', () => {
    // The writer must not discard the whole list over one bad entry:
    // an empty list would let post-send cleanup skip real draft copies.
    const checkpoint = newCheckpoint('sender@example.com', ['a', '', 'a', 42, 'b']);
    expect(checkpoint.pendingDraftDestroyIds).toEqual(['a', 'b']);
  });

  it.each([
    [undefined],
    [null],
    ['a'],
    [{ id: 'a' }],
  ])('records no pending draft ids for %p', (value) => {
    expect(newCheckpoint('sender@example.com', value).pendingDraftDestroyIds).toEqual([]);
  });
});

describe('readCheckpoint', () => {
  function rowWith(pendingDraftDestroyIds: unknown) {
    return {
      server_response_json: JSON.stringify({
        operationId: 'op-1',
        messageId: '<op-1@example.com>',
        pendingDraftDestroyIds,
      }),
    };
  }

  it('accepts a persisted list of distinct ids', () => {
    expect(readCheckpoint(rowWith(['a', 'b']))).toMatchObject({
      operationId: 'op-1',
      pendingDraftDestroyIds: ['a', 'b'],
    });
  });

  it.each([
    [['a', 'a']],
    [['a', '']],
    [['a', 42]],
  ])('rejects a persisted checkpoint whose draft ids are %j', (ids) => {
    expect(readCheckpoint(rowWith(ids))).toBeNull();
  });
});
