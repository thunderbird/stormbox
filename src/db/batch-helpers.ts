/**
 * Shared helpers for bounded batch writes in the SQLite worker.
 *
 * The intended shape is: one protocol page/chunk, one SQLite
 * transaction, one coalesced broadcast. Helpers in this file keep the
 * repeated SQL mechanics consistent across outbox apply, query-view
 * deltas, sync cleanup, and body/message persistence.
 */

export function numericUnique(values: any[] = []): number[] {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(Number)
      .filter((value) => Number.isFinite(value)),
  )];
}

export function placeholdersFor(values: any[]): string {
  return values.map(() => '?').join(',');
}

export function batchResult(applied = 0, extra: Record<string, any> = {}) {
  return { ok: true, applied, ...extra };
}

interface PlaceInViewInput {
  viewId: number;
  sortJson: string | null;
  /** The view's total before this message is counted. */
  total: number;
  accountId: number;
  messageId: number;
  remoteId: string;
  ts: number;
}

interface ViewRange {
  start: number;
  end: number;
  fetchedAt: number;
}

async function readViewRanges(tx: any, viewId: number): Promise<ViewRange[]> {
  const rows = await tx.all(
    `SELECT start_position, end_position, fetched_at
       FROM query_view_ranges
      WHERE view_id = ?
      ORDER BY start_position, end_position`,
    [viewId],
  );
  return rows.map((row) => ({
    start: Number(row.start_position),
    end: Number(row.end_position),
    fetchedAt: Number(row.fetched_at),
  }));
}

/** Replace a view's ranges; empty and duplicate ranges are dropped. */
async function writeViewRanges(tx: any, viewId: number, ranges: ViewRange[]): Promise<void> {
  await tx.run('DELETE FROM query_view_ranges WHERE view_id = ?', [viewId]);
  const seen = new Set<string>();
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    const key = `${range.start}-${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await tx.run(
      `INSERT INTO query_view_ranges(view_id, start_position, end_position, fetched_at)
       VALUES (?, ?, ?, ?)`,
      [viewId, range.start, range.end, range.fetchedAt],
    );
  }
}

/**
 * Keep the fetched ranges aligned with the items after one item was
 * inserted at `position`: a range holding that position grows by one,
 * a range entirely after it moves down by one. A position no range
 * covers gets a one-item range of its own so coverage counts it.
 */
export async function shiftViewRangesForInsert(
  tx: any,
  viewId: number,
  position: number,
  ts: number,
): Promise<void> {
  const ranges = await readViewRanges(tx, viewId);
  let contained = false;
  const next = ranges.map((range) => {
    if (range.start <= position && position <= range.end) {
      contained = true;
      return { ...range, end: range.end + 1, fetchedAt: ts };
    }
    if (range.start > position) {
      return { ...range, start: range.start + 1, end: range.end + 1 };
    }
    return range;
  });
  if (!contained) next.push({ start: position, end: position + 1, fetchedAt: ts });
  await writeViewRanges(tx, viewId, next);
}

/**
 * Keep the fetched ranges aligned with the items after the items at
 * `positions` (as they were before compaction) were removed: a range
 * shrinks by the removed positions inside it and moves up by the ones
 * before it.
 */
export async function shiftViewRangesForRemovals(
  tx: any,
  viewId: number,
  positions: number[],
): Promise<void> {
  const removed = numericUnique(positions).sort((a, b) => a - b);
  if (removed.length === 0) return;
  const ranges = await readViewRanges(tx, viewId);
  const before = (position: number) => removed.filter((p) => p < position).length;
  const next = ranges.map((range) => {
    const inside = removed.filter((p) => p >= range.start && p < range.end).length;
    const shift = before(range.start);
    return { ...range, start: range.start - shift, end: range.end - shift - inside };
  });
  await writeViewRanges(tx, viewId, next);
}

/**
 * Length of the contiguous fetched prefix [0, n) of a view's ranges.
 */
async function fetchedPrefixEnd(tx: any, viewId: number): Promise<number> {
  const ranges = await tx.all(
    `SELECT start_position, end_position
       FROM query_view_ranges
      WHERE view_id = ?
      ORDER BY start_position, end_position`,
    [viewId],
  );
  let end = 0;
  for (const range of ranges) {
    const start = Number(range.start_position);
    const rangeEnd = Number(range.end_position);
    if (start > end) break;
    end = Math.max(end, rangeEnd);
  }
  return end;
}

/**
 * Insert a message that just joined a folder into that folder's cached
 * mailbox-window view at its sorted position, so the view repaints from
 * SQLite without a server round trip. Placement is only certain inside
 * the fetched prefix of the view: the message goes before the first
 * cached item that sorts after it, or at the end when the whole view is
 * cached. Returns false when the position cannot be known (the sort key
 * falls past the fetched prefix, or a cached item lacks its message row);
 * the caller then marks the view stale as before.
 */
export async function placeMessageInQueryView(tx: any, input: PlaceInViewInput): Promise<boolean> {
  const {
    viewId, sortJson, total, accountId, messageId, remoteId, ts,
  } = input;
  let sort: { property?: string; isAscending?: boolean };
  try {
    sort = JSON.parse(sortJson ?? '[]')?.[0] ?? {};
  } catch {
    return false;
  }
  const column = sort.property === 'sentAt' ? 'sent_at' : 'received_at';
  if (sort.property != null && sort.property !== 'sentAt' && sort.property !== 'receivedAt') {
    return false;
  }
  const ascending = sort.isAscending === true;
  const message = await tx.get(
    `SELECT ${column} AS sort_value FROM messages WHERE account_id = ? AND id = ?`,
    [accountId, messageId],
  );
  const value = Number(message?.sort_value);
  if (!Number.isFinite(value)) return false;

  const prefixEnd = await fetchedPrefixEnd(tx, viewId);
  const items = await tx.all(
    `SELECT qi.position, m.${column} AS sort_value
       FROM query_view_items qi
       LEFT JOIN messages m
         ON m.account_id = ? AND m.remote_id = qi.remote_id
      WHERE qi.view_id = ? AND qi.remote_id != ?
      ORDER BY qi.position`,
    [accountId, viewId, remoteId],
  );
  const cachedAll = prefixEnd >= total && items.length >= total;
  let position: number | null = null;
  for (const item of items) {
    const itemPosition = Number(item.position);
    if (itemPosition >= prefixEnd) break;
    const itemValue = Number(item.sort_value);
    if (!Number.isFinite(itemValue)) return false;
    // The server's order among equal keys is not known here; only a
    // strict comparison places with certainty.
    if (itemValue === value) return false;
    const sortsAfter = ascending ? itemValue > value : itemValue < value;
    if (sortsAfter) {
      position = itemPosition;
      break;
    }
  }
  if (position == null) {
    if (!cachedAll && total > 0) return false;
    position = items.length > 0 ? Number(items[items.length - 1].position) + 1 : 0;
  }

  // The same remote id can already sit in the view (a stale copy); the
  // fresh position wins.
  const existing = await tx.get(
    `SELECT position FROM query_view_items WHERE view_id = ? AND remote_id = ?`,
    [viewId, remoteId],
  );
  if (existing) {
    const oldPosition = Number(existing.position);
    await tx.run(
      `DELETE FROM query_view_items WHERE view_id = ? AND remote_id = ?`,
      [viewId, remoteId],
    );
    await tx.run(
      `UPDATE query_view_items SET position = position - 1 WHERE view_id = ? AND position > ?`,
      [viewId, oldPosition],
    );
    await shiftViewRangesForRemovals(tx, viewId, [oldPosition]);
    if (oldPosition < position) position -= 1;
  }
  // Park the tail in negative space so the shift never trips UNIQUE(view_id, position).
  await tx.run(
    `UPDATE query_view_items SET position = -position - 1 WHERE view_id = ? AND position >= ?`,
    [viewId, position],
  );
  await tx.run(
    `INSERT INTO query_view_items(view_id, position, message_id, remote_id) VALUES (?, ?, ?, ?)`,
    [viewId, position, messageId, remoteId],
  );
  await tx.run(
    `UPDATE query_view_items SET position = -position WHERE view_id = ? AND position < 0`,
    [viewId],
  );
  await shiftViewRangesForInsert(tx, viewId, position, ts);
  return true;
}

export async function compactViewAfterDeletingPositions(
  tx: any,
  viewId: number,
  positions: number[],
  ts: number,
  { updateTotal = true } = {},
) {
  const removedPositions = numericUnique(positions).sort((a, b) => a - b);
  if (removedPositions.length === 0) return { removed: 0 };
  const minPosition = removedPositions[0];
  const positionOffset = 1_000_000_000;

  // Move surviving rows out of the UNIQUE(view_id, position) range,
  // then compact them back in one pass. This avoids one UPDATE per
  // removed row and avoids transient unique-index conflicts.
  await tx.run(
    `UPDATE query_view_items
        SET position = position + ?
      WHERE view_id = ? AND position > ?`,
    [positionOffset, viewId, minPosition],
  );
  await tx.run(
    `WITH removed(pos) AS (VALUES ${removedPositions.map(() => '(?)').join(',')})
     UPDATE query_view_items
        SET position = position - ? - (
          SELECT COUNT(*) FROM removed
           WHERE removed.pos < query_view_items.position - ?
        )
      WHERE view_id = ? AND position > ?`,
    [
      ...removedPositions,
      positionOffset,
      positionOffset,
      viewId,
      minPosition + positionOffset,
    ],
  );
  await shiftViewRangesForRemovals(tx, viewId, removedPositions);
  if (updateTotal) {
    await tx.run(
      `UPDATE query_views
          SET total = MAX(0, COALESCE(total, 0) - ?),
              updated_at = ?
        WHERE id = ?`,
      [removedPositions.length, ts, viewId],
    );
  }
  return { removed: removedPositions.length };
}
