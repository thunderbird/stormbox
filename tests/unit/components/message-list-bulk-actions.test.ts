// @vitest-environment happy-dom

/**
 * Multi-select owns the message list header: the checkbox selection
 * swaps the filter buttons ("Unread") for the bulk action toolbar,
 * centered in the header. The reading pane is hidden entirely during
 * multi-select (covered by app-layout.test.ts), so this header is the
 * only surface carrying the bulk actions — including in single-column
 * layouts.
 */

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

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (optionsRef) => computed(() => ({
    getTotalSize: () => Number(optionsRef.value.count ?? 0) * 64,
    getVirtualItems: () => [],
    scrollToIndex: () => {},
    measure: () => {},
  })),
}));

import MessageList from '../../../src/components/MessageList.vue';
import { useThunderbirdShortcuts } from '../../../src/composables/useThunderbirdShortcuts';
import { useAuthStore } from '../../../src/stores/auth-store';
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
  folder = makeFolder(1, { name: 'Inbox' }),
  quickFilterQuery = '',
  rows = [makeRow(1), makeRow(2), makeRow(3)],
} = {}) {
  const mailStore = useMailStore();
  mailStore.folders = [folder];
  mailStore.currentFolderId = folder.id;
  mailStore.messages = rows;
  mailStore.totalForFolder = rows.length;
  return {
    mailStore,
    wrapper: mount(MessageList, { props: { quickFilterQuery } }),
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

function fireKey(key: string, init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().accountId = 1;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageList bulk actions header', () => {
  it('selects only quick-filtered rows through the global command broker', async () => {
    const { mailStore, wrapper } = mountList({
      quickFilterQuery: 'match',
      rows: [
        makeRow(1, { subject: 'Match one' }),
        makeRow(2, { subject: 'Hidden' }),
        makeRow(3, { subject: 'Match two' }),
      ],
    });
    // Thunderbird scheme: Ctrl+A is global and reaches the list through the broker.
    useSettingsStore().settings = { shortcutScheme: 'thunderbird' };
    const shortcuts = mountShortcutBroker();
    mailStore.selectedIds = new Set([2]);

    const event = fireKey('a', { ctrlKey: true });
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect([...mailStore.selectedIds].sort((a, b) => a - b)).toEqual([1, 3]);
    shortcuts.unmount();
    wrapper.unmount();
  });

  it('selects only quick-filtered rows from Ctrl+A on the focused list', async () => {
    const { mailStore, wrapper } = mountList({
      quickFilterQuery: 'match',
      rows: [
        makeRow(1, { subject: 'Match one' }),
        makeRow(2, { subject: 'Hidden' }),
        makeRow(3, { subject: 'Match two' }),
      ],
    });
    // Web scheme: Ctrl+A is list-scoped, so the global broker leaves it alone.
    const shortcuts = mountShortcutBroker();

    const global = fireKey('a', { ctrlKey: true });
    await nextTick();
    expect(global.defaultPrevented).toBe(false);
    expect(mailStore.selectedIds.size).toBe(0);

    await wrapper.get('.msg-list__scroller').trigger('keydown', { key: 'a', ctrlKey: true });
    await nextTick();

    expect([...mailStore.selectedIds].sort((a, b) => a - b)).toEqual([1, 3]);
    shortcuts.unmount();
    wrapper.unmount();
  });

  it('selects only unread rows through the global command broker', async () => {
    const { mailStore, wrapper } = mountList({
      rows: [
        makeRow(1, { is_seen: 1 }),
        makeRow(2, { is_seen: 0 }),
        makeRow(3, { is_seen: 1 }),
      ],
    });
    useSettingsStore().settings = { shortcutScheme: 'thunderbird' };
    const shortcuts = mountShortcutBroker();
    await wrapper.get('.msg-list__filter').trigger('click');

    fireKey('a', { ctrlKey: true });
    await nextTick();

    expect([...mailStore.selectedIds]).toEqual([2]);
    shortcuts.unmount();
    wrapper.unmount();
  });

  it('offers a Starred filter beside Unread that narrows rows and select-all to starred mail', async () => {
    const { mailStore, wrapper } = mountList({
      rows: [
        makeRow(1, { is_flagged: 0 }),
        makeRow(2, { is_flagged: 1, is_seen: 0 }),
        makeRow(3, { is_flagged: 1 }),
      ],
    });
    useSettingsStore().settings = { shortcutScheme: 'thunderbird' };
    const shortcuts = mountShortcutBroker();

    const filters = wrapper.findAll('.msg-list__filter');
    expect(filters.map((button) => button.text())).toEqual(['Unread', 'Starred']);

    await filters[1].trigger('click');
    expect(filters[1].attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('.msg-list__count').text()).toBe('2 messages');

    fireKey('a', { ctrlKey: true });
    await nextTick();
    expect([...mailStore.selectedIds].sort()).toEqual([2, 3]);

    // Unread and Starred combine as AND.
    mailStore.selectedIds = new Set();
    await nextTick();
    await wrapper.findAll('.msg-list__filter')[0].trigger('click');
    fireKey('a', { ctrlKey: true });
    await nextTick();
    expect([...mailStore.selectedIds]).toEqual([2]);

    shortcuts.unmount();
    wrapper.unmount();
  });

  it('shows the filter buttons and no bulk actions without a selection', async () => {
    const { wrapper } = mountList();
    await nextTick();

    expect(wrapper.find('.msg-list__filters').exists()).toBe(true);
    expect(wrapper.find('.msg-list__bulk-actions').exists()).toBe(false);
    wrapper.unmount();
  });

  it('swaps the filters for the bulk action toolbar while rows are selected', async () => {
    const { mailStore, wrapper } = mountList();
    mailStore.selectedIds = new Set([1, 3]);
    await nextTick();

    // The Unread filter is unreachable during multi-select.
    expect(wrapper.find('.msg-list__filters').exists()).toBe(false);

    const actions = wrapper.findAll('.msg-list__bulk-actions .msg-list__bulk-action');
    expect(actions.map((button) => button.attributes('title'))).toEqual([
      'Archive',
      'Junk',
      'Delete',
      'Star',
      'Mark as read',
      'Mark as unread',
      'Clear selection',
    ]);
    expect(wrapper.find('.msg-list__count').text()).toBe('2 selected');
    wrapper.unmount();
  });

  it('replaces Junk with the Not junk action inside the Junk folder', async () => {
    const { mailStore, wrapper } = mountList({
      folder: makeFolder(2, { name: 'Junk', role: 'junk' }),
    });
    mailStore.selectedIds = new Set([1]);
    await nextTick();

    const actions = wrapper.findAll('.msg-list__bulk-actions .msg-list__bulk-action');
    expect(actions.map((button) => button.attributes('title'))).toEqual([
      'Whitelist senders and move to Inbox',
      'Archive',
      'Delete',
      'Star',
      'Mark as read',
      'Mark as unread',
      'Clear selection',
    ]);
    wrapper.unmount();
  });

  it('shows neither Junk nor Not junk actions in a shared Junk folder', async () => {
    const { mailStore, wrapper } = mountList({
      folder: makeFolder(2, {
        account_id: 2,
        name: 'Shared Junk',
        role: 'junk',
      }),
    });
    mailStore.selectedIds = new Set([1]);
    await nextTick();

    const titles = wrapper
      .findAll('.msg-list__bulk-actions .msg-list__bulk-action')
      .map((button) => button.attributes('title'));
    expect(titles).not.toContain('Junk');
    expect(titles).not.toContain('Whitelist senders and move to Inbox');
    wrapper.unmount();
  });

  it('offers Cancel send in place of Delete inside the Scheduled folder', async () => {
    const { mailStore, wrapper } = mountList({
      folder: makeFolder(2, { name: 'Scheduled', role: 'scheduled' }),
      rows: [
        makeRow(1, { scheduled_undo_status: 'pending' }),
        makeRow(2, { scheduled_undo_status: 'pending' }),
      ],
    });
    mailStore.selectedIds = new Set([1, 2]);
    await nextTick();

    const actions = wrapper.findAll('.msg-list__bulk-actions .msg-list__bulk-action');
    expect(actions.map((button) => button.attributes('title'))).toEqual([
      'Cancel send',
      'Mark as read',
      'Mark as unread',
      'Clear selection',
    ]);

    const cancelSpy = vi.spyOn(mailStore, 'cancelScheduledSends')
      .mockResolvedValue({ succeeded: 2, failed: 0 });
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);
    await wrapper.find('.msg-list__bulk-actions [title="Cancel send"]').trigger('click');

    expect(cancelSpy).toHaveBeenCalledWith([1, 2]);
    expect(destroySpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('dispatches the store actions for the selected ids', async () => {
    const { mailStore, wrapper } = mountList();
    mailStore.selectedIds = new Set([1, 3]);
    await nextTick();

    const archiveSpy = vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({ succeeded: 2, failed: 0, skipped: 0 });
    const junkSpy = vi.spyOn(mailStore, 'junkMessages').mockResolvedValue({ succeeded: 2, failed: 0, skipped: 0 });
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);
    const seenSpy = vi.spyOn(mailStore, 'markManySeen').mockResolvedValue(2);

    await wrapper.find('.msg-list__bulk-actions [title="Archive"]').trigger('click');
    await wrapper.find('.msg-list__bulk-actions [title="Junk"]').trigger('click');
    await wrapper.find('.msg-list__bulk-actions [title="Delete"]').trigger('click');
    await wrapper.find('.msg-list__bulk-actions [title="Mark as read"]').trigger('click');
    await wrapper.find('.msg-list__bulk-actions [title="Mark as unread"]').trigger('click');

    expect(archiveSpy).toHaveBeenCalledWith([1, 3]);
    expect(junkSpy).toHaveBeenCalledWith([1, 3]);
    expect(destroySpy).toHaveBeenCalledWith([1, 3]);
    expect(seenSpy).toHaveBeenNthCalledWith(1, [1, 3], true);
    expect(seenSpy).toHaveBeenNthCalledWith(2, [1, 3], false);
    wrapper.unmount();
  });

  it('offers a modal Star toggle that reads Unstar once any selected row is starred', async () => {
    const { mailStore, wrapper } = mountList({
      rows: [makeRow(1), makeRow(2, { is_flagged: 1 }), makeRow(3)],
    });
    mailStore.selectedIds = new Set([1, 3]);
    await nextTick();

    const star = wrapper.find('.msg-list__bulk-actions .msg-list__bulk-action--star');
    expect(star.attributes('title')).toBe('Star');
    expect(star.attributes('aria-pressed')).toBe('false');

    const toggleSpy = vi.spyOn(mailStore, 'toggleManyFlagged').mockResolvedValue(2);
    await star.trigger('click');
    expect(toggleSpy).toHaveBeenCalledWith([1, 3]);

    mailStore.selectedIds = new Set([1, 2]);
    await nextTick();
    expect(star.attributes('title')).toBe('Unstar');
    expect(star.attributes('aria-pressed')).toBe('true');
    wrapper.unmount();
  });

  it('clears the selection and restores the filters', async () => {
    const { mailStore, wrapper } = mountList();
    mailStore.selectedIds = new Set([1]);
    await nextTick();

    await wrapper.find('.msg-list__bulk-actions [title="Clear selection"]').trigger('click');
    await nextTick();

    expect(mailStore.selectedIds.size).toBe(0);
    expect(wrapper.find('.msg-list__bulk-actions').exists()).toBe(false);
    expect(wrapper.find('.msg-list__filters').exists()).toBe(true);
    wrapper.unmount();
  });
});
