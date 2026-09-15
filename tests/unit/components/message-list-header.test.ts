// @vitest-environment happy-dom

/**
 * The message list header is one row at every column width. Pins the
 * tiers by which controls leave the row as the column narrows (count,
 * filter labels, then Refresh and the column control into the More
 * menu), the bulk row's overflow into the same menu, the menu's
 * semantics and focus return, and that Escape on an open menu leaves
 * the selection alone.
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
    getVirtualItems: () => {
      const total = Number(optionsRef.value.count ?? 0);
      return Array.from({ length: total }, (_, index) => ({
        index,
        key: optionsRef.value.getItemKey?.(index) ?? index,
        start: index * 64,
        size: 64,
      }));
    },
    scrollToIndex: () => {},
    measure: () => {},
  })),
}));

import MessageColumns from '../../../src/components/MessageColumns.vue';
import {
  splitBulkActions,
  type BulkActionItem,
} from '../../../src/composables/useBulkActionItems';
import { useThunderbirdShortcuts } from '../../../src/composables/useThunderbirdShortcuts';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import { useMessageColumnsStore } from '../../../src/stores/message-columns-store';
import { useSettingsStore } from '../../../src/stores/settings-store';

function makeFolder(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    account_id: 1,
    remote_id: `mb-${id}`,
    name: `Folder ${id}`,
    role: id === 1 ? 'inbox' : null,
    sort_order: 0,
    parent_id: null,
    is_deleted: 0,
    is_subscribed: 1,
    total_emails: 0,
    unread_emails: 0,
    may_add_items: 1,
    may_remove_items: 1,
    ...overrides,
  } as any;
}

function makeRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    remote_id: `e-${id}`,
    from_text: `Sender ${id} <sender${id}@example.com>`,
    to_text: 'me@example.com',
    subject: `Subject ${id}`,
    preview: 'preview',
    received_at: 1_700_000_000_000 + id,
    keywords_json: '{}',
    is_seen: 1,
    is_flagged: 0,
    has_attachment: 0,
    ...overrides,
  } as any;
}

function seedInbox() {
  useAuthStore().accountId = 1;
  const mailStore = useMailStore();
  mailStore.accounts = [{
    id: 1,
    display_name: 'Account 1',
    primary_email: 'user1@example.org',
    server_origin: 'https://mail.example.org',
    remote_account_id: 'acct-1',
    is_primary: 1,
  } as any];
  mailStore.folders = [
    makeFolder(1, { name: 'Inbox' }),
    makeFolder(2, { name: 'Archive', role: 'archive' }),
  ];
  mailStore.selectFolder(1);
  mailStore.messages = [makeRow(1), makeRow(2), makeRow(3)];
  mailStore.totalForFolder = 3;
  mailStore.isLoading = false;
  return mailStore;
}

const mounted: Array<{ unmount: () => void }> = [];

/** Mounts the columns area with every list measuring `width` px. */
function mountAtWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function clientWidth(this: HTMLElement) {
    return this.classList.contains('msg-list') ? width : 0;
  });
  const wrapper = mount(MessageColumns, {
    attachTo: document.body,
    props: { quickFilterQuery: '', readingPaneVisible: true },
  });
  mounted.push(wrapper);
  return wrapper;
}

function mountShortcutBroker() {
  const Harness = defineComponent({
    setup() {
      useThunderbirdShortcuts({ enabled: ref(true), space: ref('mail') });
      return () => null;
    },
  });
  const wrapper = mount(Harness);
  mounted.push(wrapper);
  return wrapper;
}

function header(wrapper: ReturnType<typeof mountAtWidth>) {
  return wrapper.find('.msg-list .msg-list__header');
}

function moreItems(wrapper: ReturnType<typeof mountAtWidth>) {
  return wrapper.findAll('[role="menuitem"], [role="menuitemcheckbox"]').map((item) => item.text());
}

beforeEach(() => {
  window.localStorage?.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
});

describe('message list header tiers', () => {
  it('shows everything in one row when the column is wide', async () => {
    seedInbox();
    const wrapper = mountAtWidth(600);
    await nextTick();
    const head = header(wrapper);
    expect(head.attributes('data-header-tier')).toBe('full');
    expect(head.find('.selectable-list-header__count').text()).toBe('3 messages');
    expect(head.find('.msg-list__filter').text()).toBe('Unread');
    expect(head.find('.msg-list__filters--icons').exists()).toBe(false);
    expect(head.find('.msg-list__refresh').exists()).toBe(true);
    expect(head.find('.msg-list__add-column').exists()).toBe(true);
    expect(head.find('[data-more-menu]').exists()).toBe(false);
    expect(head.find('.msg-list__title').text()).toBe('Inbox');
    expect(wrapper.find('.msg-list__titlebar').exists()).toBe(false);
  });

  it('drops the total count first as the column narrows', async () => {
    seedInbox();
    const wrapper = mountAtWidth(480);
    await nextTick();
    const head = header(wrapper);
    expect(head.attributes('data-header-tier')).toBe('no-count');
    expect(head.find('.selectable-list-header__count').text()).toBe('');
    expect(head.find('.msg-list__filter').text()).toBe('Unread');
    expect(head.find('.msg-list__refresh').exists()).toBe(true);
    expect(head.find('[data-more-menu]').exists()).toBe(false);
  });

  it('then turns the filters icon-only, keeping their names for assistive tech', async () => {
    seedInbox();
    const wrapper = mountAtWidth(400);
    await nextTick();
    const head = header(wrapper);
    expect(head.attributes('data-header-tier')).toBe('icon-filters');
    expect(head.find('.msg-list__filters--icons').exists()).toBe(true);
    const filters = head.findAll('.msg-list__filter');
    expect(filters.map((button) => button.text())).toEqual(['', '']);
    expect(filters.map((button) => button.attributes('aria-label'))).toEqual(['Unread', 'Starred']);
    expect(filters.every((button) => button.find('svg').exists())).toBe(true);
    expect(head.find('.msg-list__refresh').exists()).toBe(true);
    expect(head.find('.msg-list__add-column').exists()).toBe(true);
  });

  it('moves Refresh and the column control into the More menu in a narrow column, where they still work', async () => {
    const mailStore = seedInbox();
    const wrapper = mountAtWidth(300);
    await nextTick();
    const head = header(wrapper);
    expect(head.attributes('data-header-tier')).toBe('compact');
    expect(head.find('.msg-list__refresh').exists()).toBe(false);
    expect(head.find('.msg-list__add-column').exists()).toBe(false);
    // The filters stay in the row as icons; nothing wraps.
    expect(head.findAll('.msg-list__filters--icons .msg-list__filter')).toHaveLength(2);

    const trigger = head.find('[data-more-menu]');
    expect(trigger.attributes('aria-haspopup')).toBe('menu');
    expect(trigger.attributes('aria-label')).toBe('More actions for column 1');
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    expect(moreItems(wrapper)).toEqual(['Refresh', 'Add column']);

    const refreshSpy = vi.spyOn(mailStore, 'refresh').mockResolvedValue(undefined);
    await wrapper.find('[data-more-item="refresh"]').trigger('click');
    expect(refreshSpy).toHaveBeenCalledWith(1);

    await wrapper.find('[data-more-item="add-column"]').trigger('click');
    await nextTick();
    expect(useMessageColumnsStore().columns).toHaveLength(2);
    // The new column has no folder yet: its × stays in the row with the dropdown.
    const added = wrapper.findAll('.msg-list')[1];
    expect(added.find('.msg-list__folder-trigger').exists()).toBe(true);
    expect(added.find('.msg-list__remove-column').exists()).toBe(true);
    expect(added.find('[data-more-menu]').exists()).toBe(false);
  });

  it('returns focus to the More menu after removing a column whose neighbour keeps its control there', async () => {
    seedInbox();
    const wrapper = mountAtWidth(300);
    const store = useMessageColumnsStore();
    const id = store.addColumn()!;
    store.setColumnFolder(id, 2);
    await nextTick();
    const second = wrapper.findAll('.msg-list')[1];
    // The second column has a folder, so at 300px its × is in the menu.
    expect(second.find('.msg-list__remove-column').exists()).toBe(false);
    await second.find('[data-more-item="remove-column"]').trigger('click');
    await nextTick();
    expect(store.columns).toHaveLength(1);
    expect(document.activeElement).toBe(wrapper.find('.msg-list [data-more-menu]').element);
  });
});

describe('bulk row overflow', () => {
  it('keeps Delete and Clear in a narrow row and lists the other actions in the More menu with the folder as heading', async () => {
    const mailStore = seedInbox();
    const wrapper = mountAtWidth(300);
    await nextTick();
    await wrapper.findAll('.msg-list__check input')[0].trigger('click');
    expect(mailStore.selectedIds.size).toBe(1);

    const head = header(wrapper);
    const inline = head.findAll('.msg-list__bulk-actions .msg-list__bulk-action')
      .map((button) => button.attributes('aria-label'));
    expect(inline).toEqual(['Delete', 'Clear selection']);
    expect(head.find('.selectable-list-header__count').text()).toBe('1 selected');
    expect(head.find('.msg-list__refresh').exists()).toBe(false);
    expect(head.find('.msg-list__add-column').exists()).toBe(false);
    expect(head.find('.msg-list__filters').exists()).toBe(false);

    expect(moreItems(wrapper)).toEqual([
      'Archive', 'Mark as junk', 'Star', 'Mark as read', 'Mark as unread', 'Refresh', 'Add column',
    ]);
    expect(wrapper.find('.msg-list__more-heading').text()).toBe('Inbox');

    const seenSpy = vi.spyOn(mailStore, 'markManySeen').mockResolvedValue(1);
    await wrapper.find('[data-more-item="mark-read"]').trigger('click');
    expect(seenSpy).toHaveBeenCalledWith([1], true, { sourceFolderId: 1 });
  });

  it('keeps more actions inline as the row widens, in priority order', async () => {
    seedInbox();
    const wrapper = mountAtWidth(360);
    await nextTick();
    await wrapper.findAll('.msg-list__check input')[0].trigger('click');
    const inline = header(wrapper).findAll('.msg-list__bulk-actions .msg-list__bulk-action')
      .map((button) => button.attributes('aria-label'));
    expect(inline).toEqual(['Archive', 'Delete', 'Star', 'Clear selection']);
    expect(moreItems(wrapper)).toEqual(['Mark as junk', 'Mark as read', 'Mark as unread', 'Refresh', 'Add column']);
  });

  it('shows every action inline when the width is unknown or wide', async () => {
    seedInbox();
    const wrapper = mountAtWidth(600);
    await nextTick();
    await wrapper.findAll('.msg-list__check input')[0].trigger('click');
    const inline = header(wrapper).findAll('.msg-list__bulk-actions .msg-list__bulk-action')
      .map((button) => button.attributes('aria-label'));
    expect(inline).toEqual([
      'Archive', 'Mark as junk', 'Delete', 'Star', 'Mark as read', 'Mark as unread', 'Clear selection',
    ]);
    // Refresh and + still sit in the menu while rows are checked.
    expect(moreItems(wrapper)).toEqual(['Refresh', 'Add column']);
  });

  it('closes the More menu on Escape without clearing the selection', async () => {
    const mailStore = seedInbox();
    useSettingsStore().settings = { shortcutScheme: 'thunderbird' };
    const wrapper = mountAtWidth(300);
    await nextTick();
    mountShortcutBroker();
    await wrapper.findAll('.msg-list__check input')[0].trigger('click');
    expect(mailStore.selectedIds.size).toBe(1);

    const details = wrapper.find('details.msg-list__more').element as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await nextTick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(details.open).toBe(false);
    expect(mailStore.selectedIds.size).toBe(1);

    // With no menu open, Escape clears the selection as before.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(mailStore.selectedIds.size).toBe(0);
  });
});

describe('splitBulkActions', () => {
  function item(id: BulkActionItem['id'], overflowRank: number | null, slots = 1): BulkActionItem {
    return {
      id, label: id, title: id, ariaLabel: id, icon: null, variant: 'default', slots, overflowRank, run: () => {},
    };
  }
  const items = [
    item('whitelist', 5, 3), item('archive', 4), item('junk', 2), item('delete', null),
    item('toggle-star', 3), item('mark-read', 1), item('mark-unread', 0),
  ];

  it('keeps every action inline when the capacity is unknown', () => {
    expect(splitBulkActions(items, null).overflow).toEqual([]);
  });

  it('always keeps the never-overflowing action and fills the rest by rank, in display order', () => {
    expect(splitBulkActions(items, 1).inline.map((i) => i.id)).toEqual(['delete']);
    expect(splitBulkActions(items, 3).inline.map((i) => i.id)).toEqual(['archive', 'delete', 'toggle-star']);
    // "Not junk" needs three slots; with five it comes back ahead of the lower ranks.
    expect(splitBulkActions(items, 5).inline.map((i) => i.id)).toEqual(['whitelist', 'archive', 'delete']);
    expect(splitBulkActions(items, 5).overflow.map((i) => i.id)).toEqual(['junk', 'toggle-star', 'mark-read', 'mark-unread']);
    expect(splitBulkActions(items, 9).overflow).toEqual([]);
  });
});
