// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  computed,
  defineComponent,
  nextTick,
  ref,
} from 'vue';

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
import { useThunderbirdShortcuts } from '../../../src/composables/useThunderbirdShortcuts';
import { useMailStore } from '../../../src/stores/mail-store';
import { useSettingsStore } from '../../../src/stores/settings-store';

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

function mountList({
  quickFilterQuery = '',
  rows = Array.from({ length: 30 }, (_, index) => makeRow(index + 1)),
} = {}) {
  const mailStore = useMailStore();
  mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
  mailStore.currentFolderId = 1;
  mailStore.messages = rows;
  mailStore.totalForFolder = rows.length;
  return {
    mailStore,
    wrapper: mount(MessageList, { props: { quickFilterQuery }, attachTo: document.body }),
  };
}

function mountShortcutBroker() {
  const Harness = defineComponent({
    setup() {
      useThunderbirdShortcuts({
        enabled: ref(true),
        space: ref('mail'),
      });
      return () => null;
    },
  });
  return mount(Harness);
}

function fireKey(key: string) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
  });
  document.dispatchEvent(event);
  return event;
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
  it('keeps global navigation inside the active quick filter', async () => {
    const { mailStore, wrapper } = mountList({
      quickFilterQuery: 'match',
      rows: [
        makeRow(1, { is_seen: 0, subject: 'Match one' }),
        makeRow(2, { is_seen: 0, subject: 'Hidden' }),
        makeRow(3, { is_seen: 0, subject: 'Match three' }),
        makeRow(4, { is_seen: 1, subject: 'Match four' }),
      ],
    });
    const shortcuts = mountShortcutBroker();
    mailStore.selectMessage(1);

    // Web scheme (the default): N/P step through unread, J/K through all.
    expect(fireKey('n').defaultPrevented).toBe(true);
    expect(mailStore.selectedMessageId).toBe(3);
    fireKey('j');
    expect(mailStore.selectedMessageId).toBe(4);
    fireKey('k');
    expect(mailStore.selectedMessageId).toBe(3);
    fireKey('p');
    expect(mailStore.selectedMessageId).toBe(1);
    // Home/End are the list's own keys, so the page keeps them elsewhere.
    expect(fireKey('End').defaultPrevented).toBe(false);
    expect(mailStore.selectedMessageId).toBe(1);
    const scroller = wrapper.get('.msg-list__scroller');
    await scroller.trigger('keydown', { key: 'End' });
    expect(mailStore.selectedMessageId).toBe(4);
    await scroller.trigger('keydown', { key: 'Home' });
    expect(mailStore.selectedMessageId).toBe(1);

    shortcuts.unmount();
    wrapper.unmount();
  });

  it('keeps the Thunderbird F/B/Home/End keys when that scheme is chosen', async () => {
    useSettingsStore().settings = { shortcutScheme: 'thunderbird' };
    const { mailStore, wrapper } = mountList({
      quickFilterQuery: 'match',
      rows: [
        makeRow(1, { is_seen: 0, subject: 'Match one' }),
        makeRow(2, { is_seen: 0, subject: 'Hidden' }),
        makeRow(3, { is_seen: 0, subject: 'Match three' }),
        makeRow(4, { is_seen: 1, subject: 'Match four' }),
      ],
    });
    const shortcuts = mountShortcutBroker();
    mailStore.selectMessage(1);

    fireKey('f');
    expect(mailStore.selectedMessageId).toBe(3);
    fireKey('b');
    expect(mailStore.selectedMessageId).toBe(1);
    expect(fireKey('End').defaultPrevented).toBe(true);
    expect(mailStore.selectedMessageId).toBe(4);
    fireKey('Home');
    expect(mailStore.selectedMessageId).toBe(1);

    shortcuts.unmount();
    wrapper.unmount();
  });

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

  it('exposes the cursor row via aria-activedescendant on the grid', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();

    const scroller = wrapper.find('.msg-list__scroller');
    expect(scroller.attributes('role')).toBe('grid');
    expect(scroller.attributes('aria-activedescendant')).toBeUndefined();

    mailStore.selectMessage(17);
    await nextTick();

    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-17');
    const optionRow = wrapper.find('#msg-row-17');
    expect(optionRow.exists()).toBe(true);
    expect(optionRow.attributes('role')).toBe('row');
    wrapper.unmount();
  });
});


describe('Message grid controls (issue #156)', () => {
  it('exposes named sibling controls in indexed selectable rows', async () => {
    const { wrapper } = mountList();
    await nextTick();
    const grid = wrapper.find('[role="grid"]');
    expect(grid.attributes('aria-multiselectable')).toBe('true');
    expect(grid.attributes('aria-rowcount')).toBe('30');
    const row = grid.find('[role="row"]');
    expect(row.attributes('aria-rowindex')).toBe('1');
    expect(row.attributes('aria-selected')).toBe('false');
    expect(row.find('[role="gridcell"]').exists()).toBe(true);
    expect(row.find('input').attributes('aria-label')).toBe('Select message: Subject 1, Sender 1');
    expect(row.find('.msg-list__open').attributes('aria-label')).toBe('Open message: Subject 1, Sender 1');
    expect(row.find('.msg-list__open input, .msg-list__open button, [role="option"]').exists()).toBe(false);
    expect(row.findAll('[data-message-control]').every((c) => c.attributes('tabindex') === '-1')).toBe(true);
    wrapper.unmount();
  });

  it('keeps native control keys local in both shortcut schemes and returns focus without clearing selection', async () => {
    const { mailStore, wrapper } = mountList();
    const shortcuts = mountShortcutBroker();
    await nextTick();
    const grid = wrapper.find('.msg-list__scroller');
    mailStore.selectMessage(2);
    await nextTick();
    for (const scheme of ['web', 'thunderbird'] as const) {
      useSettingsStore().settings = { shortcutScheme: scheme };
      (grid.element as HTMLElement).focus();
      await grid.trigger('keydown', { key: 'F2' });
      const checkbox = wrapper.find('#msg-row-2 input');
      expect(document.activeElement).toBe(checkbox.element);
      await checkbox.trigger('keydown', { key: 'Enter' });
      expect(mailStore.selectedIds.has(2)).toBe(true);
      expect(mailStore.selectedMessageId).toBe(2);
      await checkbox.trigger('keydown', { key: 'Escape' });
      expect(document.activeElement).toBe(grid.element);
      expect(mailStore.selectedIds.has(2)).toBe(true);
      await grid.trigger('keydown', { key: 'Escape' });
      expect(mailStore.selectedIds.size).toBe(0);
    }
    shortcuts.unmount();
    wrapper.unmount();
  });

  it('moves across controls, preserves range selection, and navigates from the control row', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    const grid = wrapper.find('.msg-list__scroller');
    await wrapper.find('#msg-row-3 input').trigger('click');
    await wrapper.find('#msg-row-5 input').trigger('click', { shiftKey: true });
    expect([...mailStore.selectedIds]).toEqual([3, 4, 5]);
    expect(mailStore.selectedMessageId).toBeNull();
    await wrapper.find('#msg-row-3 input').trigger('keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(wrapper.find('#msg-row-3 .msg-list__open').element);
    await wrapper.find('#msg-row-3 .msg-list__open').trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    expect(document.activeElement).toBe(grid.element);
    expect(mailStore.focusedMessageId).toBe(4);
    expect(mailStore.selectedMessageId).toBeNull();
    expect([...mailStore.selectedIds]).toEqual([3, 4]);
    wrapper.unmount();
  });

  it('opens and closes the preview from the native button and restores grid navigation', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    const open = wrapper.find('#msg-row-2 .msg-list__open');
    await open.trigger('click');
    expect(mailStore.selectedMessageId).toBe(2);
    expect(document.activeElement).toBe(wrapper.find('[role="grid"]').element);
    await wrapper.find('[role="grid"]').trigger('keydown', { key: ' ' });
    expect([...mailStore.selectedIds]).toEqual([2]);
    await open.trigger('click');
    expect(mailStore.selectedIds.size).toBe(0);
    expect(mailStore.selectedMessageId).toBe(2);
    await open.trigger('click');
    expect(mailStore.selectedMessageId).toBeNull();
    wrapper.unmount();
  });

  it('omits active descendants that have been recycled outside the virtual window', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    mailStore.selectMessage(2);
    await nextTick();
    virtualizerWindow.start = 20;
    virtualizerWindow.count = 5;
    mailStore.messages = [...mailStore.messages];
    await nextTick();
    expect(wrapper.find('#msg-row-2').exists()).toBe(false);
    expect(wrapper.find('[role="grid"]').attributes('aria-activedescendant')).toBeUndefined();
    wrapper.unmount();
  });
});

describe('Message grid input modes', () => {
  it('returns pointer control clicks to the grid so Escape clears selection', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    const checkbox = wrapper.find('#msg-row-2 input');
    (checkbox.element as HTMLInputElement).focus();
    await checkbox.trigger('click', { detail: 1 });
    expect(document.activeElement).toBe(wrapper.find('[role="grid"]').element);
    expect(mailStore.selectedIds.has(2)).toBe(true);
    await wrapper.find('[role="grid"]').trigger('keydown', { key: 'Escape' });
    expect(mailStore.selectedIds.size).toBe(0);
    wrapper.unmount();
  });

  it('keeps select-all available inside row controls and leaves browser navigation chords alone', async () => {
    const { mailStore, wrapper } = mountList();
    await nextTick();
    const grid = wrapper.find('[role="grid"]');
    await grid.trigger('keydown', { key: 'F2' });
    const checkbox = wrapper.find('#msg-row-1 input');
    await checkbox.trigger('keydown', { key: 'a', ctrlKey: true });
    expect(mailStore.selectedIds.size).toBe(30);
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true,
    });
    checkbox.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(checkbox.element);
    wrapper.unmount();
  });

  it('returns pointer context menus and row drags to list navigation', async () => {
    const { wrapper } = mountList();
    await nextTick();
    const open = wrapper.find('#msg-row-2 .msg-list__open');
    (open.element as HTMLButtonElement).focus();
    await open.trigger('contextmenu', { button: 0 });
    expect(document.activeElement).toBe(open.element);
    await open.trigger('contextmenu', { button: 2 });
    expect(document.activeElement).toBe(wrapper.find('[role="grid"]').element);
    (open.element as HTMLButtonElement).focus();
    await wrapper.find('#msg-row-2 .msg-list__item').trigger('dragstart', {
      dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: 'none' },
    });
    expect(document.activeElement).toBe(wrapper.find('[role="grid"]').element);
    wrapper.unmount();
  });

  it('announces message status as well as sender and subject', async () => {
    const { wrapper } = mountList({ rows: [makeRow(1, {
      is_seen: 0, is_flagged: 1, has_attachment: 1, keywords_json: '{"$label2":true}',
    })] });
    await nextTick();
    const label = wrapper.find('[role="row"]').attributes('aria-label');
    for (const state of ['Sender 1', 'Subject 1', 'Unread', 'Starred', 'Has attachments', 'Tags: Work']) {
      expect(label).toContain(state);
    }
    wrapper.unmount();
  });
});
