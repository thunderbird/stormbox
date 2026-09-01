import { describe, expect, it, vi } from 'vitest';

import { pageCompleteQuery } from '../../../src/sync/backends/jmap/query-paging';

describe('pageCompleteQuery', () => {
  it('follows a stable query to its reported total', async () => {
    const pages = [
      { ids: ['a', 'b'], position: 0, limit: 2, total: 3, queryState: 'q1' },
      { ids: ['c'], position: 2, limit: 2, total: 3, queryState: 'q1' },
    ];
    const visited: string[] = [];

    const result = await pageCompleteQuery({
      pageSize: 5,
      readPage: async ({ page }) => ({ ...pages[page], value: null }),
      visitPage: ({ ids }) => {
        visited.push(...ids as string[]);
      },
    });

    expect(result).toMatchObject({
      complete: true,
      pages: 2,
      position: 3,
      queryState: 'q1',
      total: 3,
      stableQueryState: true,
    });
    expect(visited).toEqual(['a', 'b', 'c']);
  });

  it('rejects drift before visiting the changed page', async () => {
    const visitPage = vi.fn();

    const result = await pageCompleteQuery({
      pageSize: 1,
      readPage: async ({ page, position }) => ({
        ids: [`id-${page}`],
        position,
        total: 2,
        queryState: `q${page}`,
        value: null,
      }),
      visitPage,
    });

    expect(result).toMatchObject({
      complete: false,
      reason: 'queryStateChanged',
      pages: 2,
      position: 1,
    });
    expect(visitPage).toHaveBeenCalledTimes(1);
  });

  it('allows an unstated query state only when the caller opts in', async () => {
    const readPage = async ({ position }: { position: number }) => ({
      ids: [String(position)],
      position,
      total: 2,
      queryState: null,
      value: null,
    });

    await expect(pageCompleteQuery({
      pageSize: 1,
      readPage,
      visitPage: () => {},
    })).resolves.toMatchObject({
      complete: false,
      reason: 'queryStateMissing',
    });

    await expect(pageCompleteQuery({
      pageSize: 1,
      readPage,
      visitPage: () => {},
      allowMissingQueryState: true,
    })).resolves.toMatchObject({
      complete: true,
      position: 2,
      stableQueryState: false,
    });
  });

  it('reports a query that stops before its total', async () => {
    await expect(pageCompleteQuery({
      pageSize: 2,
      readPage: async ({ position }) => ({
        ids: position === 0 ? ['a'] : [],
        position,
        total: 2,
        queryState: 'q1',
        value: null,
      }),
      visitPage: () => {},
    })).resolves.toMatchObject({
      complete: false,
      reason: 'truncated',
      position: 1,
    });
  });
});
