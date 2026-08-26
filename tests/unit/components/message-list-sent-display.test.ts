// @vitest-environment happy-dom

/**
 * Sent- and Drafts-folder list rows show the recipient, not the sender
 * (issue #98). Inbox and other folders keep showing the sender.
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

function makeRow(id, overrides = {}) {
  return {
    id,
    remote_id: `e-${id}`,
    from_text: 'Me <me@example.com>',
    to_text: 'Alice <alice@example.com>',
    subject: `Subject ${id}`,
    preview: 'preview',
    received_at: 1_700_000_000_000 + id,
    is_seen: 1,
    is_flagged: 0,
    has_attachment: 0,
    ...overrides,
  } as any;
}

function mountList({ folder, rows = [makeRow(1)] } = {}) {
  const resolvedFolder = folder ?? makeFolder(1, { name: 'Inbox' });
  const mailStore = useMailStore();
  mailStore.folders = [resolvedFolder];
  mailStore.currentFolderId = resolvedFolder.id;
  mailStore.messages = rows;
  mailStore.totalForFolder = rows.length;
  return { mailStore, wrapper: mount(MessageList) };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageList outbox correspondent column (issue #98)', () => {
  it('shows the sender in Inbox', async () => {
    const { wrapper } = mountList();
    await nextTick();

    expect(wrapper.find('.msg-list__from').text()).toBe('Me');
    wrapper.unmount();
  });

  it('shows the recipient in Sent', async () => {
    const { wrapper } = mountList({
      folder: makeFolder(2, { name: 'Sent', role: 'sent' }),
    });
    await nextTick();

    expect(wrapper.find('.msg-list__from').text()).toBe('Alice');
    wrapper.unmount();
  });

  it('shows the recipient in Drafts', async () => {
    const { wrapper } = mountList({
      folder: makeFolder(3, { name: 'Drafts', role: 'drafts' }),
    });
    await nextTick();

    expect(wrapper.find('.msg-list__from').text()).toBe('Alice');
    wrapper.unmount();
  });

  it('labels an empty To line as no recipient in Sent', async () => {
    const { wrapper } = mountList({
      folder: makeFolder(2, { name: 'Sent', role: 'sent' }),
      rows: [makeRow(1, { to_text: null })],
    });
    await nextTick();

    expect(wrapper.find('.msg-list__from').text()).toBe('(no recipient)');
    wrapper.unmount();
  });
});
