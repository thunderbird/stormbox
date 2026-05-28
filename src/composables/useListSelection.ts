/**
 * Anchored list-selection composable, Fastmail/Overture interaction
 * model.
 *
 *   - "Viewing" and "selected" are two separate concepts. A row can
 *     be viewed (focused) without being checked, and a row can be
 *     checked without being viewed. The "focused" pointer is owned
 *     elsewhere (the mail-store's selectedMessageId); this composable
 *     owns only the multi-select Set and the anchor for range
 *     extensions.
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

import { computed, ref } from 'vue';

/**
 * @typedef {object} UseListSelectionOptions
 * @property {import('vue').Ref<Array<{id:unknown}|undefined>>} rows
 * @property {import('vue').Ref<number>} total
 * @property {import('vue').Ref<Set<unknown>>} [selectedIds]
 *   Optional externally-owned selection set (mail-store).
 * @property {import('vue').Ref<number>} [focusedIndex]
 *   Optional externally-owned focused/viewing index. When the caller
 *   keeps `focusedIndex` in a Pinia store so MessageView can read it,
 *   pass the same ref here so the composable updates it on arrow
 *   nav. If omitted, the composable owns a local ref that the caller
 *   reads back via the returned `focusedIndex`.
 */

export function useListSelection({
  rows,
  total,
  selectedIds: externalSelectedIds,
  focusedIndex: externalFocusedIndex,
}: {
  rows: any;
  total: any;
  selectedIds?: any;
  focusedIndex?: any;
}) {
  const selectedIds = externalSelectedIds ?? ref(new Set());
  const focusedIndex = externalFocusedIndex ?? ref(-1);
  const anchorIndex = ref(-1);

  const selectionCount = computed(() => selectedIds.value.size);
  const hasSelection = computed(() => selectionCount.value > 0);

  function _bump() {
    selectedIds.value = new Set(selectedIds.value);
  }

  function isSelected(id) {
    return id != null && selectedIds.value.has(id);
  }

  function _idAt(index) {
    const row = rows.value[index];
    return row?.id ?? null;
  }

  /**
   * Move the focused/viewing pointer. Does NOT touch the selection.
   * Returns the id at the new focused index (or null if it's a
   * placeholder).
   */
  function setFocused(index) {
    if (index < 0 || index >= rows.value.length) return null;
    focusedIndex.value = index;
    return _idAt(index);
  }

  /**
   * Toggle membership of a single row in the selection set. Updates
   * the anchor (the next shift-click will pivot off this row). Does
   * NOT change `focusedIndex` — Fastmail's checkbox doesn't move the
   * viewer.
   */
  function toggleAt(index) {
    const id = _idAt(index);
    if (id == null) return;
    if (selectedIds.value.has(id)) {
      selectedIds.value.delete(id);
    } else {
      selectedIds.value.add(id);
    }
    anchorIndex.value = index;
    _bump();
  }

  /**
   * Replace the selection with the range from anchor to `index`. If
   * there's no anchor yet, the click itself becomes the anchor (so a
   * subsequent shift-click has something to pivot off of). The
   * anchor is NOT moved by a shift-click — this matches Gmail/Apple
   * Mail/Fastmail and lets a shrinking shift-click correctly drop the
   * tail of the prior range.
   */
  function extendRange(index, fallbackAnchorIndex = index) {
    if (index < 0 || index >= rows.value.length) return;
    const hadAnchor = anchorIndex.value >= 0;
    const fallback = Number.isFinite(fallbackAnchorIndex) ? fallbackAnchorIndex : index;
    const anchor = hadAnchor ? anchorIndex.value : Math.max(0, Math.min(rows.value.length - 1, fallback));
    const lo = Math.min(index, anchor);
    const hi = Math.max(index, anchor) + 1;
    const next = new Set();
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
  function handleCheckboxClick(index, event, fallbackAnchorIndex = index) {
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
  function handleKeyDown(event) {
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
        focusedIndex.value = next;
      } else {
        focusedIndex.value = next;
      }
      result.consumed = true;
      result.focusChanged = true;
      result.focusedId = _idAt(next);
      return result;
    }
    return result;
  }

  function selectAllLoaded() {
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

  function selectNone() {
    if (selectedIds.value.size === 0) return;
    selectedIds.value = new Set();
    anchorIndex.value = -1;
  }

  function pruneRemoved(removedIds) {
    if (!removedIds) return 0;
    const next = new Set(selectedIds.value);
    let removed = 0;
    for (const id of removedIds) {
      if (next.delete(id)) removed += 1;
    }
    if (removed) selectedIds.value = next;
    return removed;
  }

  function retainOnly(allowedIds) {
    const allow = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
    const next = new Set();
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
