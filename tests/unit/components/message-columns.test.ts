// @vitest-environment happy-dom

/**
 * The message list columns area: one MessageList per configured
 * column, all bound to the mail store's per-folder views. Pins adding,
 * removing and focus hand-off, the primary column following the folder
 * list, opening mail from another column, cross-column drag and drop
 * with the same-folder no-op, per-column DOM ids, and shortcut routing
 * to the column that owns the checked rows.
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
import { useThunderbirdShortcuts } from '../../../src/composables/useThunderbirdShortcuts';
import {
  MESSAGE_DRAG_MIME,
  useMessageDragDrop,
} from '../../../src/composables/useMessageDragDrop';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import {
  MAX_MESSAGE_COLUMNS,
  useMessageColumnsStore,
} from '../../../src/stores/message-columns-store';
import { useSettingsStore } from '../../../src/stores/settings-store';

function makeAccount(id: number) {
  return {
    id,
    display_name: `Account ${id}`,
    primary_email: `user${id}@example.org`,
    server_origin: 'https://mail.example.org',
    remote_account_id: `acct-${id}`,
    is_primary: id === 1 ? 1 : 0,
  } as any;
}

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

function makeDataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    types: [] as string[],
    setData(type: string, value: string) {
      data.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData(type: string) {
      return data.get(type) ?? '';
    },
    setDragImage: vi.fn(),
  };
}

/** Inbox (1) with rows 1-3 and Archive (2) with rows 21-22, Inbox in the primary column. */
function seedFolders() {
  useAuthStore().accountId = 1;
  const mailStore = useMailStore();
  mailStore.accounts = [makeAccount(1)];
  mailStore.folders = [
    makeFolder(1, { name: 'Inbox' }),
    makeFolder(2, { name: 'Archive', role: 'archive' }),
    makeFolder(3, { name: 'Projects' }),
  ];
  for (const [folderId, rows] of [
    [2, [makeRow(21), makeRow(22)]],
    [3, [makeRow(31)]],
    [1, [makeRow(1), makeRow(2), makeRow(3)]],
  ] as Array<[number, any[]]>) {
    mailStore.selectFolder(folderId);
    mailStore.messages = rows;
    mailStore.totalForFolder = rows.length;
    mailStore.isLoading = false;
  }
  return mailStore;
}

const mounted: Array<{ unmount: () => void }> = [];

function mountColumns(props: Record<string, unknown> = {}) {
  const wrapper = mount(MessageColumns, {
    attachTo: document.body,
    props: { quickFilterQuery: '', readingPaneVisible: true, ...props },
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

function fireKey(key: string, init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, key, ...init,
  });
  document.dispatchEvent(event);
  return event;
}

function columnsOf(wrapper: ReturnType<typeof mountColumns>) {
  return wrapper.findAll('.msg-list');
}

/** Adds a column showing `folderId` through the store, as the folder picker would. */
function addColumnFor(folderId: number | null) {
  const store = useMessageColumnsStore();
  const id = store.addColumn()!;
  if (folderId != null) store.setColumnFolder(id, folderId);
  return id;
}

beforeEach(() => {
  window.localStorage?.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  useMessageDragDrop().endMessageDrag();
  vi.restoreAllMocks();
});

describe('MessageColumns', () => {
  it('renders the primary column for the selected folder and adds a column focused on its folder picker', async () => {
    seedFolders();
    const wrapper = mountColumns();
    await nextTick();

    const columns = columnsOf(wrapper);
    expect(columns).toHaveLength(1);
    expect(columns[0].attributes('aria-label')).toBe('Inbox messages, column 1');
    expect(columns[0].find('.msg-list__add-column').exists()).toBe(true);
    expect(columns[0].find('.msg-list__remove-column').exists()).toBe(false);
    expect(columns[0].findAll('.msg-list__item')).toHaveLength(3);
    // A lone column's handle is labelled as the message list's.
    expect(wrapper.find('[aria-label="Resize message list"]').exists()).toBe(true);

    await columns[0].find('.msg-list__add-column').trigger('click');
    await nextTick();
    await nextTick();

    const after = columnsOf(wrapper);
    expect(after).toHaveLength(2);
    expect(after[1].attributes('aria-label')).toBe('Column 2, no folder chosen');
    expect(after[1].find('.msg-list__folder-trigger').exists()).toBe(true);
    expect(after[1].find('.msg-list__remove-column').exists()).toBe(true);
    expect(after[1].find('.msg-list__add-column').exists()).toBe(false);
    expect(after[1].text()).toContain('Choose a folder above to show its messages here.');
    expect(document.activeElement).toBe(after[1].find('.msg-list__folder-trigger').element);
    expect(wrapper.find('[aria-label="Resize column 1"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Resize column 2"]').exists()).toBe(true);
  });

  it('disables the add control at the column limit with an explanatory title', async () => {
    seedFolders();
    const wrapper = mountColumns();
    for (let i = 1; i < MAX_MESSAGE_COLUMNS; i += 1) addColumnFor(null);
    await nextTick();

    expect(columnsOf(wrapper)).toHaveLength(MAX_MESSAGE_COLUMNS);
    const add = wrapper.find('.msg-list__add-column');
    expect(add.attributes('disabled')).toBeDefined();
    expect(add.attributes('title')).toBe(`Up to ${MAX_MESSAGE_COLUMNS} columns can be shown`);
  });

  it('lists the folder list\'s folders with icons and binds the picked one, returning focus to the trigger', async () => {
    seedFolders();
    const wrapper = mountColumns();
    addColumnFor(null);
    await nextTick();

    const column = columnsOf(wrapper)[1];
    const menu = column.find('.msg-list__folder-menu');
    expect(menu.attributes('role')).toBe('listbox');
    const options = menu.findAll('[role="option"]');
    expect(options.map((option) => option.text())).toEqual(['Inbox', 'Archive', 'Projects']);
    expect(options.every((option) => option.find('.msg-list__folder-option-icon svg').exists())).toBe(true);

    await options[1].trigger('click');
    await nextTick();

    expect(useMessageColumnsStore().columns[1].folderId).toBe(2);
    expect(column.attributes('aria-label')).toBe('Archive messages, column 2');
    expect(column.find('.msg-list__folder-trigger').text()).toContain('Archive');
    expect(column.findAll('.msg-list__item')).toHaveLength(2);
    expect(column.find('[role="option"][aria-selected="true"]').text()).toBe('Archive');
    expect(document.activeElement).toBe(column.find('.msg-list__folder-trigger').element);
  });

  it('returns focus to the neighbour when a column is removed', async () => {
    seedFolders();
    const wrapper = mountColumns();
    const first = addColumnFor(2);
    const second = addColumnFor(3);
    await nextTick();
    expect(columnsOf(wrapper)).toHaveLength(3);

    await columnsOf(wrapper)[2].find('.msg-list__remove-column').trigger('click');
    await nextTick();
    await nextTick();
    let columns = columnsOf(wrapper);
    expect(columns).toHaveLength(2);
    expect(useMessageColumnsStore().columns.map((column) => column.id)).toEqual(['primary', first]);
    expect(document.activeElement).toBe(columns[1].find('.msg-list__remove-column').element);

    await columns[1].find('.msg-list__remove-column').trigger('click');
    await nextTick();
    await nextTick();
    columns = columnsOf(wrapper);
    expect(columns).toHaveLength(1);
    expect(useMessageColumnsStore().columns.map((column) => column.id)).not.toContain(second);
    expect(document.activeElement).toBe(columns[0].find('.msg-list__add-column').element);
  });

  it('drops the open message and checked rows of a folder its column stops showing', async () => {
    const mailStore = seedFolders();
    const wrapper = mountColumns();
    const id = addColumnFor(2);
    addColumnFor(2);
    await nextTick();

    const columns = columnsOf(wrapper);
    await columns[1].findAll('.msg-list__content')[0].trigger('click');
    expect(mailStore.selectedMessageId).toBe(21);

    // Column 2 switches to Projects while column 3 still shows Archive.
    await columns[1].findAll('[role="option"]')[2].trigger('click');
    await nextTick();
    await nextTick();
    expect(useMessageColumnsStore().columns[1].folderId).toBe(3);
    expect(mailStore.selectedMessageId).toBe(21);

    // Removing column 3 leaves no column on Archive.
    await columnsOf(wrapper)[2].findAll('.msg-list__check input')[1].trigger('click');
    expect([...mailStore.selectedIds]).toEqual([22]);
    // With rows checked the column control sits in the More menu.
    await columnsOf(wrapper)[2].find('[data-more-item="remove-column"]').trigger('click');
    await nextTick();
    await nextTick();
    expect(useMessageColumnsStore().columns.map((column) => column.id)).toEqual(['primary', id]);
    expect(mailStore.selectedMessageId).toBeNull();
    expect(mailStore.selectedIds.size).toBe(0);
  });

  it('keeps the primary column on the folder list selection while other columns keep theirs', async () => {
    const mailStore = seedFolders();
    const wrapper = mountColumns();
    addColumnFor(2);
    await nextTick();

    mailStore.selectFolder(3);
    await nextTick();

    const columns = columnsOf(wrapper);
    expect(columns[0].attributes('aria-label')).toBe('Projects messages, column 1');
    expect(columns[0].findAll('.msg-list__item')).toHaveLength(1);
    expect(columns[1].attributes('aria-label')).toBe('Archive messages, column 2');
    expect(columns[1].findAll('.msg-list__item')).toHaveLength(2);
    expect(mailStore.currentFolderId).toBe(3);
  });

  it('opens a message from another column without changing the primary column or the folder list selection', async () => {
    const mailStore = seedFolders();
    const wrapper = mountColumns();
    addColumnFor(2);
    await nextTick();

    const columns = columnsOf(wrapper);
    await columns[1].findAll('.msg-list__content')[1].trigger('click');
    await nextTick();

    expect(mailStore.selectedMessageId).toBe(22);
    expect(mailStore.selectedMessageFolderId).toBe(2);
    expect(mailStore.openMessage?.subject).toBe('Subject 22');
    expect(mailStore.currentFolderId).toBe(1);
    expect(columns[0].attributes('aria-label')).toBe('Inbox messages, column 1');
    expect(columns[0].findAll('li.is-focused')).toHaveLength(0);
    expect(columns[1].findAll('li.is-focused').map((row) => row.attributes('id'))).toEqual([
      `msg-row-${useMessageColumnsStore().columns[1].id}-22`,
    ]);

    // Clicking the open row again closes the reading pane, as in one list.
    await columns[1].findAll('.msg-list__content')[1].trigger('click');
    expect(mailStore.selectedMessageId).toBeNull();

    // Checking a row in the primary column claims the one selection for Inbox.
    await columns[0].findAll('.msg-list__check input')[0].trigger('click');
    expect([...mailStore.selectedIds]).toEqual([1]);
    expect(mailStore.selectionFolderId).toBe(1);
    // Checking in the other column replaces it rather than merging across folders.
    await columns[1].findAll('.msg-list__check input')[0].trigger('click');
    expect([...mailStore.selectedIds]).toEqual([21]);
    expect(mailStore.selectionFolderId).toBe(2);
    expect(columns[0].findAll('li.is-selected')).toHaveLength(0);
    expect(columns[1].findAll('li.is-selected')).toHaveLength(1);
  });

  it('keeps row DOM ids and aria-activedescendant unique when two columns show one folder', async () => {
    const mailStore = seedFolders();
    const wrapper = mountColumns();
    const id = addColumnFor(1);
    await nextTick();

    const columns = columnsOf(wrapper);
    expect(columns[0].find('li').attributes('id')).toBe('msg-row-primary-1');
    expect(columns[1].find('li').attributes('id')).toBe(`msg-row-${id}-1`);
    expect(columns[0].attributes('aria-label')).toBe('Inbox messages, column 1');
    expect(columns[1].attributes('aria-label')).toBe('Inbox messages, column 2');

    mailStore.selectMessage(2, 1);
    await nextTick();
    expect(columns[0].find('.msg-list__scroller').attributes('aria-activedescendant')).toBe('msg-row-primary-2');
    expect(columns[1].find('.msg-list__scroller').attributes('aria-activedescendant')).toBe(`msg-row-${id}-2`);
    expect(document.querySelectorAll('#msg-row-primary-2')).toHaveLength(1);
  });

  it('moves dragged rows onto another column and ignores a drop on the column showing their folder', async () => {
    const mailStore = seedFolders();
    const wrapper = mountColumns();
    addColumnFor(2);
    await nextTick();
    const moveSpy = vi.spyOn(mailStore, 'moveMessages')
      .mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 });

    const [inboxColumn, archiveColumn] = columnsOf(wrapper);
    const transfer = makeDataTransfer();
    // A row dragged out of the Archive column names Archive as its source.
    await archiveColumn.findAll('.msg-list__item')[0].trigger('dragstart', { dataTransfer: transfer });
    expect(JSON.parse(transfer.getData(MESSAGE_DRAG_MIME))).toEqual({ ids: [21], sourceFolderId: 2 });

    // Same folder: no highlight, no drop effect, no move.
    await archiveColumn.trigger('dragover', { dataTransfer: transfer });
    await nextTick();
    expect(archiveColumn.classes()).not.toContain('is-drop-valid');
    expect(archiveColumn.classes()).not.toContain('is-drop-invalid');
    expect(transfer.dropEffect).toBe('none');
    await archiveColumn.trigger('drop', { dataTransfer: transfer });
    expect(moveSpy).not.toHaveBeenCalled();

    // The Inbox column accepts the move under the folder list's rules.
    useMessageDragDrop().startMessageDrag(
      { dataTransfer: transfer },
      { messageId: 21, selectedIds: new Set(), sourceFolderId: 2 },
    );
    await inboxColumn.trigger('dragover', { dataTransfer: transfer });
    await nextTick();
    expect(inboxColumn.classes()).toContain('is-drop-valid');
    expect(transfer.dropEffect).toBe('move');
    await inboxColumn.trigger('drop', { dataTransfer: transfer });
    await nextTick();
    expect(moveSpy).toHaveBeenCalledWith([21], 1, { sourceFolderId: 2 });
    expect(inboxColumn.classes()).not.toContain('is-drop-valid');
  });

  it('routes global shortcuts to the column whose rows are checked', async () => {
    const mailStore = seedFolders();
    useSettingsStore().settings = { shortcutScheme: 'thunderbird' };
    const wrapper = mountColumns();
    addColumnFor(2);
    await nextTick();
    mountShortcutBroker();

    const columns = columnsOf(wrapper);
    await columns[1].findAll('.msg-list__check input')[1].trigger('click');
    expect(mailStore.selectionFolderId).toBe(2);

    // Ctrl+A extends the checked column's selection, not the primary column's.
    fireKey('a', { ctrlKey: true });
    await nextTick();
    expect([...mailStore.selectedIds].sort((a, b) => a - b)).toEqual([21, 22]);
    expect(mailStore.selectionFolderId).toBe(2);

    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);
    fireKey('Delete');
    await Promise.resolve();
    expect(destroySpy).toHaveBeenCalledWith([21, 22], { sourceFolderId: 2 });

    // With nothing checked, the open message's column is the target.
    mailStore.clearSelection();
    mailStore.selectMessage(3, 1);
    const archiveSpy = vi.spyOn(mailStore, 'archiveMessages')
      .mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 });
    fireKey('a');
    expect(archiveSpy).toHaveBeenCalledWith([3], { sourceFolderId: 1 });
  });
});
