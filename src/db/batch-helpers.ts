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
