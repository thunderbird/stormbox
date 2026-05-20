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

function makeRow(id) {
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
