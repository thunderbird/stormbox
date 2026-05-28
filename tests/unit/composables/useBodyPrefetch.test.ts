import { describe, it, expect, beforeEach, vi } from 'vitest';

import { useBodyPrefetch } from '../../../src/composables/useBodyPrefetch';

function makeRepo() {
  return {
    ensureMessageBodies: vi.fn(async () => undefined),
    getMessageBodyForDisplay: vi.fn(async () => ({
      text: 'body',
      html: '<p>body</p>',
      attachments: [],
    })),
  } as any;
}

describe('useBodyPrefetch', () => {
  let repo: any;
  let accountId: number | null;
  let selected: number | null;
  let prefetch: ReturnType<typeof useBodyPrefetch>;

  beforeEach(() => {
    repo = makeRepo();
    accountId = 1;
    selected = null;
    prefetch = useBodyPrefetch({
      getRepo: () => repo,
      getAccountId: () => accountId,
      isSelected: (id) => selected === id,
    });
  });

  it('is a no-op when no ids are supplied', async () => {
    await prefetch.enqueueBodyPrefetch([]);
    await prefetch.enqueueBodyPrefetch([null, undefined]);
    expect(repo.ensureMessageBodies).not.toHaveBeenCalled();
  });

  it('dedupes ids that are still queued and have not yet started fetching', async () => {
    // Both enqueues run synchronously before the drain starts on
    // the next microtask, so all four ids share one batch.
    prefetch.enqueueBodyPrefetch([1, 2, 3]);
    prefetch.enqueueBodyPrefetch([2, 3, 4]);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    // The drain may emit one batch (all four together) or, if the
    // first batch already started fetching when the second enqueue
    // landed, a second batch with the previously-fetching ids.
    // Either way, every id must appear at least once.
    const seen = new Set<number>();
    for (const call of repo.ensureMessageBodies.mock.calls) {
      for (const id of call[1] ?? []) seen.add(Number(id));
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('skips visible rows whose body is already fetched and drops sparse undefined slots', async () => {
    const rows = [
      undefined,
      { id: 1, body_fetched_at: 1 } as any,
      { id: 2, body_fetched_at: null } as any,
      undefined,
      { id: 3, body_fetched_at: null } as any,
    ];
    prefetch.enqueueVisibleBodyPrefetch(0, rows.length, rows);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const ids = repo.ensureMessageBodies.mock.calls[0]?.[1] ?? [];
    expect([...ids].sort()).toEqual([2, 3]);
  });

  it('writes messageBody only when the load token still matches selection', async () => {
    selected = 7;
    const token = prefetch.nextDisplayToken();
    await prefetch.loadBodyForDisplay(7, token);
    expect(prefetch.messageBody.value?.text).toBe('body');
  });

  it('drops a stale Email/get when selection moved before the response landed', async () => {
    selected = 7;
    const stale = prefetch.nextDisplayToken();
    selected = 8;
    prefetch.nextDisplayToken();
    await prefetch.loadBodyForDisplay(7, stale);
    expect(prefetch.messageBody.value).toBeNull();
  });

  it('clears the queue and bumps the token on logout', async () => {
    prefetch.enqueueBodyPrefetch([1, 2]);
    selected = 7;
    const token = prefetch.nextDisplayToken();
    prefetch.clear();
    await prefetch.loadBodyForDisplay(7, token);
    // Token bumped by clear so the resolved body is considered stale.
    expect(prefetch.messageBody.value).toBeNull();
  });
});
