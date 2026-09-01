export interface CompleteQueryPage<T> {
  ids: readonly unknown[];
  queryState: string | null;
  total: number | null;
  position?: number | null;
  limit?: number | null;
  value: T;
}

export interface CompleteQueryCursor {
  page: number;
  position: number;
  limit: number;
}

export type CompleteQueryFailureReason =
  | 'queryStateChanged'
  | 'queryStateMissing'
  | 'queryTotalChanged'
  | 'cursorStalled'
  | 'positionPastTotal'
  | 'truncated'
  | 'pageLimitReached';

interface CompleteQueryProgress {
  pages: number;
  position: number;
  queryState: string | null;
  total: number | null;
  stableQueryState: boolean;
}

export type CompleteQueryResult =
  | (CompleteQueryProgress & { complete: true })
  | (CompleteQueryProgress & {
    complete: false;
    reason: CompleteQueryFailureReason;
  });

interface PageCompleteQueryOptions<T> {
  pageSize: number;
  readPage: (cursor: CompleteQueryCursor) => Promise<CompleteQueryPage<T>>;
  visitPage: (
    page: CompleteQueryPage<T>,
    cursor: CompleteQueryCursor,
  ) => Promise<void> | void;
  startPosition?: number;
  maxPosition?: number;
  maxPages?: number;
  allowMissingQueryState?: boolean;
}

/**
 * Page one JMAP query result while keeping object-specific work at the caller.
 */
export async function pageCompleteQuery<T>({
  pageSize,
  readPage,
  visitPage,
  startPosition = 0,
  maxPosition = Number.POSITIVE_INFINITY,
  maxPages = Number.POSITIVE_INFINITY,
  allowMissingQueryState = false,
}: PageCompleteQueryOptions<T>): Promise<CompleteQueryResult> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError('pageSize must be a positive safe integer');
  }
  if (!Number.isSafeInteger(startPosition) || startPosition < 0) {
    throw new RangeError('startPosition must be a non-negative safe integer');
  }

  let position = startPosition;
  let pages = 0;
  let firstQueryState: string | null | undefined;
  let total: number | null = null;
  let stableQueryState = true;

  const progress = (): CompleteQueryProgress => ({
    pages,
    position,
    queryState: firstQueryState ?? null,
    total,
    stableQueryState,
  });
  const fail = (reason: CompleteQueryFailureReason): CompleteQueryResult => ({
    ...progress(),
    complete: false,
    reason,
  });

  while (position < maxPosition) {
    if (pages >= maxPages) return fail('pageLimitReached');
    const remaining = maxPosition - position;
    const limit = Number.isFinite(remaining)
      ? Math.min(pageSize, remaining)
      : pageSize;
    const cursor = { page: pages, position, limit };
    const page = await readPage(cursor);
    pages += 1;

    if (firstQueryState === undefined) {
      firstQueryState = page.queryState;
    } else if (page.queryState !== firstQueryState) {
      return fail('queryStateChanged');
    }

    if (page.total != null) {
      if (total == null) total = page.total;
      else if (page.total !== total) return fail('queryTotalChanged');
    }

    await visitPage(page, cursor);

    const pageStart = Number.isSafeInteger(page.position) && Number(page.position) >= 0
      ? Number(page.position)
      : position;
    const nextPosition = pageStart + page.ids.length;
    if (total != null && nextPosition > total) {
      return fail('positionPastTotal');
    }
    position = nextPosition;

    if (position >= maxPosition || (total != null && position === total)) {
      return { ...progress(), complete: true };
    }
    if (page.ids.length === 0) {
      if (total == null) return { ...progress(), complete: true };
      return fail('truncated');
    }

    const servedLimit = Number.isSafeInteger(page.limit) && Number(page.limit) > 0
      ? Math.min(limit, Number(page.limit))
      : limit;
    if (total == null && page.ids.length < servedLimit) {
      return { ...progress(), complete: true };
    }
    if (position <= cursor.position) return fail('cursorStalled');
    if (firstQueryState == null) {
      stableQueryState = false;
      if (!allowMissingQueryState) return fail('queryStateMissing');
    }
  }

  return { ...progress(), complete: true };
}
