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

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (optionsRef) => computed(() => ({
    getTotalSize: () => Number(optionsRef.value.count ?? 0) * 88,
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
            start: index * 88,
            size: 88,
          };
        },
      );
    },
    scrollToIndex: () => {},
    measure: () => {},
  })),
}));

import MessageList from '../../../src/components/MessageList.vue';
import FolderTree from '../../../src/components/FolderTree.vue';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import {
  MESSAGE_DRAG_MIME,
  useMessageDragDrop,
} from '../../../src/composables/useMessageDragDrop';

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

function makeDataTransfer() {
  const data = new Map();
  const transfer = {
    effectAllowed: 'all',
    dropEffect: 'none',
    types: [],
    setData(type, value) {
      data.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData(type) {
      return data.get(type) ?? '';
    },
    setDragImage: vi.fn(),
  };
  return transfer;
}

beforeEach(() => {
  virtualizerWindow.start = 0;
  virtualizerWindow.count = null;
  setActivePinia(createPinia());
  // FolderTree renders primaryFolders, scoped to the signed-in
  // account; the seeded folder rows all use account_id 1.
  useAuthStore().accountId = 1;
});

afterEach(() => {
  useMessageDragDrop().endMessageDrag();
  vi.restoreAllMocks();
});

describe('MessageList row click viewing', () => {
  it('uses card layout below 360px but not at 360px', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1)];
    mailStore.totalForFolder = 1;

    const widthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function clientWidth() {
        return this.classList?.contains('msg-list') ? 359 : 0;
      });
    const narrowWrapper = mount(MessageList);
    await nextTick();
    expect(narrowWrapper.classes()).toContain('msg-list--card');
    narrowWrapper.unmount();

    widthSpy.mockImplementation(function clientWidth() {
      return this.classList?.contains('msg-list') ? 360 : 0;
    });
    const thresholdWrapper = mount(MessageList);
    await nextTick();
    expect(thresholdWrapper.classes()).not.toContain('msg-list--card');
    thresholdWrapper.unmount();
  });

  it('closes the open message when the already-viewed row is clicked again', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.totalForFolder = 2;
    mailStore.selectedMessageId = 1;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__content').trigger('click');
    await nextTick();

    expect(mailStore.selectedMessageId).toBeNull();
  });

  it('opens a different row when another message is already being viewed', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.totalForFolder = 2;
    mailStore.selectedMessageId = 1;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.findAll('.msg-list__content')[1].trigger('click');
    await nextTick();

    expect(mailStore.selectedMessageId).toBe(2);
  });

  it('plain row clicks clear active multi-selection and open the clicked message', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2), makeRow(3)];
    mailStore.totalForFolder = 3;
    mailStore.selectedMessageId = 1;
    mailStore.selectedIds = new Set([1, 2]);

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.findAll('.msg-list__content')[2].trigger('click');
    await nextTick();

    expect([...mailStore.selectedIds]).toEqual([]);
    expect(mailStore.selectedMessageId).toBe(3);
  });

  it('shift-click on a row body extends multi-selection without opening the message', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2), makeRow(3), makeRow(4), makeRow(5)];
    mailStore.totalForFolder = 5;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.findAll('.msg-list__check input')[1].trigger('click');
    await wrapper.findAll('.msg-list__content')[3].trigger('click', { shiftKey: true });
    await nextTick();

    expect([...mailStore.selectedIds].sort()).toEqual([2, 3, 4]);
    expect(mailStore.selectedMessageId).toBeNull();
  });

  it('shift-click without an existing anchor selects from the top visible row', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = Array.from({ length: 40 }, (_, index) => makeRow(index + 1));
    mailStore.totalForFolder = 40;
    virtualizerWindow.start = 19;
    virtualizerWindow.count = 15;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.findAll('.msg-list__check input')[10].trigger('click', { shiftKey: true });
    await nextTick();

    expect([...mailStore.selectedIds].sort((a, b) => a - b))
      .toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(mailStore.selectedMessageId).toBeNull();
  });

  it('control-click on a row body toggles multi-selection without opening the message', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2), makeRow(3)];
    mailStore.totalForFolder = 3;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.findAll('.msg-list__content')[2].trigger('click', { ctrlKey: true });
    await nextTick();

    expect([...mailStore.selectedIds]).toEqual([3]);
    expect(mailStore.selectedMessageId).toBeNull();
  });

  it('select-all clears a partial selection instead of selecting every row', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2), makeRow(3)];
    mailStore.totalForFolder = 3;
    mailStore.selectedIds = new Set([2]);

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__select-all input').trigger('change');

    expect([...mailStore.selectedIds]).toEqual([]);
  });

  it('leaves select-all unchecked after clearing an indeterminate shift range', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2), makeRow(3), makeRow(4), makeRow(5)];
    mailStore.totalForFolder = 5;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.findAll('.msg-list__check input')[3].trigger('click', { shiftKey: true });
    await nextTick();

    const selectAll = wrapper.find<HTMLInputElement>('.msg-list__select-all input');
    expect([...mailStore.selectedIds]).toEqual([1, 2, 3, 4]);
    expect(selectAll.element.indeterminate).toBe(true);
    expect(selectAll.element.checked).toBe(false);

    // A real browser toggles `checked` while clearing the native
    // indeterminate flag before it emits `change`. The component must
    // force both DOM properties back to the model state after clearing.
    selectAll.element.checked = true;
    selectAll.element.indeterminate = false;
    await selectAll.trigger('change');
    await nextTick();

    expect([...mailStore.selectedIds]).toEqual([]);
    expect(selectAll.element.indeterminate).toBe(false);
    expect(selectAll.element.checked).toBe(false);
  });

  it('uses Unread as a lone text toggle and selects only visible unread rows', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [
      makeRow(1, { subject: 'Read message', is_seen: 1 }),
      makeRow(2, { subject: 'Unread message', is_seen: 0 }),
      makeRow(3, { subject: 'Another unread', is_seen: 0 }),
    ];
    mailStore.totalForFolder = 3;

    const wrapper = mount(MessageList);
    await nextTick();

    const filters = wrapper.findAll('.msg-list__filter');
    expect(filters).toHaveLength(1);
    expect(filters[0].text()).toBe('Unread');

    await filters[0].trigger('click');
    await nextTick();

    const rows = wrapper.findAll('.msg-list__item');
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain('Unread message');
    expect(wrapper.text()).not.toContain('Read message');

    await wrapper.find('.msg-list__select-all input').trigger('change');

    expect([...mailStore.selectedIds].sort()).toEqual([2, 3]);

    await filters[0].trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('Read message');
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(3);
  });

  it('keeps Unread count as a strict subset of the All count from the canonical view', async () => {
    // Per R-2.8, Unread is a filter over the open folder. The Unread
    // count in the top-right header must never exceed All. Even when
    // a stale folder counter claims a higher unread number, the UI
    // must show whatever the canonical query view actually contains.
    // Drift between local projections is the store's problem to
    // reconcile via rebuild; the component must not bridge that
    // disagreement by showing more rows than exist in the open
    // folder.
    const mailStore = useMailStore();
    const allRows = Array.from({ length: 14 }, (_, index) => (
      makeRow(index + 1, {
        subject: `Message ${index + 1}`,
        is_seen: index < 8 ? 1 : 0,
      })
    ));
    mailStore.folders = [makeFolder(1, { name: 'Inbox', total_emails: 14, unread_emails: 72 })];
    mailStore.currentFolderId = 1;
    mailStore.messages = allRows;
    mailStore.totalForFolder = 14;

    const wrapper = mount(MessageList);
    await nextTick();

    const allCountText = wrapper.get('.msg-list__count').text();
    expect(allCountText).toBe('14 messages');

    await wrapper.find('.msg-list__filter').trigger('click');
    await nextTick();

    const unreadCountText = wrapper.get('.msg-list__count').text();
    // The unread count comes from filtering the canonical 14 rows,
    // not from a separate membership query that could outrun All.
    expect(unreadCountText).toBe('6 messages');

    const allCount = parseInt(allCountText.match(/^(\d+)/)?.[1] ?? '0', 10);
    const unreadCount = parseInt(unreadCountText.match(/^(\d+)/)?.[1] ?? '0', 10);
    expect(unreadCount).toBeLessThanOrEqual(allCount);
  });

  it('expands the canonical buffer on Unread toggle so the count reflects the whole folder', async () => {
    // The Archives-shows-83-of-1400 bug: the canonical view holds
    // every row in SQLite, but mailStore.messages is the positional
    // window the virtualizer has populated (~100 rows). Toggling
    // Unread must expand that buffer to cover the entire folder so
    // the count badge shows the real unread total, not the count of
    // unread rows in whatever subset the user happened to have
    // scrolled into view. The data-scale variant of this assertion
    // (10,000 rows) lives in the mail-store tests where there's no
    // DOM overhead; here we pin the virtualizer window near the tail
    // so the DOM test proves off-screen rows are included without
    // materializing the whole folder.
    const mailStore = useMailStore();
    virtualizerWindow.start = 1_450;
    virtualizerWindow.count = 40;
    const visibleWindow = Array.from({ length: 100 }, (_, index) => (
      makeRow(index + 1, {
        subject: `Visible ${index + 1}`,
        is_seen: index < 17 ? 1 : 0,
      })
    ));
    const fullFolderRows = [
      ...visibleWindow,
      ...Array.from({ length: 1_400 }, (_, index) => (
        makeRow(index + 101, {
          subject: `Cached tail ${index + 101}`,
          is_seen: 0,
        })
      )),
    ];
    mailStore.folders = [makeFolder(1, { name: 'Archives', role: 'archive', total_emails: 1_500 })];
    mailStore.currentFolderId = 1;
    mailStore.messages = visibleWindow;
    mailStore.totalForFolder = 1_500;
    const expand = vi
      .spyOn(mailStore, 'expandFolderViewIntoMemory')
      .mockImplementation(async () => {
        // Simulate the store reading the full canonical view from
        // SQLite into the buffer.
        mailStore.messages = fullFolderRows;
      });

    const wrapper = mount(MessageList);
    await nextTick();

    // Before clicking Unread the count reflects the canonical total
    // (with placeholders for unloaded positions).
    expect(wrapper.get('.msg-list__count').text()).toBe('1500 messages');

    await wrapper.find('.msg-list__filter').trigger('click');
    await Promise.resolve();
    await nextTick();

    expect(expand).toHaveBeenCalledTimes(1);
    // The unread count is the real total of unread rows in the
    // folder, not the 83 that happened to be in the visible window.
    // 83 unread in the visible window + 1400 unread tail = 1483.
    expect(wrapper.get('.msg-list__count').text()).toBe('1483 messages');
    // The expanded buffer feeds the virtualized list with all
    // unread rows, including ones the user had not scrolled to.
    const renderedSubjects = wrapper.findAll('.msg-list__subject')
      .map((node) => node.text());
    expect(renderedSubjects).toContain('Cached tail 1500');
  });

  it('expands the buffer when a quick-filter query becomes non-empty', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1)];
    mailStore.totalForFolder = 1;
    const expand = vi
      .spyOn(mailStore, 'expandFolderViewIntoMemory')
      .mockResolvedValue();

    const wrapper = mount(MessageList, {
      props: { quickFilterQuery: '' },
    });
    await nextTick();
    expect(expand).not.toHaveBeenCalled();

    await wrapper.setProps({ quickFilterQuery: 'alice' });
    await nextTick();

    expect(expand).toHaveBeenCalledTimes(1);
  });

  it('clears sticky selected rows when select-all is indeterminate in a filter', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [
      makeRow(1, { subject: 'Selected read message', is_seen: 1 }),
      makeRow(2, { subject: 'Unread message', is_seen: 0 }),
      makeRow(3, { subject: 'Read message', is_seen: 1 }),
    ];
    mailStore.totalForFolder = 3;

    const wrapper = mount(MessageList);
    await nextTick();

    // The filter must be toggled before selecting: multi-select hides
    // the filter buttons. A selected row can still end up read under
    // the Unread filter (e.g. marked read after being selected), which
    // is the sticky case this test pins.
    await wrapper.find('.msg-list__filter').trigger('click');
    await nextTick();

    mailStore.selectedIds = new Set([1]);
    await nextTick();

    expect(wrapper.text()).toContain('Selected read message');
    expect(wrapper.text()).toContain('Unread message');

    await wrapper.find('.msg-list__select-all input').trigger('change');

    expect([...mailStore.selectedIds]).toEqual([]);
    expect(wrapper.text()).not.toContain('Selected read message');
  });

  it('clears the current previewed message when toggling the Unread filter', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [
      makeRow(1, { subject: 'Already read preview', is_seen: 1 }),
      makeRow(2, { subject: 'Still unread', is_seen: 0 }),
    ];
    mailStore.totalForFolder = 2;
    mailStore.selectedMessageId = 1;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__filter').trigger('click');
    await nextTick();

    expect(mailStore.selectedMessageId).toBeNull();
    expect(wrapper.text()).not.toContain('Already read preview');
    expect(wrapper.text()).toContain('Still unread');
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(1);
  });

  it('quick filters locally by From, To, and Subject without matching preview text', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [
      makeRow(1, {
        from_text: 'Alice Example <alice@example.com>',
        subject: 'Project update',
        preview: 'ordinary preview',
      }),
      makeRow(2, {
        from_text: 'Bob Example <bob@example.com>',
        to_text: 'Team Recipient <team@example.com>',
        subject: 'Schedule',
        preview: 'ordinary preview',
      }),
      makeRow(3, {
        from_text: 'Carol Example <carol@example.com>',
        subject: 'Quarterly invoice',
        preview: 'ordinary preview',
      }),
      makeRow(4, {
        from_text: 'Dave Example <dave@example.com>',
        subject: 'Preview should not match',
        preview: 'Alice appears only here',
      }),
    ];
    mailStore.totalForFolder = 4;

    const wrapper = mount(MessageList, {
      props: { quickFilterQuery: 'alice' },
    });
    await nextTick();

    expect(wrapper.findAll('.msg-list__item')).toHaveLength(1);
    expect(wrapper.text()).toContain('Project update');
    expect(wrapper.text()).not.toContain('Preview should not match');

    await wrapper.setProps({ quickFilterQuery: 'team recipient' });
    await nextTick();

    expect(wrapper.findAll('.msg-list__item')).toHaveLength(1);
    expect(wrapper.text()).toContain('Schedule');

    await wrapper.setProps({ quickFilterQuery: 'quarterly' });
    await nextTick();

    expect(wrapper.findAll('.msg-list__item')).toHaveLength(1);
    expect(wrapper.text()).toContain('Quarterly invoice');
  });

  it('keeps the select-all checkbox disabled when a filter leaves no visible messages', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [
      makeRow(1, { subject: 'Read one', is_seen: 1 }),
      makeRow(2, { subject: 'Read two', is_seen: 1 }),
    ];
    mailStore.totalForFolder = 2;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__filter').trigger('click');
    await nextTick();

    const selectAll = wrapper.find('.msg-list__select-all');
    const checkbox = selectAll.find('input');

    expect(selectAll.exists()).toBe(true);
    expect(selectAll.classes()).toContain('is-disabled');
    expect(checkbox.attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(0);
    expect(wrapper.text()).toContain('No unread messages in Inbox.');
  });

  it('keeps a newly read message in the Unread filter while it is still previewed', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [
      makeRow(1, { subject: 'Becomes read', is_seen: 0 }),
      makeRow(2, { subject: 'Still unread', is_seen: 0 }),
    ];
    mailStore.totalForFolder = 2;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__filter').trigger('click');
    await nextTick();

    await wrapper.find('.msg-list__content').trigger('click');
    await nextTick();
    mailStore.messages = [
      makeRow(1, { subject: 'Becomes read', is_seen: 1 }),
      makeRow(2, { subject: 'Still unread', is_seen: 0 }),
    ];
    await nextTick();

    expect(wrapper.text()).toContain('Becomes read');
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(2);

    await wrapper.find('.msg-list__content').trigger('click');
    await nextTick();

    expect(mailStore.selectedMessageId).toBeNull();
    expect(wrapper.text()).not.toContain('Becomes read');
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(1);
  });

  it('keeps a newly read message in the Unread filter while it is checkbox-selected', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [
      makeRow(1, { subject: 'Checked read', is_seen: 0 }),
      makeRow(2, { subject: 'Other unread', is_seen: 0 }),
    ];
    mailStore.totalForFolder = 2;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__filter').trigger('click');
    await nextTick();

    await wrapper.find('.msg-list__check input').trigger('click');
    mailStore.messages = [
      makeRow(1, { subject: 'Checked read', is_seen: 1 }),
      makeRow(2, { subject: 'Other unread', is_seen: 0 }),
    ];
    await nextTick();

    expect(wrapper.text()).toContain('Checked read');
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(2);

    await wrapper.find('.msg-list__check input').trigger('click');
    await nextTick();

    expect([...mailStore.selectedIds]).toEqual([]);
    expect(wrapper.text()).not.toContain('Checked read');
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(1);
  });
});

describe('message drag and folder drop components', () => {
  it('starts a row drag with all selected message ids when the dragged row is selected', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.totalForFolder = 2;
    mailStore.selectedIds = new Set([1, 2]);

    const wrapper = mount(MessageList);
    await nextTick();

    const transfer = makeDataTransfer();
    await wrapper.findAll('.msg-list__item')[1].trigger('dragstart', { dataTransfer: transfer });

    expect(transfer.effectAllowed).toBe('move');
    expect(JSON.parse(transfer.getData(MESSAGE_DRAG_MIME))).toEqual({
      ids: [1, 2],
      sourceFolderId: 1,
    });
  });

  it('drops dragged message ids on a valid folder and calls mailStore.moveMessages', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [
      makeFolder(1, { name: 'Inbox', role: 'inbox', may_remove_items: 1 }),
      makeFolder(2, { name: 'Archive', role: 'archive', may_add_items: 1 }),
    ];
    mailStore.currentFolderId = 1;
    const moveSpy = vi.spyOn(mailStore, 'moveMessages')
      .mockResolvedValue({ succeeded: 2, failed: 0, skipped: 0 });

    const transfer = makeDataTransfer();
    useMessageDragDrop().startMessageDrag(
      { dataTransfer: transfer },
      { messageId: 1, selectedIds: new Set([1, 2]), sourceFolderId: 1 },
    );

    const wrapper = mount(FolderTree);
    await nextTick();
    const archive = wrapper.findAll('.folder-node')
      .find((node) => node.text().includes('Archive'));

    await archive.trigger('dragover', { dataTransfer: transfer });
    await nextTick();
    expect(archive.classes()).toContain('is-drop-valid');

    await archive.trigger('drop', { dataTransfer: transfer });

    expect(moveSpy).toHaveBeenCalledWith([1, 2], 2);
  });
});
