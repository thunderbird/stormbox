// @vitest-environment happy-dom

/**
 * Pins the rendered markup of message-list rows. The row lives in
 * MessageListRow.vue so other list surfaces can reuse it; this fixture is
 * the DOM MessageList produces for the folder list, and any change to the
 * row must keep it byte for byte apart from Vue's scoped-style attributes.
 */

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { computed, nextTick } from 'vue';

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

// Fixed 2023 timestamps: never "today" and never the current year, so
// fmtDate always takes the full-date branch regardless of when the
// suite runs.
const BASE_TS = Date.UTC(2023, 10, 14, 12, 0, 0);

function makeRow(id, overrides = {}) {
  return {
    id,
    remote_id: `e-${id}`,
    from_text: `Sender ${id} <sender${id}@example.com>`,
    to_text: 'Alice Recipient <alice@example.org>',
    subject: `Subject ${id}`,
    preview: `Preview text for message ${id}`,
    received_at: BASE_TS + id * 86_400_000,
    sent_at: BASE_TS + id * 86_400_000 - 3_600_000,
    is_seen: 1,
    is_flagged: 0,
    has_attachment: 0,
    scheduled_undo_status: null,
    ...overrides,
  } as any;
}

const ROWS = [
  makeRow(1),
  makeRow(2, { is_seen: 0, is_flagged: 1, has_attachment: 1 }),
  makeRow(3, { subject: '', preview: null }),
  makeRow(4, { scheduled_undo_status: 'pending' }),
  makeRow(5, { from_text: null }),
  makeRow(6, { is_seen: 0 }),
];

function normalize(html: string): string {
  return html
    .replace(/\s+data-v-[0-9a-f]+=""/g, '')
    .replace(/\r\n/g, '\n');
}

function mountList({ folder, selected = [], focused = null }: {
  folder?: any;
  selected?: number[];
  focused?: number | null;
} = {}) {
  const resolvedFolder = folder ?? makeFolder(1, { name: 'Inbox' });
  const mailStore = useMailStore();
  mailStore.folders = [resolvedFolder];
  mailStore.currentFolderId = resolvedFolder.id;
  mailStore.messages = ROWS;
  mailStore.totalForFolder = ROWS.length;
  mailStore.selectedIds = new Set(selected);
  mailStore.selectedMessageId = focused;
  return { mailStore, wrapper: mount(MessageList) };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageList row markup baseline', () => {
  it('renders Inbox rows (plain, unread, flagged, attachment, empty subject, undraggable, no sender)', async () => {
    const { wrapper } = mountList();
    await nextTick();
    const items = wrapper.find('.msg-list__items');
    expect(items.exists()).toBe(true);
    await expect(normalize(items.html())).toMatchFileSnapshot(
      '../../fixtures/message-list-rows/inbox.html',
    );
    wrapper.unmount();
  });

  it('renders selection and focus states', async () => {
    const { wrapper } = mountList({ selected: [1, 2], focused: 2 });
    await nextTick();
    await expect(normalize(wrapper.find('.msg-list__items').html())).toMatchFileSnapshot(
      '../../fixtures/message-list-rows/inbox-selected.html',
    );
    wrapper.unmount();
  });

  it('renders recipients and sent timestamps in Sent', async () => {
    const { wrapper } = mountList({
      folder: makeFolder(2, { name: 'Sent', role: 'sent' }),
    });
    await nextTick();
    await expect(normalize(wrapper.find('.msg-list__items').html())).toMatchFileSnapshot(
      '../../fixtures/message-list-rows/sent.html',
    );
    wrapper.unmount();
  });
});
