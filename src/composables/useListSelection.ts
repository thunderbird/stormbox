/**
 * Anchored list-selection composable, Fastmail/Overture interaction
 * model.
 *
 *   - "Viewing" and "selected" are two separate concepts. A row can
 *     be viewed (focused) without being checked, and a row can be
 *     checked without being viewed. The keyboard cursor (the "focused"
 *     row) is an id passed in by the caller (the mail-store's
 *     focusedMessageId) so a scroll-follow watcher and other panes can
 *     read it; this composable derives the cursor's index and owns only
 *     the multi-select Set and the anchor for range extensions.
 *
 *   - Plain click on a row body  -> view (caller decides)
 *   - Plain click on a checkbox  -> toggle that row's membership
 *   - Shift+click on a checkbox  -> replace range from anchor to row
 *                                    (or from the visible top row if
 *                                    there is no anchor yet)
 *   - Cmd/Ctrl+A on the list     -> select all loaded rows
 *   - Esc                        -> clear selection
 *   - Space on focused row       -> toggle that row
 *   - Shift+Arrow                -> extend range from anchor
 *
 * Algorithm ported from Fastmail's Overture
 * (source/selection/SelectionController.js, MIT-licensed). The
 * critical detail Overture and Fastmail get right and naive multi-
 * select libs (e.g. vue-multiclick) get wrong: a shift-click rebuilds
 * the range from the anchor (clearing and re-applying), so clicking
 * back toward the anchor *shrinks* the selection.
 *
 * Sparse-rows aware: indices the caller hasn't loaded yet are
 * `undefined` and are skipped by range operations rather than
 * inserting `undefined` into the selection set.
 */

import {
  computed,
  ref,
  shallowRef,
  type Ref,
} from 'vue';

type SelectionRows<Row> = Readonly<Ref<readonly (Row | undefined)[]>>;

export interface UseListSelectionOptions<Row, Key> {
  focusedId?: Ref<Key | null>;
  getKey?: (row: Row) => Key | null | undefined;
  rows: SelectionRows<Row>;
  selectedIds?: Ref<Set<Key>>;
  total: Readonly<Ref<number>>;
}

interface ListSelectionKeyEvent {
  ctrlKey?: boolean;
  key: string;
  metaKey?: boolean;
  preventDefault: () => void;
  shiftKey?: boolean;
}

function defaultRowKey<Row, Key>(row: Row): Key | null {
  if (row == null || typeof row !== 'object' || !('id' in row)) return null;
  return (row as { id?: Key }).id ?? null;
}

export function useListSelection<Row, Key = unknown>(
  options: UseListSelectionOptions<Row, Key>,
) {
  const {
    rows,
    total,
    selectedIds: externalSelectedIds,
    focusedId: externalFocusedId,
  } = options;
  const getKey = options.getKey
    ?? ((row: Row) => defaultRowKey<Row, Key>(row));
  const selectedIds = externalSelectedIds ?? shallowRef(new Set<Key>());
  // Canonical cursor is an id; the index is derived. -1 when the cursor
  // is unset or its row isn't currently in `rows` (e.g. scrolled out of
  // a sparse window or filtered away).
  const focusedId = externalFocusedId ?? shallowRef<Key | null>(null);
  const focusedIndex = computed(() => (focusedId.value == null
    ? -1
    : rows.value.findIndex((row) =>
        row !== undefined && getKey(row) === focusedId.value)));
  const anchorIndex = ref(-1);

  const selectionCount = computed(() => selectedIds.value.size);
  const hasSelection = computed(() => selectionCount.value > 0);

  function isSelected(id: Key | null | undefined) {
    return id != null && selectedIds.value.has(id);
  }

  function _idAt(index: number): Key | null {
    const row = rows.value[index];
    return row === undefined ? null : getKey(row) ?? null;
  }

  /**
   * Move the focused/viewing pointer. Does NOT touch the selection.
   * Returns the id at the new focused index (or null if it's a
   * placeholder).
   */
  function setFocused(index: number): Key | null {
    if (index < 0 || index >= rows.value.length) return null;
    const id = _idAt(index);
    focusedId.value = id;
    return id;
  }

  /**
   * Toggle membership of a single row in the selection set. Updates
   * the anchor (the next shift-click will pivot off this row). Does
   * NOT change `focusedIndex` — Fastmail's checkbox doesn't move the
   * viewer.
   */
  function toggleAt(index: number): void {
    const id = _idAt(index);
    if (id == null) return;
    const next = new Set(selectedIds.value);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    anchorIndex.value = index;
    selectedIds.value = next;
  }

  /**
   * Replace the selection with the range from anchor to `index`. If
   * there's no anchor yet, the click itself becomes the anchor (so a
   * subsequent shift-click has something to pivot off of). The
   * anchor is NOT moved by a shift-click — this matches Gmail/Apple
   * Mail/Fastmail and lets a shrinking shift-click correctly drop the
   * tail of the prior range.
   */
  function extendRange(index: number, fallbackAnchorIndex = index): void {
    if (index < 0 || index >= rows.value.length) return;
    const hadAnchor = anchorIndex.value >= 0;
    const fallback = Number.isFinite(fallbackAnchorIndex) ? fallbackAnchorIndex : index;
    const anchor = hadAnchor ? anchorIndex.value : Math.max(0, Math.min(rows.value.length - 1, fallback));
    const lo = Math.min(index, anchor);
    const hi = Math.max(index, anchor) + 1;
    const next = new Set<Key>();
    const upper = Math.min(rows.value.length, hi);
    for (let i = Math.max(0, lo); i < upper; i += 1) {
      const id = _idAt(i);
      if (id != null) next.add(id);
    }
    selectedIds.value = next;
    if (!hadAnchor) anchorIndex.value = anchor;
  }

  /**
   * Click handler for a checkbox. Shift-click extends the range from
   * the anchor; everything else just toggles.
   */
  function handleCheckboxClick(
    index: number,
    event: { shiftKey?: boolean } | null | undefined,
    fallbackAnchorIndex = index,
  ): void {
    if (event && event.shiftKey) {
      extendRange(index, fallbackAnchorIndex);
    } else {
      toggleAt(index);
    }
  }

  /**
   * Keyboard handler. Bind to the list container with tabindex="0".
   *
   * Returns an object describing what happened so the caller can
   * react (e.g. to drive the preview pane on plain Arrow moves):
   *   { consumed: bool, focusChanged: bool, focusedId: id|null }
   */
  function handleKeyDown(event: ListSelectionKeyEvent) {
    const meta = event.metaKey || event.ctrlKey;
    const len = rows.value.length;
    const result = { consumed: false, focusChanged: false, focusedId: null };

    if (meta && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      selectAllLoaded();
      result.consumed = true;
      return result;
    }
    if (event.key === 'Escape') {
      if (hasSelection.value) {
        event.preventDefault();
        selectNone();
        result.consumed = true;
        return result;
      }
      return result;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      // Space toggles the focused row's selection. We deliberately
      // require a focused row first — otherwise Space would be a
      // no-op alias for selectAll, which is confusing.
      if (focusedIndex.value >= 0) {
        event.preventDefault();
        toggleAt(focusedIndex.value);
        result.consumed = true;
      }
      return result;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!len) return result;
      event.preventDefault();
      const dir = event.key === 'ArrowDown' ? 1 : -1;
      // Origin priority: explicit focus > anchor (so Shift+Arrow after
      // a checkbox click extends from the just-checked row) >
      // boundary. This mirrors Apple Mail / Fastmail / Thunderbird
      // keyboard behavior — the user expects Shift+Down to add the
      // next row to the existing selection, not jump to the top.
      let from;
      if (focusedIndex.value >= 0) {
        from = focusedIndex.value;
      } else if (anchorIndex.value >= 0) {
        from = anchorIndex.value;
      } else {
        from = dir > 0 ? -1 : len;
      }
      const next = Math.max(0, Math.min(len - 1, from + dir));
      if (event.shiftKey) {
        extendRange(next);
      }
      // Move the cursor by id. On plain nav the caller also routes this
      // id through selectMessage (which writes the same store ref); on
      // Shift+Arrow this is the only write, so the cursor advances while
      // the previewed message stays put.
      focusedId.value = _idAt(next);
      result.consumed = true;
      result.focusChanged = true;
      result.focusedId = _idAt(next);
      return result;
    }
    return result;
  }

  function selectAllLoaded(): void {
    const upper = Math.min(rows.value.length, total.value || rows.value.length);
    const next = new Set(selectedIds.value);
    let changed = 0;
    for (let i = 0; i < upper; i += 1) {
      const id = _idAt(i);
      if (id != null && !next.has(id)) {
        next.add(id);
        changed += 1;
      }
    }
    if (changed) selectedIds.value = next;
    if (upper > 0) anchorIndex.value = 0;
  }

  function selectNone(): void {
    if (selectedIds.value.size > 0) selectedIds.value = new Set<Key>();
    anchorIndex.value = -1;
  }

  function pruneRemoved(removedIds: Iterable<Key> | null | undefined): number {
    if (!removedIds) return 0;
    const next = new Set(selectedIds.value);
    let removed = 0;
    for (const id of removedIds) {
      if (next.delete(id)) removed += 1;
    }
    if (removed) selectedIds.value = next;
    return removed;
  }

  function retainOnly(allowedIds: Iterable<Key>): number {
    const allow = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
    const next = new Set<Key>();
    let removed = 0;
    for (const id of selectedIds.value) {
      if (allow.has(id)) {
        next.add(id);
      } else {
        removed += 1;
      }
    }
    if (removed) selectedIds.value = next;
    return removed;
  }

  return {
    selectedIds,
    anchorIndex,
    focusedId,
    focusedIndex,
    selectionCount,
    hasSelection,
    isSelected,
    setFocused,
    toggleAt,
    extendRange,
    handleCheckboxClick,
    handleKeyDown,
    selectAllLoaded,
    selectNone,
    pruneRemoved,
    retainOnly,
  };
}
