/**
 * Unit tests for the anchored list-selection composable.
 *
 * The composable models the Fastmail interaction split where
 * "viewing" (the focused/previewed row) and "selecting" (the
 * checkbox membership set) are independent state. These tests pin
 * down the algorithm — the anchor/range/shrink semantics ported from
 * Overture, the Space-to-toggle keyboard contract, and the
 * sparse-rows behavior that matters for the virtualized message
 * list.
 */

import { describe, it, expect } from 'vitest';
import { ref } from 'vue';

import { useListSelection } from '../../../src/composables/use-list-selection.js';

function makeRows(count: number, { holes = [] as number[] } = {}) {
  const out: Array<{ id: string } | undefined> = [];
  for (let i = 0; i < count; i += 1) {
    out.push(holes.includes(i) ? undefined : { id: `m${i}` });
  }
  return out;
}

function makeHarness(count: number, opts?: { holes?: number[] }) {
  const rows = ref(makeRows(count, opts));
  const total = ref(count);
  const selectedIds = ref(new Set<string>());
  const sel = useListSelection({ rows, total, selectedIds });
  return { rows, total, selectedIds, sel };
}

function ids(set: Set<unknown>) {
  return [...set].sort();
}

function noop() {}

describe('useListSelection', () => {
  describe('setFocused (view-only click)', () => {
    it('moves the focused pointer without selecting', () => {
      const { sel, selectedIds } = makeHarness(5);
      const id = sel.setFocused(2);
      expect(id).toBe('m2');
      expect(sel.focusedIndex.value).toBe(2);
      expect(selectedIds.value.size).toBe(0);
    });

    it('returns null for a sparse/placeholder slot and leaves focus alone for OOB', () => {
      const { sel } = makeHarness(4, { holes: [2] });
      // Placeholder index returns null id; focus still moves so the
      // user can arrow past it. This mirrors how arrow-nav lands on
      // an unloaded slot and waits for hydration.
      const placeholderId = sel.setFocused(2);
      expect(placeholderId).toBeNull();
      // Out-of-bounds index is rejected entirely.
      const oobId = sel.setFocused(99);
      expect(oobId).toBeNull();
    });
  });

  describe('toggleAt (checkbox click)', () => {
    it('adds and removes a row, updating the anchor', () => {
      const { sel, selectedIds } = makeHarness(5);
      sel.toggleAt(1);
      expect(ids(selectedIds.value)).toEqual(['m1']);
      expect(sel.anchorIndex.value).toBe(1);
      sel.toggleAt(3);
      expect(ids(selectedIds.value)).toEqual(['m1', 'm3']);
      expect(sel.anchorIndex.value).toBe(3);
      sel.toggleAt(1);
      expect(ids(selectedIds.value)).toEqual(['m3']);
    });

    it('does not move the focused pointer', () => {
      // Fastmail's checkbox click and the row body click are
      // genuinely orthogonal — toggling the checkbox must not yank
      // the preview pane to that row.
      const { sel } = makeHarness(5);
      sel.setFocused(0);
      sel.toggleAt(3);
      expect(sel.focusedIndex.value).toBe(0);
    });

    it('ignores placeholder slots so undefined is never selected', () => {
      const { sel, selectedIds } = makeHarness(4, { holes: [2] });
      sel.toggleAt(2);
      expect(selectedIds.value.size).toBe(0);
    });
  });

  describe('extendRange (shift+checkbox)', () => {
    it('selects from anchor to clicked index, replacing prior selection', () => {
      const { sel, selectedIds } = makeHarness(6);
      sel.toggleAt(1);
      sel.extendRange(4);
      expect(ids(selectedIds.value)).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    it('shrinks the range when extending back toward the anchor', () => {
      // The bug naive multi-click libs (e.g. vue-multiclick) have:
      // they only ever *append* to the selection on shift-click, so
      // shift-clicking back toward the anchor leaves a tail behind.
      // Overture's algorithm rebuilds the range from the anchor.
      const { sel, selectedIds } = makeHarness(6);
      sel.toggleAt(1);
      sel.extendRange(5);
      expect(ids(selectedIds.value)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      sel.extendRange(3);
      expect(ids(selectedIds.value)).toEqual(['m1', 'm2', 'm3']);
    });

    it('keeps the anchor stable across multiple extends', () => {
      const { sel } = makeHarness(6);
      sel.toggleAt(2);
      sel.extendRange(4);
      expect(sel.anchorIndex.value).toBe(2);
      sel.extendRange(0);
      expect(sel.anchorIndex.value).toBe(2);
    });

    it('without a prior anchor, the click establishes one', () => {
      const { sel, selectedIds } = makeHarness(6);
      sel.extendRange(3);
      expect(ids(selectedIds.value)).toEqual(['m3']);
      expect(sel.anchorIndex.value).toBe(3);
    });

    it('skips placeholder rows inside the range', () => {
      const { sel, selectedIds } = makeHarness(6, { holes: [2, 3] });
      sel.toggleAt(1);
      sel.extendRange(5);
      expect(ids(selectedIds.value)).toEqual(['m1', 'm4', 'm5']);
    });
  });

  describe('handleCheckboxClick decision tree', () => {
    it('plain click toggles', () => {
      const { sel, selectedIds } = makeHarness(5);
      sel.handleCheckboxClick(2, {});
      expect(ids(selectedIds.value)).toEqual(['m2']);
      sel.handleCheckboxClick(2, {});
      expect(selectedIds.value.size).toBe(0);
    });

    it('shift+click extends from anchor', () => {
      const { sel, selectedIds } = makeHarness(5);
      sel.handleCheckboxClick(1, {});
      sel.handleCheckboxClick(3, { shiftKey: true });
      expect(ids(selectedIds.value)).toEqual(['m1', 'm2', 'm3']);
    });
  });

  describe('handleKeyDown', () => {
    it('ArrowDown moves focus but does NOT change selection', () => {
      const { sel, selectedIds } = makeHarness(5);
      sel.setFocused(0);
      const result = sel.handleKeyDown({ key: 'ArrowDown', preventDefault: noop });
      expect(result.consumed).toBe(true);
      expect(result.focusChanged).toBe(true);
      expect(result.focusedId).toBe('m1');
      expect(sel.focusedIndex.value).toBe(1);
      expect(selectedIds.value.size).toBe(0);
    });

    it('Shift+ArrowDown extends selection from anchor without moving the preview', () => {
      // Shift+Arrow is the keyboard equivalent of Shift+checkbox-click.
      // It should grow the selection set but not be reported as a
      // focus change for the caller's preview-pane logic.
      const { sel, selectedIds } = makeHarness(5);
      sel.toggleAt(1);
      const a = sel.handleKeyDown({ key: 'ArrowDown', shiftKey: true, preventDefault: noop });
      const b = sel.handleKeyDown({ key: 'ArrowDown', shiftKey: true, preventDefault: noop });
      expect(ids(selectedIds.value)).toEqual(['m1', 'm2', 'm3']);
      expect(sel.anchorIndex.value).toBe(1);
      // The composable still reports focusChanged so callers can keep
      // the visible cursor in sync; consumers check `event.shiftKey`
      // themselves to decide whether to drive the body fetch.
      expect(b.focusChanged).toBe(true);
      expect(a.focusedId).toBe('m2');
    });

    it('Space on focused row toggles selection', () => {
      const { sel, selectedIds } = makeHarness(5);
      sel.setFocused(2);
      sel.handleKeyDown({ key: ' ', preventDefault: noop });
      expect(ids(selectedIds.value)).toEqual(['m2']);
      sel.handleKeyDown({ key: ' ', preventDefault: noop });
      expect(selectedIds.value.size).toBe(0);
    });

    it('Space is a no-op when nothing is focused', () => {
      const { sel, selectedIds } = makeHarness(5);
      const result = sel.handleKeyDown({ key: ' ', preventDefault: noop });
      expect(result.consumed).toBe(false);
      expect(selectedIds.value.size).toBe(0);
    });

    it('Cmd+A selects all loaded rows', () => {
      const { sel, selectedIds } = makeHarness(4);
      const result = sel.handleKeyDown({ key: 'a', metaKey: true, preventDefault: noop });
      expect(result.consumed).toBe(true);
      expect(ids(selectedIds.value)).toEqual(['m0', 'm1', 'm2', 'm3']);
    });

    it('Escape clears an active selection', () => {
      const { sel, selectedIds } = makeHarness(4);
      sel.selectAllLoaded();
      const result = sel.handleKeyDown({ key: 'Escape', preventDefault: noop });
      expect(result.consumed).toBe(true);
      expect(selectedIds.value.size).toBe(0);
    });

    it('Escape does nothing when the selection is empty', () => {
      const { sel } = makeHarness(4);
      const result = sel.handleKeyDown({ key: 'Escape', preventDefault: noop });
      expect(result.consumed).toBe(false);
    });

    it('clamps arrow navigation at boundaries', () => {
      const { sel } = makeHarness(3);
      sel.setFocused(0);
      sel.handleKeyDown({ key: 'ArrowUp', preventDefault: noop });
      expect(sel.focusedIndex.value).toBe(0);
      sel.setFocused(2);
      sel.handleKeyDown({ key: 'ArrowDown', preventDefault: noop });
      expect(sel.focusedIndex.value).toBe(2);
    });
  });

  describe('selectAllLoaded / selectNone', () => {
    it('selects every loaded row even when total > loaded', () => {
      const { sel, selectedIds, total } = makeHarness(3);
      total.value = 50;
      sel.selectAllLoaded();
      expect(ids(selectedIds.value)).toEqual(['m0', 'm1', 'm2']);
    });

    it('preserves prior selections (set union, not replacement)', () => {
      // The "loaded" set may grow as the user scrolls; selectAll
      // shouldn't drop the existing selection if it's called twice.
      const { sel, selectedIds } = makeHarness(3);
      sel.toggleAt(1);
      sel.selectAllLoaded();
      expect(ids(selectedIds.value)).toEqual(['m0', 'm1', 'm2']);
    });

    it('selectNone empties the set and resets the anchor', () => {
      const { sel, selectedIds } = makeHarness(4);
      sel.selectAllLoaded();
      expect(selectedIds.value.size).toBe(4);
      sel.selectNone();
      expect(selectedIds.value.size).toBe(0);
      expect(sel.anchorIndex.value).toBe(-1);
    });
  });

  describe('externally-owned selectedIds', () => {
    it('writes through to the provided ref', () => {
      const external = ref(new Set());
      const rows = ref(makeRows(4));
      const total = ref(4);
      const sel = useListSelection({ rows, total, selectedIds: external });
      sel.toggleAt(1);
      sel.toggleAt(3);
      expect(ids(external.value)).toEqual(['m1', 'm3']);
    });

    it('replaces the Set instance on every mutation', () => {
      // The Pinia + Vue reactivity contract: in-place Set mutation
      // doesn't trigger watchers reliably across stores. We assign a
      // fresh Set on every change.
      const external = ref(new Set());
      const rows = ref(makeRows(4));
      const total = ref(4);
      const sel = useListSelection({ rows, total, selectedIds: external });
      const initial = external.value;
      sel.toggleAt(0);
      expect(external.value).not.toBe(initial);
    });
  });
});
