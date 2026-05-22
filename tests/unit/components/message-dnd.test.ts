// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { computed, nextTick } from 'vue';

vi.mock('../../../src/services/auth.js', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (optionsRef) => computed(() => ({
    getTotalSize: () => Number(optionsRef.value.count ?? 0) * 88,
    getVirtualItems: () => Array.from(
      { length: Number(optionsRef.value.count ?? 0) },
      (_, index) => ({
        index,
        key: optionsRef.value.getItemKey?.(index) ?? index,
        start: index * 88,
        size: 88,
      }),
    ),
    measure: () => {},
  })),
}));

import MessageList from '../../../src/components/MessageList.vue';
import FolderTree from '../../../src/components/FolderTree.vue';
import { useMailStore } from '../../../src/stores/mail-store.js';
import {
  MESSAGE_DRAG_MIME,
  useMessageDragDrop,
} from '../../../src/composables/use-message-drag-drop.js';

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
  };
}

function makeRow(id, overrides = {}) {
  return {
    id,
    remote_id: `e-${id}`,
    from_text: `Sender ${id} <sender${id}@example.com>`,
    subject: `Subject ${id}`,
    preview: 'preview',
    received_at: 1_700_000_000_000 + id,
    is_seen: 1,
    is_flagged: 0,
    has_attachment: 0,
    ...overrides,
  };
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
  setActivePinia(createPinia());
});

afterEach(() => {
  useMessageDragDrop().endMessageDrag();
  vi.restoreAllMocks();
});

describe('MessageList row click viewing', () => {
  it('closes the open message when the already-viewed row is clicked again', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.totalForFolder = 2;
    mailStore.selectedMessageId = 1;

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__rows').trigger('click');
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

    await wrapper.findAll('.msg-list__rows')[1].trigger('click');
    await nextTick();

    expect(mailStore.selectedMessageId).toBe(2);
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

  it('selects only unread targets when selected read rows are sticky in the filter', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [makeFolder(1, { name: 'Inbox' })];
    mailStore.currentFolderId = 1;
    mailStore.messages = [
      makeRow(1, { subject: 'Selected read message', is_seen: 1 }),
      makeRow(2, { subject: 'Unread message', is_seen: 0 }),
      makeRow(3, { subject: 'Read message', is_seen: 1 }),
    ];
    mailStore.totalForFolder = 3;
    mailStore.selectedIds = new Set([1]);

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__filter').trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('Selected read message');
    expect(wrapper.text()).toContain('Unread message');

    await wrapper.find('.msg-list__select-all input').trigger('change');
    await nextTick();

    expect([...mailStore.selectedIds]).toEqual([2]);
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
    mailStore.selectedIds = new Set([2]);

    const wrapper = mount(MessageList);
    await nextTick();

    await wrapper.find('.msg-list__filter').trigger('click');
    await nextTick();

    expect(mailStore.selectedMessageId).toBeNull();
    expect([...mailStore.selectedIds]).toEqual([2]);
    expect(wrapper.text()).not.toContain('Already read preview');
    expect(wrapper.text()).toContain('Still unread');
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(1);
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

    await wrapper.find('.msg-list__rows').trigger('click');
    await nextTick();
    mailStore.messages = [
      makeRow(1, { subject: 'Becomes read', is_seen: 1 }),
      makeRow(2, { subject: 'Still unread', is_seen: 0 }),
    ];
    await nextTick();

    expect(wrapper.text()).toContain('Becomes read');
    expect(wrapper.findAll('.msg-list__item')).toHaveLength(2);

    await wrapper.find('.msg-list__rows').trigger('click');
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
    const archive = wrapper.findAll('button.folder-node')
      .find((button) => button.text().includes('Archive'));

    await archive.trigger('dragover', { dataTransfer: transfer });
    await nextTick();
    expect(archive.classes()).toContain('is-drop-valid');

    await archive.trigger('drop', { dataTransfer: transfer });

    expect(moveSpy).toHaveBeenCalledWith([1, 2], 2);
  });
});
