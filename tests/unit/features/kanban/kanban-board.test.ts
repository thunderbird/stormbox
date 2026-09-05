// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  computed, defineComponent, h, nextTick, ref,
} from 'vue';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

// happy-dom has no layout, so the virtualizer is replaced by one that
// exposes every row.
vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (optionsRef) => computed(() => ({
    getTotalSize: () => Number(optionsRef.value.count ?? 0) * 64,
    getVirtualItems: () => Array.from(
      { length: Number(optionsRef.value.count ?? 0) },
      (_, index) => ({
        index,
        key: optionsRef.value.getItemKey?.(index) ?? index,
        start: index * 64,
        size: 64,
      }),
    ),
    scrollToIndex: () => {},
    measure: () => {},
  })),
}));

import KanbanBoard from '../../../../src/features/kanban/KanbanBoard.vue';
import KanbanColumn from '../../../../src/features/kanban/KanbanColumn.vue';
import { useKanbanStore } from '../../../../src/features/kanban/kanban-store';
import { QUICK_FILTER_MAX_ROWS } from '../../../../src/features/kanban/useFolderWindow';
import { useAuthStore } from '../../../../src/stores/auth-store';
import { useMailStore } from '../../../../src/stores/mail-store';
import { useSettingsStore } from '../../../../src/stores/settings-store';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../../src/composables/useRepository';
import { useMessageDragDrop } from '../../../../src/composables/useMessageDragDrop';
import {
  invokeThunderbirdShortcut,
  useThunderbirdShortcuts,
} from '../../../../src/composables/useThunderbirdShortcuts';
import { TABLE_FAMILIES } from '../../../../src/db/protocol';

const INBOX = 1;
const NEEDS_REPLY = 2;
const BLOCKED = 3;
const ARCHIVE = 4;
const HIDDEN = 5;

function makeFolder(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    account_id: 1,
    remote_id: `mb-${id}`,
    name: `Folder ${id}`,
    role: null,
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
    is_seen: 1,
    is_flagged: 0,
    has_attachment: 0,
    view_position: 0,
    ...overrides,
  } as any;
}

function makeRepo(byFolder: Record<number, any[]>) {
  const listeners = new Set<(tables: string[]) => void>();
  const repo = {
    ensureFolderWindowCalls: [] as Array<[number, number, any]>,
    subscribe(fn: (tables: string[]) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    broadcast(tables: string[]) {
      for (const fn of listeners) fn(tables);
    },
    async listMessagesForView({ folderId, offset, limit }) {
      return (byFolder[folderId] ?? []).slice(offset, offset + limit);
    },
    async queryViewProgress({ folderId }) {
      return { total: (byFolder[folderId] ?? []).length, stale: false };
    },
    async ensureFolderWindow(accountId: number, folderId: number, opts: any) {
      repo.ensureFolderWindowCalls.push([accountId, folderId, opts]);
      return { total: (byFolder[folderId] ?? []).length };
    },
  };
  return repo;
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

function seedFolders() {
  const mailStore = useMailStore();
  mailStore.folders = [
    makeFolder(INBOX, { name: 'Inbox', role: 'inbox', total_emails: 2 }),
    makeFolder(NEEDS_REPLY, { name: 'Needs Reply', total_emails: 2 }),
    makeFolder(BLOCKED, { name: 'Blocked', total_emails: 1 }),
    makeFolder(ARCHIVE, { name: 'Archive', role: 'archive', total_emails: 0 }),
    makeFolder(HIDDEN, { name: 'Unsubscribed', is_subscribed: 0 }),
  ];
  mailStore.currentFolderId = INBOX;
  return mailStore;
}

const ROWS = {
  [INBOX]: [makeRow(11, { view_position: 0 }), makeRow(12, { view_position: 1 })],
  [NEEDS_REPLY]: [makeRow(21, { view_position: 0 }), makeRow(22, { view_position: 1 })],
  [BLOCKED]: [makeRow(31, { view_position: 0 })],
};

let repo: ReturnType<typeof makeRepo>;

function columnByLabel(wrapper, label: string) {
  return wrapper.findAll('[data-kanban-column]').find((c) => c.attributes('data-kanban-column') === label)!;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  __resetRepositoryForTests();
  useAuthStore().accountId = 1;
  repo = makeRepo(ROWS);
  __setRepositoryForTests(repo);
});

afterEach(() => {
  useMessageDragDrop().endMessageDrag();
  vi.restoreAllMocks();
});

describe('KanbanBoard', () => {
  it('renders the Inbox fixed in column one and pickers for the two empty slots', async () => {
    seedFolders();
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const columns = wrapper.findAll('[data-kanban-column]');
    expect(columns.map((c) => c.attributes('data-kanban-column'))).toEqual(['Column 1', 'Column 2', 'Column 3']);
    expect(columns[0].find('.kanban-column__title').text()).toBe('Inbox');
    expect(columns[0].find('.kanban-picker').exists()).toBe(false);
    expect(columns[0].findAll('.msg-list__item').map((r) => r.text())).toEqual([
      expect.stringContaining('Subject 11'),
      expect.stringContaining('Subject 12'),
    ]);
    expect(columns[0].find('.kanban-column__count').text()).toBe('2');

    for (const col of columns.slice(1)) {
      expect(col.classes()).toContain('is-empty-slot');
      expect(col.find('.kanban-picker').exists()).toBe(true);
      expect(col.text()).toContain('Pick a folder to fill this column.');
    }
  });

  it('shows the persisted folders in columns two and three and loads their rows', async () => {
    seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);

    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const second = columnByLabel(wrapper, 'Column 2');
    const third = columnByLabel(wrapper, 'Column 3');
    expect(second.find('.kanban-picker__name').text()).toBe('Needs Reply');
    expect(second.findAll('.msg-list__item')).toHaveLength(2);
    expect(third.find('.kanban-picker__name').text()).toBe('Blocked');
    expect(third.findAll('.msg-list__item')).toHaveLength(1);
    expect(third.find('.kanban-column__count').text()).toBe('1');
  });

  it('picker excludes the Inbox, the other column\'s folder and unsubscribed folders', async () => {
    seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    // Same order as the sidebar: role folders first, then user folders,
    // then the option to leave the column empty.
    const names = (label: string) => columnByLabel(wrapper, label)
      .findAll('.kanban-picker__item-name').map((n) => n.text());
    expect(names('Column 2')).toEqual(['Archive', 'Needs Reply', 'Leave empty']);
    expect(names('Column 3')).toEqual(['Archive', 'Blocked', 'Leave empty']);
  });

  it('"Leave empty" clears the slot and shows the empty-slot state', async () => {
    seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    await columnByLabel(wrapper, 'Column 3').find('[data-testid="kanban-picker-none"]').trigger('click');
    await flushPromises();

    expect(kanban.columnFolderRemoteIds).toEqual(['mb-2', null]);
    const third = columnByLabel(wrapper, 'Column 3');
    expect(third.classes()).toContain('is-empty-slot');
    expect(third.find('.kanban-column__count').exists()).toBe(false);
    expect(third.find('[data-testid="kanban-picker-none"]').attributes('aria-selected')).toBe('true');
  });

  it('picking a folder persists its JMAP id and swaps the column contents', async () => {
    seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const second = columnByLabel(wrapper, 'Column 2');
    const option = second.findAll('.kanban-picker__item')
      .find((item) => item.text().includes('Needs Reply'))!;
    await option.trigger('click');
    await flushPromises();

    expect(kanban.columnFolderRemoteIds).toEqual(['mb-2', null]);
    expect(columnByLabel(wrapper, 'Column 2').findAll('.msg-list__item')).toHaveLength(2);
    // Column 3 can no longer pick the folder column 2 took.
    expect(columnByLabel(wrapper, 'Column 3').findAll('.kanban-picker__item-name').map((n) => n.text()))
      .toEqual(['Archive', 'Blocked', 'Leave empty']);
  });

  it('compact mode hides only the rightmost column and sizes the board to the two that stay', async () => {
    seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const wrapper = mount(KanbanBoard, { props: { compact: true } });
    await flushPromises();

    expect(wrapper.classes()).toContain('kanban-board--compact');
    expect(wrapper.findAll('.kanban-board__column--last')).toHaveLength(1);
    expect(columnByLabel(wrapper, 'Column 3').classes()).toContain('kanban-board__column--last');
    expect(columnByLabel(wrapper, 'Column 2').classes()).not.toContain('kanban-board__column--last');
    // Column two keeps loading rows while a message is open.
    expect(columnByLabel(wrapper, 'Column 2').findAll('.msg-list__item')).toHaveLength(2);
    // Two 360px columns plus two 6px handles.
    expect(wrapper.attributes('style')).toContain('width: 732px');

    const source = readFileSync(resolve(process.cwd(), 'src/features/kanban/KanbanBoard.vue'), 'utf8');
    expect(source).toMatch(/\.kanban-board--compact \.kanban-board__column--last\s*\{[^}]*display:\s*none/);
    expect(source).not.toMatch(/kanban-board__column--secondary/);

    await wrapper.setProps({ compact: false });
    expect(wrapper.attributes('style') ?? '').not.toContain('width:');
  });

  it('narrows every column to rows matching the quick filter', async () => {
    seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const wrapper = mount(KanbanBoard, { props: { quickFilterQuery: 'Subject 22' } });
    await flushPromises();

    expect(columnByLabel(wrapper, 'Column 1').findAll('.msg-list__item')).toHaveLength(0);
    expect(columnByLabel(wrapper, 'Column 2').findAll('.msg-list__item').map((r) => r.text()))
      .toEqual([expect.stringContaining('Subject 22')]);
    expect(columnByLabel(wrapper, 'Column 3').findAll('.msg-list__item')).toHaveLength(0);
  });
});

describe('KanbanBoard drag and drop', () => {
  it('a row drag carries its own column\'s folder as the source, not the open folder', async () => {
    seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const transfer = makeDataTransfer();
    const row = columnByLabel(wrapper, 'Column 2').find('.msg-list__item');
    await row.trigger('dragstart', { dataTransfer: transfer });

    const dnd = useMessageDragDrop();
    expect(dnd.isDragging.value).toBe(true);
    expect(dnd.sourceFolderId.value).toBe(NEEDS_REPLY);
    expect(dnd.draggedIds.value).toEqual([21]);
    expect(useMailStore().currentFolderId).toBe(INBOX);
  });

  it('dropping on a column moves the ids into that folder with the drag\'s source folder', async () => {
    const mailStore = seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const moveSpy = vi.spyOn(mailStore, 'moveMessages')
      .mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 } as any);
    const wrapper = mount(KanbanBoard);
    await flushPromises();
    repo.ensureFolderWindowCalls.length = 0;

    const transfer = makeDataTransfer();
    await columnByLabel(wrapper, 'Column 2').find('.msg-list__item')
      .trigger('dragstart', { dataTransfer: transfer });
    const target = columnByLabel(wrapper, 'Column 3');
    await target.trigger('dragenter', { dataTransfer: transfer });
    await target.trigger('dragover', { dataTransfer: transfer });
    await nextTick();
    expect(target.classes()).toContain('is-drop-move');

    await target.trigger('drop', { dataTransfer: transfer });
    await flushPromises();

    expect(moveSpy).toHaveBeenCalledWith([21], BLOCKED, { sourceFolderId: NEEDS_REPLY });
    // Both the destination and the source column go back to the server.
    const refreshed = repo.ensureFolderWindowCalls.map(([, folderId]) => folderId).sort();
    expect(refreshed).toEqual([NEEDS_REPLY, BLOCKED]);
    expect(target.classes()).not.toContain('is-drop-move');
    expect(useMessageDragDrop().isDragging.value).toBe(false);
  });

  it('flags a drop onto the source column as invalid and does not move', async () => {
    const mailStore = seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const moveSpy = vi.spyOn(mailStore, 'moveMessages');
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const transfer = makeDataTransfer();
    const source = columnByLabel(wrapper, 'Column 2');
    await source.find('.msg-list__item').trigger('dragstart', { dataTransfer: transfer });
    await source.trigger('dragenter', { dataTransfer: transfer });
    await nextTick();
    expect(source.classes()).toContain('is-drop-invalid');

    await source.trigger('drop', { dataTransfer: transfer });
    await flushPromises();
    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('ignores drops that carry no message payload', async () => {
    const mailStore = seedFolders();
    const moveSpy = vi.spyOn(mailStore, 'moveMessages');
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const transfer = makeDataTransfer();
    transfer.setData('text/plain', 'hello');
    await columnByLabel(wrapper, 'Column 1').trigger('drop', { dataTransfer: transfer });
    await flushPromises();
    expect(moveSpy).not.toHaveBeenCalled();
  });
});

describe('KanbanBoard open-message flow', () => {
  it('selects the row\'s folder first and only selects the message once it is in the list', async () => {
    const mailStore = seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);

    const calls: string[] = [];
    vi.spyOn(mailStore, 'selectFolder').mockImplementation((id) => {
      calls.push(`selectFolder:${id}`);
      mailStore.currentFolderId = id;
      mailStore.messages = [];
    });
    vi.spyOn(mailStore, 'setRequestedRange').mockImplementation(() => {});
    vi.spyOn(mailStore, 'ensureLoaded').mockImplementation(async () => {
      calls.push('ensureLoaded');
      mailStore.messages = [ROWS[NEEDS_REPLY][0], ROWS[NEEDS_REPLY][1]];
    });
    vi.spyOn(mailStore, 'selectMessage').mockImplementation((id) => {
      calls.push(`selectMessage:${id}`);
      expect(mailStore.messages.some((m) => m?.id === id)).toBe(true);
    });

    const wrapper = mount(KanbanBoard);
    await flushPromises();

    await columnByLabel(wrapper, 'Column 2').findAll('.msg-list__content')[1].trigger('click');
    await flushPromises();

    expect(calls).toEqual([`selectFolder:${NEEDS_REPLY}`, 'ensureLoaded', 'selectMessage:22']);
  });

  it('does not re-select the folder when the row already belongs to the open one', async () => {
    const mailStore = seedFolders();
    mailStore.messages = ROWS[INBOX];
    const selectFolder = vi.spyOn(mailStore, 'selectFolder');
    const ensureLoaded = vi.spyOn(mailStore, 'ensureLoaded').mockResolvedValue(undefined as any);
    const selectMessage = vi.spyOn(mailStore, 'selectMessage').mockImplementation(() => {});

    const wrapper = mount(KanbanBoard);
    await flushPromises();
    await columnByLabel(wrapper, 'Column 1').find('.msg-list__content').trigger('click');
    await flushPromises();

    expect(selectFolder).not.toHaveBeenCalled();
    expect(ensureLoaded).not.toHaveBeenCalled();
    expect(selectMessage).toHaveBeenCalledWith(11);
  });

  it('clicking the already-open row closes the message view', async () => {
    const mailStore = seedFolders();
    mailStore.messages = ROWS[INBOX];
    mailStore.selectedMessageId = 11;
    const selectMessage = vi.spyOn(mailStore, 'selectMessage').mockImplementation(() => {});

    const wrapper = mount(KanbanBoard);
    await flushPromises();
    await columnByLabel(wrapper, 'Column 1').find('.msg-list__content').trigger('click');
    await flushPromises();

    expect(selectMessage).toHaveBeenCalledWith(null);
  });

  it('gives up quietly when the row never pages in', async () => {
    const mailStore = seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    vi.spyOn(mailStore, 'selectFolder').mockImplementation((id) => {
      mailStore.currentFolderId = id;
      mailStore.messages = [];
    });
    vi.spyOn(mailStore, 'setRequestedRange').mockImplementation(() => {});
    const ensureLoaded = vi.spyOn(mailStore, 'ensureLoaded').mockResolvedValue(undefined as any);
    const selectMessage = vi.spyOn(mailStore, 'selectMessage').mockImplementation(() => {});

    const wrapper = mount(KanbanBoard);
    await flushPromises();
    await columnByLabel(wrapper, 'Column 2').find('.msg-list__content').trigger('click');
    await flushPromises();

    expect(ensureLoaded).toHaveBeenCalledTimes(3);
    // selectMessage on an id the store cannot see would treat the row as
    // unread and queue a mark-read against it, so nothing is selected.
    expect(selectMessage).not.toHaveBeenCalled();
    expect(mailStore.selectedMessageId).toBeNull();
  });
});

describe('KanbanColumn rows', () => {
  it('renders rows with the same selection checkbox as the message list', async () => {
    seedFolders();
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const rows = wrapper.findAll('.msg-list__item');
    expect(rows.length).toBeGreaterThan(0);
    expect(wrapper.findAll('.msg-list__check')).toHaveLength(rows.length);
  });

  it('header count follows the quick filter, like the list header does', async () => {
    seedFolders();
    const wrapper = mount(KanbanColumn, {
      props: { folderId: NEEDS_REPLY, label: 'Column 2', quickFilterQuery: '' },
    });
    await flushPromises();
    expect(wrapper.find('.kanban-column__count').text()).toBe('2');

    await wrapper.setProps({ quickFilterQuery: 'Subject 22' });
    await flushPromises();
    const count = wrapper.find('.kanban-column__count');
    expect(count.text()).toBe('1');
    expect(count.attributes('aria-label')).toBe('1 matching');
  });

  it('labels the column region by its folder, not its slot number', async () => {
    seedFolders();
    const wrapper = mount(KanbanColumn, { props: { folderId: NEEDS_REPLY, label: 'Column 2' } });
    await flushPromises();
    expect(wrapper.attributes('aria-label')).toBe('Needs Reply');

    await wrapper.setProps({ folderId: null });
    expect(wrapper.attributes('aria-label')).toBe('Column 2');
  });
});

describe('KanbanColumn keyboard', () => {
  async function mountColumn() {
    seedFolders();
    const rows = {
      ...ROWS,
      [NEEDS_REPLY]: [
        makeRow(21, { view_position: 0 }),
        makeRow(22, { view_position: 1, is_seen: 0 }),
        makeRow(23, { view_position: 2 }),
      ],
    };
    repo = makeRepo(rows);
    __setRepositoryForTests(repo);
    const wrapper = mount(KanbanColumn, { props: { folderId: NEEDS_REPLY, label: 'Column 2' } });
    await flushPromises();
    return wrapper;
  }

  it('the list is focusable and arrows move the cursor, opening each row', async () => {
    const wrapper = await mountColumn();
    const scroller = wrapper.find('.kanban-column__scroller');
    expect(scroller.attributes('tabindex')).toBe('0');
    expect(scroller.attributes('aria-activedescendant')).toBeUndefined();

    await scroller.trigger('focus');
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-21');
    // Taking focus places the cursor without painting a row: only the
    // message being read is highlighted.
    expect(wrapper.find('#msg-row-21').classes()).not.toContain('is-focused');

    await scroller.trigger('keydown', { key: 'ArrowDown' });
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-22');
    expect(wrapper.emitted('open')?.at(-1)?.[0]).toMatchObject({ id: 22 });

    await scroller.trigger('keydown', { key: 'End' });
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-23');
    await scroller.trigger('keydown', { key: 'Home' });
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-21');
    await scroller.trigger('keydown', { key: 'ArrowUp' });
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-21');

    await scroller.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('open')).toHaveLength(4);
    expect(wrapper.emitted('open')?.at(-1)?.[0]).toMatchObject({ id: 21 });
  });

  it('owns the app\'s f/b/n/p/Home/End shortcuts once focused', async () => {
    // Those are the Thunderbird scheme's keys; the web scheme routes j/k/n/p
    // through the same registered commands.
    useSettingsStore().settings = { shortcutScheme: 'thunderbird' };
    const wrapper = await mountColumn();
    // The App shell binds the shortcuts; a bare host stands in for it.
    const host = mount(defineComponent({
      setup() {
        useThunderbirdShortcuts({ space: ref('mail'), enabled: ref(true) });
        return () => h('div');
      },
    }));
    const scroller = wrapper.find('.kanban-column__scroller');
    await scroller.trigger('focus');

    const press = async (key: string) => {
      invokeThunderbirdShortcut(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await nextTick();
    };
    await press('f');
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-22');
    await press('End');
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-23');
    await press('p');
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-22');
    await press('b');
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-21');
    await press('n');
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-22');
    host.unmount();
  });

  it('drops the cursor when its row leaves the column', async () => {
    const wrapper = await mountColumn();
    const scroller = wrapper.find('.kanban-column__scroller');
    await scroller.trigger('focus');
    await scroller.trigger('keydown', { key: 'ArrowDown' });
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-22');

    await wrapper.setProps({ quickFilterQuery: 'Subject 23' });
    await flushPromises();
    await nextTick();
    expect(scroller.attributes('aria-activedescendant')).toBeUndefined();
  });
});

describe('KanbanColumn selection', () => {
  const THREE_ROWS = [
    makeRow(21, { view_position: 0 }),
    makeRow(22, { view_position: 1, is_seen: 0 }),
    makeRow(23, { view_position: 2 }),
  ];

  async function mountColumn(folderId = NEEDS_REPLY, label = 'Column 2') {
    seedFolders();
    const rows = { ...ROWS, [NEEDS_REPLY]: THREE_ROWS.map((row) => ({ ...row })) };
    repo = makeRepo(rows);
    __setRepositoryForTests(repo);
    const wrapper = mount(KanbanColumn, { props: { folderId, label } });
    await flushPromises();
    return { wrapper, rows };
  }

  const checkbox = (wrapper, id: number) => wrapper.find(`#msg-row-${id} .msg-list__check input`);
  const selectedIds = (wrapper) => wrapper.findAll('li.is-selected')
    .map((row) => Number(row.attributes('id')!.replace('msg-row-', '')));
  const header = (wrapper) => wrapper.find('.kanban-column__header');
  const bulkAction = (wrapper, title: string) => header(wrapper).find(`.selectable-list-header__selection-actions [title="${title}"]`);

  it('checkbox clicks toggle rows and swap the header for the bulk actions', async () => {
    const { wrapper } = await mountColumn();
    expect(header(wrapper).find('.kanban-column__count').text()).toBe('3');
    expect(header(wrapper).find('.selectable-list-header__selection-actions').exists()).toBe(false);

    await checkbox(wrapper, 22).trigger('click');
    expect(selectedIds(wrapper)).toEqual([22]);
    expect(wrapper.find('#msg-row-22').attributes('aria-selected')).toBe('true');
    expect(useKanbanStore().selectionFolderId).toBe(NEEDS_REPLY);
    expect([...useKanbanStore().selectedIds]).toEqual([22]);
    // A checkbox never opens the row.
    expect(wrapper.emitted('open')).toBeUndefined();

    const actions = header(wrapper).findAll('.selectable-list-header__selection-actions button');
    expect(actions.map((button) => button.attributes('title'))).toEqual([
      'Archive', 'Junk', 'Delete', 'Mark as read', 'Mark as unread', 'Clear selection',
    ]);
    expect(header(wrapper).find('.selectable-list-header__count').text()).toBe('1 selected');
    expect(header(wrapper).find('.kanban-column__count').exists()).toBe(false);

    await checkbox(wrapper, 22).trigger('click');
    expect(selectedIds(wrapper)).toEqual([]);
    expect(header(wrapper).find('.kanban-column__count').text()).toBe('3');
  });

  it('shift-click extends the range, modifier clicks on the row body toggle, a plain click clears and opens', async () => {
    const { wrapper } = await mountColumn();
    await checkbox(wrapper, 21).trigger('click');
    await checkbox(wrapper, 23).trigger('click', { shiftKey: true });
    expect(selectedIds(wrapper)).toEqual([21, 22, 23]);

    await wrapper.find('#msg-row-22 .msg-list__item').trigger('click', { ctrlKey: true });
    expect(selectedIds(wrapper)).toEqual([21, 23]);
    expect(wrapper.emitted('open')).toBeUndefined();

    await wrapper.find('#msg-row-22 .msg-list__item').trigger('click');
    expect(selectedIds(wrapper)).toEqual([]);
    expect(wrapper.emitted('open')?.at(-1)?.[0]).toMatchObject({ id: 22 });
  });

  it('keyboard: Space toggles the cursor row, Shift+Arrow extends, Ctrl+A selects all, Esc clears', async () => {
    const { wrapper } = await mountColumn();
    const scroller = wrapper.find('.kanban-column__scroller');
    await scroller.trigger('focus');
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-21');

    await scroller.trigger('keydown', { key: ' ' });
    expect(selectedIds(wrapper)).toEqual([21]);
    expect(wrapper.emitted('open')).toBeUndefined();

    await scroller.trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    expect(selectedIds(wrapper)).toEqual([21, 22]);
    expect(scroller.attributes('aria-activedescendant')).toBe('msg-row-22');
    // Extending the selection does not open the row under the cursor.
    expect(wrapper.emitted('open')).toBeUndefined();

    await scroller.trigger('keydown', { key: 'Escape' });
    expect(selectedIds(wrapper)).toEqual([]);

    await scroller.trigger('keydown', { key: 'a', ctrlKey: true });
    await flushPromises();
    expect(selectedIds(wrapper)).toEqual([21, 22, 23]);
  });

  it('the header checkbox selects every row and clears again; the X clears', async () => {
    const { wrapper } = await mountColumn();
    const selectAll = header(wrapper).find('.selectable-list-header__select-all input');
    expect(selectAll.exists()).toBe(true);

    await selectAll.trigger('change');
    await flushPromises();
    expect(selectedIds(wrapper)).toEqual([21, 22, 23]);
    expect((selectAll.element as HTMLInputElement).checked).toBe(true);

    await bulkAction(wrapper, 'Clear selection').trigger('click');
    expect(selectedIds(wrapper)).toEqual([]);

    await checkbox(wrapper, 21).trigger('click');
    expect((selectAll.element as HTMLInputElement).indeterminate).toBe(true);
    await selectAll.trigger('change');
    expect(selectedIds(wrapper)).toEqual([]);
  });

  it('the app-wide select-all shortcut selects the focused column', async () => {
    const { wrapper } = await mountColumn();
    const host = mount(defineComponent({
      setup() {
        useThunderbirdShortcuts({ space: ref('mail'), enabled: ref(true) });
        return () => h('div');
      },
    }));
    await wrapper.find('.kanban-column__scroller').trigger('focus');
    // Web scheme: `*` then `a`.
    invokeThunderbirdShortcut(new KeyboardEvent('keydown', {
      key: '*', shiftKey: true, bubbles: true, cancelable: true,
    }));
    invokeThunderbirdShortcut(new KeyboardEvent('keydown', {
      key: 'a', bubbles: true, cancelable: true,
    }));
    await flushPromises();
    expect(selectedIds(wrapper)).toEqual([21, 22, 23]);
    host.unmount();
  });

  it('bulk actions run the store actions against this column\'s folder, not the open one', async () => {
    const { wrapper } = await mountColumn();
    const mailStore = useMailStore();
    expect(mailStore.currentFolderId).toBe(INBOX);
    const archiveSpy = vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({ succeeded: 2, failed: 0, skipped: 0 });
    const junkSpy = vi.spyOn(mailStore, 'junkMessages').mockResolvedValue({ succeeded: 2, failed: 0, skipped: 0 });
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);
    const seenSpy = vi.spyOn(mailStore, 'markManySeen').mockResolvedValue(2);

    await checkbox(wrapper, 21).trigger('click');
    await checkbox(wrapper, 23).trigger('click');
    const rowsFor = (ids: number[]) => expect.arrayContaining(ids.map((id) => expect.objectContaining({ id })));

    await bulkAction(wrapper, 'Mark as read').trigger('click');
    await flushPromises();
    expect(seenSpy).toHaveBeenLastCalledWith([21, 23], true, { rows: rowsFor([21, 23]) });
    // Read/unread keep the selection, like the list.
    expect(selectedIds(wrapper)).toEqual([21, 23]);
    expect(wrapper.emitted('moved')).toBeUndefined();

    await bulkAction(wrapper, 'Mark as unread').trigger('click');
    await flushPromises();
    expect(seenSpy).toHaveBeenLastCalledWith([21, 23], false, { rows: rowsFor([21, 23]) });

    await bulkAction(wrapper, 'Archive').trigger('click');
    await flushPromises();
    expect(archiveSpy).toHaveBeenCalledWith([21, 23], { sourceFolderId: NEEDS_REPLY });
    expect(wrapper.emitted('moved')?.at(-1)?.[0]).toEqual({
      ids: [21, 23], sourceFolderId: NEEDS_REPLY, targetFolderId: ARCHIVE,
    });

    await bulkAction(wrapper, 'Junk').trigger('click');
    await flushPromises();
    expect(junkSpy).toHaveBeenCalledWith([21, 23], { sourceFolderId: NEEDS_REPLY, rows: rowsFor([21, 23]) });
    // No Junk folder is configured in this fixture: the target is unknown.
    expect(wrapper.emitted('moved')?.at(-1)?.[0]).toMatchObject({ sourceFolderId: NEEDS_REPLY, targetFolderId: null });

    await bulkAction(wrapper, 'Delete').trigger('click');
    await flushPromises();
    expect(destroySpy).toHaveBeenCalledWith([21, 23], { sourceFolderId: NEEDS_REPLY });
  });

  it('checked rows that leave the folder leave the selection once the window settles', async () => {
    const { wrapper, rows } = await mountColumn();
    await checkbox(wrapper, 21).trigger('click');
    await checkbox(wrapper, 22).trigger('click');
    expect(selectedIds(wrapper)).toEqual([21, 22]);

    // Row 21 is moved away (by anyone); the column re-reads its rows.
    rows[NEEDS_REPLY].splice(0, 1);
    repo.broadcast([TABLE_FAMILIES.MESSAGES]);
    await flushPromises();
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(2);
    expect(selectedIds(wrapper)).toEqual([22]);
    expect([...useKanbanStore().selectedIds]).toEqual([22]);
  });

  it('the selection belongs to the folder shown: swapping folders or unmounting drops it', async () => {
    const { wrapper } = await mountColumn();
    const kanban = useKanbanStore();
    await checkbox(wrapper, 21).trigger('click');
    expect(kanban.hasSelection).toBe(true);

    await wrapper.setProps({ folderId: BLOCKED });
    await flushPromises();
    expect(kanban.hasSelection).toBe(false);
    expect(selectedIds(wrapper)).toEqual([]);

    await checkbox(wrapper, 31).trigger('click');
    expect(kanban.selectionFolderId).toBe(BLOCKED);
    wrapper.unmount();
    expect(kanban.hasSelection).toBe(false);
  });
});

describe('KanbanBoard selection', () => {
  async function mountBoard(rows: Record<number, any[]> = ROWS) {
    const mailStore = seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    repo = makeRepo(rows);
    __setRepositoryForTests(repo);
    const wrapper = mount(KanbanBoard);
    await flushPromises();
    return { wrapper, mailStore, kanban };
  }
  const checkbox = (column, id: number) => column.find(`#msg-row-${id} .msg-list__check input`);
  const selectedIn = (column) => column.findAll('li.is-selected')
    .map((row) => Number(row.attributes('id')!.replace('msg-row-', '')));

  it('holds one selection at a time: checking a row in another column moves it there', async () => {
    const { wrapper, kanban } = await mountBoard();
    const second = columnByLabel(wrapper, 'Column 2');
    const third = columnByLabel(wrapper, 'Column 3');

    await checkbox(second, 21).trigger('click');
    await checkbox(second, 22).trigger('click');
    expect(selectedIn(second)).toEqual([21, 22]);
    expect(kanban.selectionFolderId).toBe(NEEDS_REPLY);

    await checkbox(third, 31).trigger('click');
    expect(selectedIn(third)).toEqual([31]);
    expect(selectedIn(second)).toEqual([]);
    expect(kanban.selectionFolderId).toBe(BLOCKED);
    expect(second.find('.selectable-list-header__selection-actions').exists()).toBe(false);
    expect(third.find('.selectable-list-header__selection-actions').exists()).toBe(true);
    expect(third.find('.selectable-list-header__count').text()).toBe('1 selected');
  });

  it('dragging a checked row carries the whole selection to the drop column and prunes it after the move', async () => {
    const rows = { ...ROWS, [NEEDS_REPLY]: [...ROWS[NEEDS_REPLY]], [BLOCKED]: [...ROWS[BLOCKED]] };
    const { wrapper, mailStore, kanban } = await mountBoard(rows);
    const moveSpy = vi.spyOn(mailStore, 'moveMessages').mockImplementation(async (ids: number[], target: number) => {
      // Server-side outcome, as the cache would reflect it after the outbox ran.
      rows[NEEDS_REPLY] = rows[NEEDS_REPLY].filter((row) => !ids.includes(row.id));
      rows[target].push(...ROWS[NEEDS_REPLY].filter((row) => ids.includes(row.id)));
      return { succeeded: ids.length, failed: 0, skipped: 0 } as any;
    });
    const second = columnByLabel(wrapper, 'Column 2');
    const third = columnByLabel(wrapper, 'Column 3');
    await checkbox(second, 21).trigger('click');
    await checkbox(second, 22).trigger('click');
    repo.ensureFolderWindowCalls.length = 0;

    const transfer = makeDataTransfer();
    await second.find('#msg-row-22 .msg-list__item').trigger('dragstart', { dataTransfer: transfer });
    expect(transfer.getData('text/plain')).toBe('2 messages');
    await third.trigger('dragenter', { dataTransfer: transfer });
    await third.trigger('drop', { dataTransfer: transfer });
    await flushPromises();

    expect(moveSpy).toHaveBeenCalledWith([21, 22], BLOCKED, { sourceFolderId: NEEDS_REPLY });
    const refreshed = repo.ensureFolderWindowCalls.map(([, folderId]) => folderId).sort();
    expect(refreshed).toEqual([NEEDS_REPLY, BLOCKED]);
    await flushPromises();
    expect(second.findAll('.msg-list__item')).toHaveLength(0);
    expect(third.findAll('.msg-list__item')).toHaveLength(3);
    expect(kanban.hasSelection).toBe(false);
    expect(selectedIn(third)).toEqual([]);
  });

  it('dragging an unchecked row moves only that row and leaves the selection alone', async () => {
    const { wrapper, mailStore, kanban } = await mountBoard();
    const moveSpy = vi.spyOn(mailStore, 'moveMessages')
      .mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 } as any);
    const second = columnByLabel(wrapper, 'Column 2');
    const third = columnByLabel(wrapper, 'Column 3');
    await checkbox(second, 21).trigger('click');

    const transfer = makeDataTransfer();
    await second.find('#msg-row-22 .msg-list__item').trigger('dragstart', { dataTransfer: transfer });
    await third.trigger('dragenter', { dataTransfer: transfer });
    await third.trigger('drop', { dataTransfer: transfer });
    await flushPromises();

    expect(moveSpy).toHaveBeenCalledWith([22], BLOCKED, { sourceFolderId: NEEDS_REPLY });
    expect([...kanban.selectedIds]).toEqual([21]);
  });

  it('a bulk action in one column refreshes the column showing its destination', async () => {
    const { wrapper, mailStore } = await mountBoard();
    const kanban = useKanbanStore();
    kanban.setColumnFolder(2, 'mb-4');
    await flushPromises();
    vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 } as any);
    const second = columnByLabel(wrapper, 'Column 2');
    await checkbox(second, 21).trigger('click');
    repo.ensureFolderWindowCalls.length = 0;

    await second.find('.selectable-list-header__selection-actions [title="Archive"]').trigger('click');
    await flushPromises();
    const refreshed = repo.ensureFolderWindowCalls.map(([, folderId]) => folderId).sort();
    expect(refreshed).toEqual([NEEDS_REPLY, ARCHIVE]);
  });

  it('unmounting the board drops the selection', async () => {
    const { wrapper, kanban } = await mountBoard();
    await checkbox(columnByLabel(wrapper, 'Column 2'), 21).trigger('click');
    expect(kanban.hasSelection).toBe(true);
    wrapper.unmount();
    expect(kanban.hasSelection).toBe(false);
  });
});

describe('KanbanBoard compact mode', () => {
  it('pauses the hidden third column and refreshes it once it is shown again', async () => {
    seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const rows = { ...ROWS, [NEEDS_REPLY]: [...ROWS[NEEDS_REPLY]] };
    repo = makeRepo(rows);
    const reads: number[] = [];
    const originalList = repo.listMessagesForView.bind(repo);
    repo.listMessagesForView = async (args) => {
      reads.push(Number(args.folderId));
      return originalList(args);
    };
    __setRepositoryForTests(repo);

    const wrapper = mount(KanbanBoard, { props: { compact: true } });
    await flushPromises();
    reads.length = 0;

    rows[NEEDS_REPLY].push(makeRow(23, { view_position: 2 }));
    repo.broadcast([TABLE_FAMILIES.MESSAGES]);
    await flushPromises();
    expect([...new Set(reads)].sort()).toEqual([INBOX, NEEDS_REPLY]);
    expect(columnByLabel(wrapper, 'Column 2').findAll('.msg-list__item')).toHaveLength(3);

    await wrapper.setProps({ compact: false });
    await flushPromises();
    expect(reads).toContain(BLOCKED);
  });
});

describe('KanbanBoard highlight', () => {
  function wireOpenFlow(mailStore: ReturnType<typeof useMailStore>) {
    vi.spyOn(mailStore, 'selectFolder').mockImplementation((id) => {
      mailStore.currentFolderId = id;
      mailStore.messages = ROWS[id as keyof typeof ROWS] ?? [];
    });
    vi.spyOn(mailStore, 'setRequestedRange').mockImplementation(() => {});
    vi.spyOn(mailStore, 'ensureLoaded').mockResolvedValue(undefined as any);
    vi.spyOn(mailStore, 'selectMessage').mockImplementation((id) => {
      mailStore.selectedMessageId = id;
    });
  }

  it('paints only the message being read, never a column\'s idle cursor', async () => {
    const mailStore = seedFolders();
    mailStore.messages = ROWS[INBOX];
    wireOpenFlow(mailStore);
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const focused = () => wrapper.findAll('li.is-focused').map((li) => li.attributes('id'));

    await columnByLabel(wrapper, 'Column 2').findAll('.msg-list__content')[0].trigger('click');
    await flushPromises();
    expect(focused()).toEqual(['msg-row-21']);

    // Opening a row elsewhere moves the single highlight; column two's
    // cursor stays where it was but is not drawn.
    await columnByLabel(wrapper, 'Column 3').findAll('.msg-list__content')[0].trigger('click');
    await flushPromises();
    expect(focused()).toEqual(['msg-row-31']);
    expect(columnByLabel(wrapper, 'Column 2').find('.kanban-column__scroller').attributes('aria-activedescendant'))
      .toBe('msg-row-21');

    // Closing the message clears the board.
    mailStore.selectedMessageId = null;
    await nextTick();
    expect(focused()).toEqual([]);
  });
});

describe('KanbanBoard primary column', () => {
  it('shows the sidebar\'s folder and follows it, shadowing a pick it duplicates', async () => {
    const mailStore = seedFolders();
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const primary = columnByLabel(wrapper, 'Column 1');
    expect(primary.attributes('aria-label')).toBe('Inbox');
    expect(primary.find('.kanban-column__title').text()).toBe('Inbox');
    expect(primary.find('.kanban-picker').exists()).toBe(false);
    expect(primary.findAll('.msg-list__item')).toHaveLength(2);

    // Sidebar click (the store's current folder changes from outside the board).
    mailStore.currentFolderId = BLOCKED;
    await flushPromises();
    expect(primary.find('.kanban-column__title').text()).toBe('Blocked');
    expect(primary.findAll('.msg-list__item').map((r) => r.text())).toEqual([expect.stringContaining('Subject 31')]);

    const third = columnByLabel(wrapper, 'Column 3');
    expect(third.find('.kanban-picker__name').text()).toBe('Blocked');
    expect(third.find('[data-kanban-shadowed]').text()).toContain('Blocked is open in the first column');
    expect(third.findAll('.msg-list__item')).toHaveLength(0);
    expect(third.find('.kanban-column__count').exists()).toBe(false);
    expect(third.classes()).toContain('is-empty-slot');
    // The picker no longer offers the sidebar's folder to the other columns.
    expect(columnByLabel(wrapper, 'Column 2').findAll('.kanban-picker__item-name').map((n) => n.text()))
      .toEqual(['Inbox', 'Archive', 'Needs Reply', 'Leave empty']);

    mailStore.currentFolderId = INBOX;
    await flushPromises();
    expect(primary.find('.kanban-column__title').text()).toBe('Inbox');
    expect(third.findAll('.msg-list__item')).toHaveLength(1);
  });

  it('does not follow the folder switch the board itself makes to open a row', async () => {
    const mailStore = seedFolders();
    mailStore.messages = ROWS[INBOX];
    vi.spyOn(mailStore, 'selectFolder').mockImplementation((id) => {
      mailStore.currentFolderId = id;
      mailStore.messages = ROWS[id as keyof typeof ROWS] ?? [];
    });
    vi.spyOn(mailStore, 'setRequestedRange').mockImplementation(() => {});
    vi.spyOn(mailStore, 'ensureLoaded').mockResolvedValue(undefined as any);
    vi.spyOn(mailStore, 'selectMessage').mockImplementation((id) => {
      mailStore.selectedMessageId = id;
    });
    const kanban = useKanbanStore();
    kanban.unlock();
    kanban.setDefaultColumns(['mb-2', 'mb-3']);
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    await columnByLabel(wrapper, 'Column 2').findAll('.msg-list__content')[1].trigger('click');
    await flushPromises();

    expect(mailStore.currentFolderId).toBe(NEEDS_REPLY);
    expect(mailStore.selectedMessageId).toBe(22);
    expect(columnByLabel(wrapper, 'Column 1').find('.kanban-column__title').text()).toBe('Inbox');
    expect(columnByLabel(wrapper, 'Column 2').find('[data-kanban-shadowed]').exists()).toBe(false);

    // A later sidebar click is still honoured.
    mailStore.currentFolderId = NEEDS_REPLY;
    await flushPromises();
    expect(columnByLabel(wrapper, 'Column 1').find('.kanban-column__title').text()).toBe('Inbox');
    mailStore.currentFolderId = BLOCKED;
    await flushPromises();
    expect(columnByLabel(wrapper, 'Column 1').find('.kanban-column__title').text()).toBe('Blocked');
  });
});

describe('KanbanBoard column widths', () => {
  const WIDTHS_KEY = 'stormbox.kanban.columnWidths.v1';

  function boardVar(wrapper, name: string) {
    return wrapper.attributes('style')?.match(new RegExp(`${name}: (\\d+)px`))?.[1];
  }

  it('renders a handle after column one and column two with the shell\'s resizer semantics', async () => {
    seedFolders();
    const wrapper = mount(KanbanBoard);
    await flushPromises();

    const handles = wrapper.findAll('[role="separator"]');
    expect(handles.map((h) => h.attributes('data-kanban-resizer'))).toEqual(['inbox', 'second']);
    for (const handle of handles) {
      expect(handle.classes()).toContain('column-resizer');
      expect(handle.attributes('tabindex')).toBe('0');
      expect(handle.attributes('aria-orientation')).toBe('vertical');
      expect(handle.attributes('aria-valuemin')).toBe('280');
      expect(handle.attributes('aria-valuemax')).toBe('720');
      expect(handle.attributes('aria-valuenow')).toBe('360');
    }
    expect(boardVar(wrapper, '--kanban-col-1')).toBe('360');
    expect(boardVar(wrapper, '--kanban-col-2')).toBe('360');
    // Third column: no handle, it takes the remaining width.
    const source = readFileSync(resolve(process.cwd(), 'src/features/kanban/KanbanBoard.vue'), 'utf8');
    expect(source).toMatch(/minmax\(var\(--kanban-col-min\), 1fr\)/);
  });

  it('arrow keys on a handle step the column, clamp to the limits and persist', async () => {
    seedFolders();
    const wrapper = mount(KanbanBoard);
    await flushPromises();
    const handle = wrapper.find('[data-kanban-resizer="inbox"]');

    await handle.trigger('keydown', { key: 'ArrowRight' });
    expect(boardVar(wrapper, '--kanban-col-1')).toBe('370');
    await handle.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
    expect(boardVar(wrapper, '--kanban-col-1')).toBe('410');
    expect(handle.attributes('aria-valuenow')).toBe('410');
    expect(JSON.parse(localStorage.getItem(WIDTHS_KEY)!)).toEqual({ inbox: 410, second: 360 });

    for (let i = 0; i < 20; i += 1) await handle.trigger('keydown', { key: 'ArrowLeft', shiftKey: true });
    expect(boardVar(wrapper, '--kanban-col-1')).toBe('280');
    for (let i = 0; i < 20; i += 1) await handle.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
    expect(boardVar(wrapper, '--kanban-col-1')).toBe('720');
    expect(boardVar(wrapper, '--kanban-col-2')).toBe('360');

    // A fresh board picks the stored widths back up.
    wrapper.unmount();
    const again = mount(KanbanBoard);
    await flushPromises();
    expect(boardVar(again, '--kanban-col-1')).toBe('720');
    expect(useKanbanStore().columnWidths).toEqual([720, 360]);
  });

  it('dragging a handle resizes its column by the pointer travel', async () => {
    seedFolders();
    const wrapper = mount(KanbanBoard);
    await flushPromises();
    const handle = wrapper.find('[data-kanban-resizer="second"]');

    await handle.trigger('pointerdown', { button: 0, clientX: 700 });
    expect(document.body.classList.contains('is-column-resizing')).toBe(true);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 760 }));
    await nextTick();
    expect(boardVar(wrapper, '--kanban-col-2')).toBe('420');
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 650 }));
    await nextTick();
    expect(boardVar(wrapper, '--kanban-col-2')).toBe('310');
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 650 }));
    await nextTick();
    expect(document.body.classList.contains('is-column-resizing')).toBe(false);
    expect(JSON.parse(localStorage.getItem(WIDTHS_KEY)!)).toEqual({ inbox: 360, second: 310 });
    // Column one is untouched by column two's handle.
    expect(boardVar(wrapper, '--kanban-col-1')).toBe('360');
  });

  it('in compact mode the two columns are clamped so the reading pane keeps its minimum', async () => {
    seedFolders();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ inbox: 600, second: 600 }));
    const wrapper = mount(KanbanBoard, { props: { compact: true } });
    await flushPromises();

    // 1000 wide, 240 reserved for the message pane (the shell's default
    // when it sets no --message-view-min-width), two 6px handles: the
    // inbox column can only keep its minimum, column two takes the rest.
    expect(useKanbanStore().columnWidths).toEqual([280, 468]);
    expect(wrapper.attributes('style')).toContain('width: 760px');
    expect(useKanbanStore().compactBoardWidth).toBe(760);
  });

  it('with every column showing, widths are not bounded by the viewport (the board scrolls)', async () => {
    seedFolders();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ inbox: 600, second: 600 }));
    const wrapper = mount(KanbanBoard);
    await flushPromises();
    expect(useKanbanStore().columnWidths).toEqual([600, 600]);
    expect(wrapper.attributes('style') ?? '').not.toContain('width:');
  });
});

describe('KanbanColumn paging', () => {
  it('trusts the query view total over a stale folder counter', async () => {
    // folders.total_emails lags the cached view: the view holds two rows
    // and says so, the folder row still says one. Both rows must show.
    seedFolders();
    const rows = { ...ROWS, [BLOCKED]: [makeRow(31), makeRow(32)] };
    repo = makeRepo(rows);
    const progress = vi.spyOn(repo, 'queryViewProgress');
    __setRepositoryForTests(repo);

    const wrapper = mount(KanbanColumn, { props: { folderId: BLOCKED, label: 'Column 3' } });
    await flushPromises();

    expect(progress).toHaveBeenCalled();
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(2);
    expect(wrapper.find('.kanban-column__count').text()).toBe('2');
  });

  it('loads past the first page when a quick filter is already active on mount', async () => {
    seedFolders();
    const many = Array.from({ length: 150 }, (_, i) => makeRow(1000 + i, {
      view_position: i,
      subject: i === 120 ? 'Quarterly budget needle' : `Subject ${i}`,
    }));
    const rows = { ...ROWS, [BLOCKED]: many };
    useMailStore().folders = useMailStore().folders.map((f) => (
      f.id === BLOCKED ? { ...f, total_emails: 150 } : f));
    repo = makeRepo(rows);
    __setRepositoryForTests(repo);

    const wrapper = mount(KanbanColumn, {
      props: { folderId: BLOCKED, label: 'Column 3', quickFilterQuery: 'needle' },
    });
    await flushPromises();
    await flushPromises();

    const items = wrapper.findAll('.msg-list__item');
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain('Quarterly budget needle');
  });

  it('caps how far a quick filter pages into a large folder and says so', async () => {
    seedFolders();
    const huge = Array.from({ length: 2000 }, (_, i) => makeRow(5000 + i, {
      view_position: i,
      subject: i === 1500 ? 'Deep needle' : `Subject ${i}`,
    }));
    const rows = { ...ROWS, [BLOCKED]: huge };
    useMailStore().folders = useMailStore().folders.map((f) => (
      f.id === BLOCKED ? { ...f, total_emails: 2000 } : f));
    repo = makeRepo(rows);
    const offsets: number[] = [];
    const originalList = repo.listMessagesForView.bind(repo);
    repo.listMessagesForView = async (args) => {
      offsets.push(Number(args.offset));
      return originalList(args);
    };
    __setRepositoryForTests(repo);

    const wrapper = mount(KanbanColumn, {
      props: { folderId: BLOCKED, label: 'Column 3', quickFilterQuery: 'needle' },
    });
    for (let i = 0; i < 12; i += 1) await flushPromises();

    expect(Math.max(...offsets)).toBeLessThan(QUICK_FILTER_MAX_ROWS);
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(0);
    const hint = wrapper.find('[data-kanban-filter-hint]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain(String(QUICK_FILTER_MAX_ROWS));
  });
});

describe('KanbanColumn live refresh', () => {
  it('re-reads its rows when the worker broadcasts a MESSAGES change', async () => {
    seedFolders();
    const rows = { ...ROWS, [BLOCKED]: [makeRow(31)] };
    repo = makeRepo(rows);
    __setRepositoryForTests(repo);

    const wrapper = mount(KanbanColumn, { props: { folderId: BLOCKED, label: 'Column 3' } });
    await flushPromises();
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(1);

    rows[BLOCKED] = [makeRow(31), makeRow(32)];
    useMailStore().folders = useMailStore().folders.map((f) => (
      f.id === BLOCKED ? { ...f, total_emails: 2 } : f));
    repo.broadcast([TABLE_FAMILIES.MESSAGES]);
    await flushPromises();

    expect(wrapper.findAll('.msg-list__item')).toHaveLength(2);
    expect(wrapper.find('.kanban-column__count').text()).toBe('2');
  });

  it('re-reads after a broadcast that arrives while the first page is still loading', async () => {
    // The initial SQLite read is in flight when a mutation commits and
    // broadcasts; the read then resolves with the pre-commit snapshot.
    // The column must not settle on that stale snapshot.
    seedFolders();
    const rows = { ...ROWS, [BLOCKED]: [makeRow(31)] };
    repo = makeRepo(rows);
    let releaseFirstRead: (() => void) | null = null;
    const originalList = repo.listMessagesForView.bind(repo);
    let reads = 0;
    repo.listMessagesForView = async (args) => {
      reads += 1;
      if (reads === 1) {
        const snapshot = await originalList(args);
        await new Promise<void>((resolveRead) => { releaseFirstRead = resolveRead; });
        return snapshot;
      }
      return originalList(args);
    };
    __setRepositoryForTests(repo);

    const wrapper = mount(KanbanColumn, { props: { folderId: BLOCKED, label: 'Column 3' } });
    await flushPromises();
    expect(releaseFirstRead).not.toBeNull();

    rows[BLOCKED] = [makeRow(31), makeRow(32)];
    repo.broadcast([TABLE_FAMILIES.MESSAGES]);
    await flushPromises();
    releaseFirstRead!();
    await flushPromises();
    await flushPromises();

    expect(wrapper.findAll('.msg-list__item')).toHaveLength(2);
    expect(wrapper.find('.kanban-column__count').text()).toBe('2');
  });
});
