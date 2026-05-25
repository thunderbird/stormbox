// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth.js', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import { invokeThunderbirdShortcut, useThunderbirdShortcuts } from '../../../src/composables/useThunderbirdShortcuts.js';
import { useMailStore } from '../../../src/stores/mail-store.js';
import { useComposeStore } from '../../../src/stores/compose-store.js';
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/useRepository.js';

function makeRepo() {
  return {
    subscribe() { return () => {}; },
    async listFolders() { return []; },
    async listMessagesForView() { return []; },
    async queryViewProgress() { return { total: 0, covered: 0, percent: 0 }; },
    async ensureFolderWindow() { return { total: 0, fetched: 0 }; },
    async ensureMessageBodies() { return { fetched: 0 }; },
    async getMessageBodyForDisplay() { return null; },
    async ensureFolderTree() { return { count: 0 }; },
    async listIdentities() { return [{ id: 1, email: 'me@example.com', name: 'Me' }]; },
    async filterExistingMessageIds(_accountId: number, ids: number[]) {
      return ids;
    },
    async insertPendingMutation() { return { id: 1 }; },
    async runMutation() { return { attempted: 1, succeeded: 1, failed: 0 }; },
  };
}

function makeRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    subject: `Subject ${id}`,
    from_text: `Sender ${id} <s${id}@example.com>`,
    to_text: 'me@example.com',
    received_at: 1_700_000_000_000 + id,
    keywords_json: '{}',
    is_seen: 1,
    is_flagged: 0,
    preview: '',
    ...overrides,
  };
}

function mountHarness() {
  const space = ref('mail');
  const enabled = ref(true);
  const Harness = defineComponent({
    setup() {
      useThunderbirdShortcuts({ space, enabled });
      return () => null;
    },
  });
  const wrapper = mount(Harness);
  return { wrapper, space, enabled };
}

function fireKey(key: string, init: Partial<KeyboardEventInit> = {}) {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
});

afterEach(() => {
  __resetRepositoryForTests();
});

describe('useThunderbirdShortcuts', () => {
  it('Ctrl+N opens compose', () => {
    mountHarness();
    const composeStore = useComposeStore();
    expect(composeStore.isOpen).toBe(false);
    fireKey('n', { ctrlKey: true });
    expect(composeStore.isOpen).toBe(true);
  });

  it('Delete destroys the viewed message', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.selectedMessageId = 1;
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);

    fireKey('Delete');
    await Promise.resolve();

    expect(destroySpy).toHaveBeenCalledWith([1]);
  });

  it('Backspace destroys the viewed message', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.selectedMessageId = 1;
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);

    fireKey('Backspace');
    await Promise.resolve();

    expect(destroySpy).toHaveBeenCalledWith([1]);
  });

  it('Ctrl+A selects only loaded rows, not the full folder total', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2), undefined, makeRow(4)];
    mailStore.totalForFolder = 3000;

    fireKey('a', { ctrlKey: true });

    expect(mailStore.selectedIds.size).toBe(3);
    expect([...mailStore.selectedIds].sort()).toEqual([1, 2, 4]);
  });

  it('F and B move the viewed message', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2), makeRow(3)];
    mailStore.selectedMessageId = 1;

    fireKey('f');
    expect(mailStore.selectedMessageId).toBe(2);

    fireKey('b');
    expect(mailStore.selectedMessageId).toBe(1);
  });

  it('N moves to the next unread message', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [
      makeRow(1, { is_seen: 1 }),
      makeRow(2, { is_seen: 1 }),
      makeRow(3, { is_seen: 0 }),
    ];
    mailStore.selectedMessageId = 1;

    fireKey('n');
    expect(mailStore.selectedMessageId).toBe(3);
  });

  it('plain A archives without selecting all loaded rows', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.folders = [{ id: 99, role: 'archive', name: 'Archive', is_deleted: 0 }];
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.selectedMessageId = 1;
    mailStore.totalForFolder = 3000;
    const archiveSpy = vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    fireKey('a');
    await Promise.resolve();

    expect(archiveSpy).toHaveBeenCalledWith([1]);
    expect(mailStore.selectedIds.size).toBe(0);
  });

  it('ignores shortcuts when compose is open', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    const composeStore = useComposeStore();
    composeStore.isOpen = true;
    mailStore.messages = [makeRow(1)];
    mailStore.selectedMessageId = 1;
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);

    fireKey('Delete');
    await Promise.resolve();

    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('Delete works when focus is on a checkbox input', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.selectedIds = new Set([1]);
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.appendChild(checkbox);
    checkbox.focus();
    checkbox.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();
    checkbox.remove();

    expect(destroySpy).toHaveBeenCalledWith([1]);
  });

  it('does not handle excluded shortcuts', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1)];
    mailStore.selectedMessageId = 1;
    const refreshSpy = vi.spyOn(mailStore, 'refresh').mockResolvedValue(undefined);
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);

    fireKey('F5');
    fireKey('s');
    fireKey('Enter');
    fireKey('e', { ctrlKey: true });
    await Promise.resolve();

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
    expect(mailStore.selectedMessageId).toBe(1);
  });

  it('Ctrl+R prepares a reply for the viewed message', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    const composeStore = useComposeStore();
    mailStore.messages = [makeRow(7, { from_text: 'Alice <alice@example.com>', subject: 'Hi' })];
    mailStore.selectedMessageId = 7;
    const replySpy = vi.spyOn(composeStore, 'prepareReplyFromMessage');

    fireKey('r', { ctrlKey: true });

    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.anything(),
    );
  });

  it('Ctrl+Shift+R prepares reply-all for the viewed message', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    const composeStore = useComposeStore();
    mailStore.messages = [makeRow(7, { from_text: 'Alice <alice@example.com>', subject: 'Hi' })];
    mailStore.selectedMessageId = 7;
    const replyAllSpy = vi.spyOn(composeStore, 'prepareReplyAll');

    fireKey('r', { ctrlKey: true, shiftKey: true });

    expect(replyAllSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.anything(),
    );
  });

  it('Ctrl+L prepares a forward for the viewed message', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    const composeStore = useComposeStore();
    mailStore.messages = [makeRow(7, { from_text: 'Alice <alice@example.com>', subject: 'Hi' })];
    mailStore.selectedMessageId = 7;
    const forwardSpy = vi.spyOn(composeStore, 'prepareForward');

    fireKey('l', { ctrlKey: true });

    expect(forwardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.anything(),
    );
  });

  it('M toggles read/unread on the targeted message', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1, { is_seen: 1 }), makeRow(2, { is_seen: 1 })];
    mailStore.selectedMessageId = 1;
    const toggleSpy = vi.spyOn(mailStore, 'toggleManySeen').mockResolvedValue(undefined);

    fireKey('m');
    await Promise.resolve();

    expect(toggleSpy).toHaveBeenCalledWith([1]);
  });

  it('P moves to the previous unread message', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [
      makeRow(1, { is_seen: 0 }),
      makeRow(2, { is_seen: 1 }),
      makeRow(3, { is_seen: 1 }),
    ];
    mailStore.selectedMessageId = 3;

    fireKey('p');

    expect(mailStore.selectedMessageId).toBe(1);
  });

  it('Home jumps to the first loaded row, End jumps to the last', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2), makeRow(3), makeRow(4)];
    mailStore.selectedMessageId = 2;

    fireKey('End');
    expect(mailStore.selectedMessageId).toBe(4);

    fireKey('Home');
    expect(mailStore.selectedMessageId).toBe(1);
  });

  it('Shift+Delete permanently destroys the targeted message', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.selectedMessageId = 1;
    const purgeSpy = vi.spyOn(mailStore, 'permanentlyDestroyMessages')
      .mockResolvedValue(undefined);
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);

    fireKey('Delete', { shiftKey: true });
    await Promise.resolve();

    expect(purgeSpy).toHaveBeenCalledWith([1]);
    // Shift+Delete must not also dispatch the ordinary delete path.
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('forwards key events from nested documents via invokeThunderbirdShortcut', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1)];
    mailStore.selectedMessageId = 1;
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);

    invokeThunderbirdShortcut(new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();

    expect(destroySpy).toHaveBeenCalledWith([1]);
  });
});
