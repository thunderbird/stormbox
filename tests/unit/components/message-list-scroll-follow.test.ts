// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { computed, nextTick } from 'vue';

const virtualizerWindow = vi.hoisted(() => ({
  start: 0,
  count: null as number | null,
}));

// Stable across the computed re-evaluations the component triggers, so
// assertions see every call the watcher makes.
const scrollToIndex = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (optionsRef) => computed(() => ({
    getTotalSize: () => Number(optionsRef.value.count ?? 0) * 64,
    getVirtualItems: () => {
      const total = Number(optionsRef.value.count ?? 0);
      const start = Math.max(0, Math.min(virtualizerWindow.start, total));
      const length = virtualizerWindow.count ?? (total - start);
      return Array.from(
        { length: Math.max(0, Math.min(length, total - start)) },
        (_, offset) => {
          const index = start + offset;
          return {
            index,
            key: optionsRef.value.getItemKey?.(index) ?? index,
            start: index * 64,
            size: 64,
          };
        },
      );
    },
    scrollToIndex,
    measure: () => {},
  })),
}));

import MessageList from '../../../src/components/MessageList.vue';
import { useMailStore } from '../../../src/stores/mail-store';

function makeFolder(id, overrides = {}) {
  return {
    id,
    account_id: 1,
    remote_id: `mb-${id}`,
    name: `Folder ${id}`,
    role: id === 1 ? 'inbox' : null,
    sort_order: 0,
    parent_id: null,
    is_deleted: 0,
    total_emails: 0,
    unread_emails: 0,
    may_add_items: null,
    may_remove_items: null,
    ...overrides,
  } as any;
}

function makeRow(id, overrides = {}) {
  return {
    id,
    remote_id: `e-${id}`,
    from_text: `Sender ${id} <sender${id}@example.com>`,
    to_text: 'me@example.com',
    subject: `Subject ${id}`,
    preview: 'preview',
    received_at: 1_700_000_000_000 + id,
    is_seen: 1,
    is_flagged: 0,
    has_attachment: 0,
    ...overrides,
  } as any;
}

function mountList() {
  const mailStore = useMailStore();
  mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
  mailStore.currentFolderId = 1;
  mailStore.messages = Array.from({ length: 30 }, (_, index) => makeRow(index + 1));
  mailStore.totalForFolder = 30;
  return { mailStore, wrapper: mount(MessageList) };
}

beforeEach(() => {
  virtualizerWindow.start = 0;
  virtualizerWindow.count = null;
  scrollToIndex.mockClear();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageList scroll follows the selected message (issue #31)', () => {
  it('scrolls the virtual list to a programmatically selected row', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    scrollToIndex.mockClear();

    // Simulates the global F/B/N/P/Home/End handler, which sets
    // selectedMessageId directly without going through the list.
    mailStore.selectMessage(17);
    await nextTick();
    await nextTick();

    expect(scrollToIndex).toHaveBeenCalledWith(16, { align: 'auto' });
    wrapper.unmount();
  });

  it('follows Arrow key navigation past the viewport edge', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    mailStore.selectMessage(5);
    await nextTick();
    await nextTick();
    scrollToIndex.mockClear();

    await wrapper.find('.msg-list__scroller').trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    await nextTick();

    // Arrow nav moved selection from row id 5 (index 4) to index 5.
    expect(mailStore.selectedMessageId).toBe(6);
    expect(scrollToIndex).toHaveBeenCalledWith(5, { align: 'auto' });
    wrapper.unmount();
  });

  it('syncs the arrow-key origin after a global navigation jump', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();

    // Jump via the global path (no arrow), then press Arrow Down. The
    // next row must be relative to the jumped-to row, proving the
    // composable's focusedIndex was resynced from selectedMessageId.
    mailStore.selectMessage(20);
    await nextTick();
    await nextTick();

    await wrapper.find('.msg-list__scroller').trigger('keydown', { key: 'ArrowDown' });
    await nextTick();

    expect(mailStore.selectedMessageId).toBe(21);
    wrapper.unmount();
  });

  it('does not scroll when the selection is cleared', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    mailStore.selectMessage(10);
    await nextTick();
    await nextTick();
    scrollToIndex.mockClear();

    mailStore.selectMessage(null);
    await nextTick();
    await nextTick();

    expect(scrollToIndex).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('follows a Shift+Arrow range extension even though the preview stays put', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    mailStore.selectMessage(5);
    await nextTick();
    await nextTick();
    scrollToIndex.mockClear();

    await wrapper.find('.msg-list__scroller')
      .trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    await nextTick();
    await nextTick();

    // The cursor advanced to row id 6 (index 5) and the viewport
    // followed it, but the previewed message did not change.
    expect(mailStore.focusedMessageId).toBe(6);
    expect(mailStore.selectedMessageId).toBe(5);
    expect(scrollToIndex).toHaveBeenCalledWith(5, { align: 'auto' });
    wrapper.unmount();
  });

  it('exposes the cursor row via aria-activedescendant on the listbox', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();

    const scroller = wrapper.find('.msg-list__scroller');
    expect(scroller.attributes('role')).toBe('listbox');
    expect(scroller.attributes('aria-activedescendant')).toBeUndefined();

    mailStore.selectMessage(17);
    await nextTick();

    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-17');
    const optionRow = wrapper.find('#msg-row-17');
    expect(optionRow.exists()).toBe(true);
    expect(optionRow.attributes('role')).toBe('option');
    wrapper.unmount();
  });
});
