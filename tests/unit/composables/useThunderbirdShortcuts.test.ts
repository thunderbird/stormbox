// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import {
  invokeThunderbirdShortcut,
  registerMessageListCommands,
  useThunderbirdShortcuts,
  type MessageListCommands,
} from '../../../src/composables/useThunderbirdShortcuts';
import { useMailStore } from '../../../src/stores/mail-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import { useSettingsStore } from '../../../src/stores/settings-store';
import type { ShortcutScheme } from '../../../src/constants/settings';
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/useRepository';

const mountedWrappers: Array<{ unmount: () => void }> = [];

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

function populatedDraft() {
  return {
    to: [{ name: 'Alice', email: 'alice@example.com' }],
    cc: [{ email: 'carol@example.com' }],
    bcc: [{ email: 'bob@example.com' }],
    subject: 'Composed 日本語',
    textBody: 'Plain body',
    htmlBody: '<p>Plain body</p>',
    inReplyTo: ['parent@example.com'],
    references: ['thread@example.com', 'parent@example.com'],
  };
}

let unregisterMessageListCommands: (() => void) | null = null;

function useScheme(scheme: ShortcutScheme) {
  useSettingsStore().settings = { shortcutScheme: scheme };
}

/** Pretend to be macOS for the duration of one test. */
function onMac() {
  const original = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
  return () => {
    if (original) Object.defineProperty(navigator, 'platform', original);
    else Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
  };
}

function mountHarness(options: {
  focusQuickFilter?: () => void;
  messageListCommands?: MessageListCommands | null;
} = {}) {
  const space = ref('mail');
  const enabled = ref(true);
  const messageListCommands = options.messageListCommands === undefined
    ? {
        navigate: vi.fn(),
        selectAll: vi.fn(),
      }
    : options.messageListCommands;
  unregisterMessageListCommands?.();
  unregisterMessageListCommands = messageListCommands
    ? registerMessageListCommands(messageListCommands)
    : null;
  const Harness = defineComponent({
    setup() {
      useThunderbirdShortcuts({
        space,
        enabled,
        focusQuickFilter: options.focusQuickFilter,
      });
      return () => null;
    },
  });
  const wrapper = mount(Harness);
  mountedWrappers.push(wrapper);
  return {
    wrapper,
    space,
    enabled,
    messageListCommands,
  };
}

/** A compose dialog holding a recipient combobox with its list showing. */
function openDialogWithCombobox() {
  const dialog = document.createElement('div');
  dialog.className = 'compose-dialog';
  const combobox = document.createElement('input');
  combobox.setAttribute('role', 'combobox');
  combobox.setAttribute('aria-expanded', 'true');
  dialog.appendChild(combobox);
  document.body.appendChild(dialog);
  return { dialog, combobox };
}

function fireKey(key: string, init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
});

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  unregisterMessageListCommands?.();
  unregisterMessageListCommands = null;
  __resetRepositoryForTests();
});

describe('useThunderbirdShortcuts (thunderbird scheme)', () => {
  beforeEach(() => {
    useScheme('thunderbird');
  });

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

  it('delegates Ctrl+A to the registered message list', () => {
    const { messageListCommands } = mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2), undefined, makeRow(4)];
    mailStore.totalForFolder = 3000;

    const event = fireKey('a', { ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(messageListCommands?.selectAll).toHaveBeenCalledOnce();
    expect(mailStore.selectedIds.size).toBe(0);
  });

  it('stands down for list commands when no message list is registered', () => {
    mountHarness({ messageListCommands: null });

    const selectAll = fireKey('a', { ctrlKey: true });
    const navigate = fireKey('f');

    expect(selectAll.defaultPrevented).toBe(false);
    expect(navigate.defaultPrevented).toBe(false);
  });

  it('stands down when a prior handler prevented the event', async () => {
    const { messageListCommands } = mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1)];
    mailStore.selectedMessageId = 1;
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Delete',
    });
    event.preventDefault();

    document.dispatchEvent(event);
    await Promise.resolve();

    expect(destroySpy).not.toHaveBeenCalled();
    expect(messageListCommands?.navigate).not.toHaveBeenCalled();
    expect(messageListCommands?.selectAll).not.toHaveBeenCalled();
  });

  it.each(['mail', 'contacts'])('Ctrl+K focuses the shared filter in the %s space', (activeSpace) => {
    const focusQuickFilter = vi.fn();
    const { space } = mountHarness({ focusQuickFilter });
    space.value = activeSpace;

    const event = new KeyboardEvent('keydown', {
      key: 'k',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(focusQuickFilter).toHaveBeenCalledOnce();
  });

  it('Ctrl+K still works from editable targets', () => {
    const focusQuickFilter = vi.fn();
    mountHarness({ focusQuickFilter });
    const input = document.createElement('input');
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }));
    input.remove();

    expect(focusQuickFilter).toHaveBeenCalledOnce();
  });

  it('leaves composing shortcuts to the input method', () => {
    const focusQuickFilter = vi.fn();
    mountHarness({ focusQuickFilter });

    const event = fireKey('k', { ctrlKey: true, isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(focusQuickFilter).not.toHaveBeenCalled();
  });

  it('delegates F and B navigation to the registered message list', () => {
    const { messageListCommands } = mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2), makeRow(3)];
    mailStore.selectMessage(1);

    fireKey('f');
    fireKey('b');

    expect(messageListCommands?.navigate).toHaveBeenNthCalledWith(1, 'next');
    expect(messageListCommands?.navigate).toHaveBeenNthCalledWith(2, 'previous');
    expect(mailStore.focusedMessageId).toBe(1);
    expect(mailStore.selectedMessageId).toBe(1);
  });

  it('delegates N to next-unread navigation', () => {
    const { messageListCommands } = mountHarness();

    fireKey('n');

    expect(messageListCommands?.navigate).toHaveBeenCalledWith('nextUnread');
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

  it('does not run the archive shortcut in the Contacts space', async () => {
    const { space } = mountHarness();
    const mailStore = useMailStore() as any;
    space.value = 'contacts';
    mailStore.messages = [makeRow(1)];
    mailStore.selectedMessageId = 1;
    const archiveSpy = vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    fireKey('a');
    await Promise.resolve();

    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('ignores shortcuts when compose is open', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    const composeStore = useComposeStore();
    composeStore.open();
    mailStore.messages = [makeRow(1)];
    mailStore.selectedMessageId = 1;
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);

    fireKey('Delete');
    await Promise.resolve();

    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('Escape closes an open composer', () => {
    mountHarness();
    const composeStore = useComposeStore();
    composeStore.open(populatedDraft());

    fireKey('Escape');

    expect(composeStore.isOpen).toBe(false);
    expect(composeStore.draft.subject).toBe('');
    expect(composeStore.draft.to).toEqual([]);
  });

  it('leaves Escape to an open schedule dialog', () => {
    mountHarness();
    const composeStore = useComposeStore();
    composeStore.open(populatedDraft());
    const scheduleDialog = document.createElement('section');
    scheduleDialog.className = 'schedule-dialog';
    scheduleDialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(scheduleDialog);

    try {
      const event = fireKey('Escape');
      expect(event.defaultPrevented).toBe(false);
      expect(composeStore.isOpen).toBe(true);
    } finally {
      scheduleDialog.remove();
    }
  });

  it('leaves a composing Escape and the draft to the input method', () => {
    mountHarness();
    const composeStore = useComposeStore();
    const draft = populatedDraft();
    composeStore.open(draft);

    const event = fireKey('Escape', { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft).toMatchObject(draft);
  });

  it('ignores legacy IME key events forwarded from nested documents', () => {
    mountHarness();
    const composeStore = useComposeStore();
    const draft = populatedDraft();
    composeStore.open(draft);
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'keyCode', { value: 229 });

    invokeThunderbirdShortcut(event);

    expect(event.defaultPrevented).toBe(false);
    expect(composeStore.isOpen).toBe(true);
    expect(composeStore.draft).toMatchObject(draft);
  });

  it('leaves Escape to a recipient list that is showing', () => {
    // Escape is handled here in the capture phase, so a combobox inside the
    // dialog cannot stop the event on its way past. Dismissing its list is
    // what the key means while the list is up; closing the whole message
    // instead discards a draft.
    mountHarness();
    const composeStore = useComposeStore();
    composeStore.open();
    const { dialog, combobox } = openDialogWithCombobox();

    try {
      combobox.focus();
      fireKey('Escape');
      expect(composeStore.isOpen).toBe(true);

      combobox.setAttribute('aria-expanded', 'false');
      fireKey('Escape');
      expect(composeStore.isOpen).toBe(false);
    } finally {
      dialog.remove();
    }
  });

  it('closes the composer when the open list is somewhere else', () => {
    // A list can be left expanded on a field the user has moved away from.
    // Standing down for that one leaves Escape doing nothing at all: the
    // field never gets the key, so nothing closes and the draft is stuck.
    mountHarness();
    const composeStore = useComposeStore();
    composeStore.open();
    const { dialog } = openDialogWithCombobox();
    const subject = document.createElement('input');
    dialog.appendChild(subject);

    try {
      subject.focus();
      fireKey('Escape');

      expect(composeStore.isOpen).toBe(false);
    } finally {
      dialog.remove();
    }
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

  it('delegates P to previous-unread navigation', () => {
    const { messageListCommands } = mountHarness();

    fireKey('p');

    expect(messageListCommands?.navigate).toHaveBeenCalledWith('previousUnread');
  });

  it('delegates Home and End to list boundaries', () => {
    const { messageListCommands } = mountHarness();

    fireKey('End');
    fireKey('Home');

    expect(messageListCommands?.navigate).toHaveBeenNthCalledWith(1, 'last');
    expect(messageListCommands?.navigate).toHaveBeenNthCalledWith(2, 'first');
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

  it('keeps archive and delete shortcuts inert for scheduled targets', async () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1, {
      scheduled_submission_remote_id: 'sub-1',
      scheduled_undo_status: 'pending',
    })];
    mailStore.selectedMessageId = 1;
    const archiveSpy = vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
    const destroySpy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);
    const purgeSpy = vi.spyOn(mailStore, 'permanentlyDestroyMessages')
      .mockResolvedValue(undefined);

    fireKey('a');
    fireKey('Delete');
    fireKey('Delete', { shiftKey: true });
    await Promise.resolve();

    expect(archiveSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
    expect(purgeSpy).not.toHaveBeenCalled();
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

describe('useThunderbirdShortcuts (web scheme, the default)', () => {
  function viewing(id = 7) {
    const mailStore = useMailStore() as any;
    mailStore.folders = [{ id: 99, role: 'archive', name: 'Archive', is_deleted: 0 }];
    mailStore.messages = [makeRow(id, { from_text: 'Alice <alice@example.com>' }), makeRow(id + 1)];
    mailStore.selectedMessageId = id;
    return mailStore;
  }

  it('is the scheme when nothing is stored', () => {
    expect(useSettingsStore().get('shortcutScheme')).toBe('web');
  });

  it('C opens compose; Ctrl+N is left to the browser', () => {
    mountHarness();
    const composeStore = useComposeStore();

    const ctrlN = fireKey('n', { ctrlKey: true });
    expect(ctrlN.defaultPrevented).toBe(false);
    expect(composeStore.isOpen).toBe(false);

    const c = fireKey('c');
    expect(c.defaultPrevented).toBe(true);
    expect(composeStore.isOpen).toBe(true);
  });

  it('R, Shift+R and F reply, reply-all and forward the viewed message', () => {
    mountHarness();
    viewing();
    const composeStore = useComposeStore();
    const reply = vi.spyOn(composeStore, 'prepareReplyFromMessage');
    const replyAll = vi.spyOn(composeStore, 'prepareReplyAll');
    const forward = vi.spyOn(composeStore, 'prepareForward');

    fireKey('r');
    fireKey('R', { shiftKey: true });
    fireKey('f');

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), expect.anything());
    expect(replyAll).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), expect.anything());
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), expect.anything());
  });

  it('leaves browser chords including Ctrl+Shift+Delete alone', () => {
    const { messageListCommands } = mountHarness();
    const mailStore = viewing();
    const composeStore = useComposeStore();
    const reply = vi.spyOn(composeStore, 'prepareReplyFromMessage');
    const forward = vi.spyOn(composeStore, 'prepareForward');
    const purge = vi.spyOn(mailStore, 'permanentlyDestroyMessages').mockResolvedValue(undefined);

    const events = [
      fireKey('n', { ctrlKey: true }),
      fireKey('r', { ctrlKey: true }),
      fireKey('l', { ctrlKey: true }),
      fireKey('a', { ctrlKey: true }),
      fireKey('Delete', { ctrlKey: true, shiftKey: true }),
      fireKey('Home'),
      fireKey('End'),
    ];

    expect(events.every((event) => !event.defaultPrevented)).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
    expect(messageListCommands?.selectAll).not.toHaveBeenCalled();
    expect(messageListCommands?.navigate).not.toHaveBeenCalled();
  });

  it('/ focuses Quick Filter outside text fields; Ctrl+K works everywhere', () => {
    const focusQuickFilter = vi.fn();
    mountHarness({ focusQuickFilter });

    const slash = fireKey('/');
    expect(slash.defaultPrevented).toBe(true);
    expect(focusQuickFilter).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      const typed = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
      input.dispatchEvent(typed);
      expect(typed.defaultPrevented).toBe(false);
      expect(focusQuickFilter).toHaveBeenCalledTimes(1);

      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
      }));
      expect(focusQuickFilter).toHaveBeenCalledTimes(2);
    } finally {
      input.remove();
    }
  });

  it('A archives, Shift+I marks read, U marks unread; M does nothing', async () => {
    mountHarness();
    const mailStore = viewing();
    const archive = vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 });
    const markSeen = vi.spyOn(mailStore, 'markManySeen').mockResolvedValue(1);
    const toggle = vi.spyOn(mailStore, 'toggleManySeen').mockResolvedValue(1);

    fireKey('a');
    fireKey('I', { shiftKey: true });
    fireKey('u');
    const m = fireKey('m');
    await Promise.resolve();

    expect(archive).toHaveBeenCalledWith([7]);
    expect(markSeen).toHaveBeenNthCalledWith(1, [7], true);
    expect(markSeen).toHaveBeenNthCalledWith(2, [7], false);
    expect(toggle).not.toHaveBeenCalled();
    expect(m.defaultPrevented).toBe(false);
  });

  it('Delete and Shift+Delete destroy; Backspace only counts on macOS', async () => {
    mountHarness();
    const mailStore = viewing();
    const destroy = vi.spyOn(mailStore, 'destroyMessages').mockResolvedValue(undefined);
    const purge = vi.spyOn(mailStore, 'permanentlyDestroyMessages').mockResolvedValue(undefined);

    const backspace = fireKey('Backspace');
    await Promise.resolve();
    expect(backspace.defaultPrevented).toBe(false);
    expect(destroy).not.toHaveBeenCalled();

    fireKey('Delete');
    fireKey('Delete', { shiftKey: true });
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledWith([7]);
    expect(purge).toHaveBeenCalledWith([7]);

    const restore = onMac();
    try {
      fireKey('Backspace');
      await Promise.resolve();
      expect(destroy).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it('* then A selects all loaded messages; A alone still archives', async () => {
    const { messageListCommands } = mountHarness();
    const mailStore = viewing();
    const archive = vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 });

    const star = fireKey('*', { shiftKey: true });
    expect(star.defaultPrevented).toBe(true);
    fireKey('a');
    await Promise.resolve();

    expect(messageListCommands?.selectAll).toHaveBeenCalledOnce();
    expect(archive).not.toHaveBeenCalled();

    fireKey('a');
    await Promise.resolve();
    expect(archive).toHaveBeenCalledWith([7]);
    expect(messageListCommands?.selectAll).toHaveBeenCalledOnce();
  });

  it('a pending * expires', () => {
    vi.useFakeTimers();
    try {
      const { messageListCommands } = mountHarness();
      const mailStore = viewing();
      vi.spyOn(mailStore, 'archiveMessages').mockResolvedValue({ succeeded: 1, failed: 0, skipped: 0 });

      fireKey('*', { shiftKey: true });
      vi.advanceTimersByTime(2000);
      fireKey('a');

      expect(messageListCommands?.selectAll).not.toHaveBeenCalled();
      expect(mailStore.archiveMessages).toHaveBeenCalledWith([7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('J/K step through messages and N/P through unread ones; B is unbound', () => {
    const { messageListCommands } = mountHarness();

    fireKey('j');
    fireKey('k');
    fireKey('n');
    fireKey('p');
    const b = fireKey('b');

    expect(vi.mocked(messageListCommands!.navigate).mock.calls.map(([command]) => command))
      .toEqual(['next', 'previous', 'nextUnread', 'previousUnread']);
    expect(b.defaultPrevented).toBe(false);
  });

  it('Escape clears a checkbox selection', () => {
    mountHarness();
    const mailStore = useMailStore() as any;
    mailStore.messages = [makeRow(1), makeRow(2)];
    mailStore.selectedIds = new Set([1, 2]);

    const event = fireKey('Escape');

    expect(event.defaultPrevented).toBe(true);
    expect(mailStore.selectedIds.size).toBe(0);
  });
});
