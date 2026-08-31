// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import ComposeDialog from '../../../src/components/ComposeDialog.vue';
import ComposeManager from '../../../src/components/ComposeManager.vue';
import RichTextEditor from '../../../src/components/RichTextEditor.vue';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { COMPOSE_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import { useContactsStore } from '../../../src/stores/contacts-store';

async function mountOpenCompose(htmlBody = 'hello world') {
  const composeStore = useComposeStore();
  composeStore.identities = [{
    id: 1,
    name: 'Sender',
    email: 'sender@example.com',
  } as any];
  composeStore.open({ htmlBody });

  const wrapper = mount(ComposeDialog, { attachTo: document.body });
  await nextTick();
  return { wrapper, composeStore };
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  __resetRepositoryForTests();
});

describe('ComposeDialog rich text integration', () => {
  it('mounts the editor after opening and syncs paired body values', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{
      id: 1,
      name: 'Sender',
      email: 'sender@example.com',
    } as any];

    const wrapper = mount(ComposeDialog, { attachTo: document.body });
    const touchSession = vi.spyOn(composeStore, 'touchSession');
    composeStore.open({ htmlBody: 'hello world' });
    await nextTick();
    await nextTick();

    expect(touchSession).not.toHaveBeenCalled();
    const editor = wrapper.get('.editor').element as HTMLElement;
    editor.innerHTML = '<div>first line<br>second line</div><div>third line</div>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(composeStore.draft.htmlBody)
      .toBe('<div>first line<br>second line</div><div>third line</div>');
    expect(composeStore.draft.textBody).toBe('first line\nsecond line\nthird line');
    expect(touchSession).toHaveBeenCalledTimes(1);
    expect(touchSession).toHaveBeenCalledWith(composeStore.activeSessionId);
  });

  it('updates the mounted editor in place when From replaces a signature', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [
      {
        id: 1,
        remote_id: 'first',
        name: 'First',
        email: 'first@example.com',
        bcc: [{ name: 'First archive', email: 'first-archive@example.com' }],
        html_signature: '<p>First signature</p>',
        text_signature: 'First signature',
      } as any,
      {
        id: 2,
        remote_id: 'second',
        name: 'Second',
        email: 'second@example.com',
        bcc: [{ name: 'Second archive', email: 'second-archive@example.com' }],
        html_signature: '<p>Second signature</p>',
        text_signature: 'Second signature',
      } as any,
    ];
    const sessionId = composeStore.open({ fromIdx: 0 });
    const wrapper = mount(ComposeDialog, { attachTo: document.body });
    await nextTick();
    const editor = wrapper.get('.editor').element as HTMLElement;
    editor.innerHTML = editor.innerHTML.replace(
      '<div><br></div>',
      '<p>User paragraph</p>',
    );
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const userText = editor.querySelector('p')!.firstChild!;
    editor.focus();
    const range = document.createRange();
    range.setStart(userText, 4);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    composeStore.selectFromIndex(1, sessionId);
    await nextTick();
    await nextTick();

    expect(wrapper.get('.editor').element).toBe(editor);
    expect(editor.innerHTML).toContain('Second signature');
    expect(editor.innerHTML).not.toContain('First signature');
    expect(document.activeElement).toBe(editor);
    expect(selection.anchorNode).toBe(userText);
    expect(selection.anchorOffset).toBe(4);
    expect(composeStore.draft.bcc).toEqual([
      { name: 'Second archive', email: 'second-archive@example.com' },
    ]);
    expect(composeStore.draft.htmlBody).not.toContain('data-stormbox-');
  });

  it('does not reset an unrelated minimized editor on a From change', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [
      {
        id: 1,
        remote_id: 'first',
        name: 'First',
        email: 'first@example.com',
        bcc: [],
        html_signature: '<p>First signature</p>',
        text_signature: 'First signature',
      } as any,
      {
        id: 2,
        remote_id: 'second',
        name: 'Second',
        email: 'second@example.com',
        bcc: [],
        html_signature: '<p>Second signature</p>',
        text_signature: 'Second signature',
      } as any,
    ];
    const firstId = composeStore.open({ fromIdx: 0, subject: 'Minimized' });
    const secondId = composeStore.open({ fromIdx: 0, subject: 'Expanded' });
    const wrapper = mount(ComposeManager, { attachTo: document.body });
    await nextTick();
    const dialogFor = (title: string) => wrapper.findAll('.compose-dialog')
      .find((dialog) => dialog.get('h2').text() === title)!;
    const minimizedEditor = dialogFor('Minimized').get('.editor').element as HTMLElement;
    const expandedEditor = dialogFor('Expanded').get('.editor').element as HTMLElement;
    minimizedEditor.innerHTML = minimizedEditor.innerHTML.replace(
      '<div><br></div>',
      '<p>Minimized user text</p>',
    );
    minimizedEditor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const minimizedHtml = minimizedEditor.innerHTML;

    composeStore.selectFromIndex(1, secondId);
    await nextTick();
    await nextTick();

    expect(composeStore.sessionById(firstId)?.presentation).toBe('minimized');
    expect(dialogFor('Minimized').get('.editor').element).toBe(minimizedEditor);
    expect(minimizedEditor.innerHTML).toBe(minimizedHtml);
    expect(dialogFor('Expanded').get('.editor').element).toBe(expandedEditor);
    expect(expandedEditor.innerHTML).toContain('Second signature');
  });
});

describe('ComposeDialog recipient fields', () => {
  const rowLabels = (wrapper: any) => wrapper.findAll('.row label').map((l: any) => l.text());
  const toggleLabels = (wrapper: any) => wrapper
    .findAll('.recipient-toggle')
    .map((b: any) => b.text());
  const recipientToggle = (wrapper: any, label: string) => wrapper
    .findAll('.recipient-toggle')
    .find((b: any) => b.text() === label);
  const recipientRow = (wrapper: any, label: string) => wrapper
    .findAll('.row')
    .find((row: any) => row.find('label').text() === label);
  const recipientInput = (wrapper: any, label: string) => recipientRow(wrapper, label)
    .find('input');
  const pills = (wrapper: any, label: string) => recipientRow(wrapper, label)
    .findAll('.pill')
    .map((pill: any) => ({
      text: pill.find('.pill__text').text(),
      invalid: pill.classes('pill--invalid'),
    }));

  /**
   * Wait out the control's suggestion debounce and let the query settle.
   * Real time rather than fake, because other tests in this file poll on
   * real timers and swapping them out globally would stall those.
   */
  async function suggestionsSettled() {
    await new Promise((resolve) => { setTimeout(resolve, 160); });
    await flushPromises();
    await nextTick();
  }

  /** Type into a field and commit it the way Enter does. */
  async function enterRecipient(wrapper: any, label: string, value: string) {
    const input = recipientInput(wrapper, label);
    input.element.value = value;
    await input.trigger('input');
    await input.trigger('keydown', { key: 'Enter' });
    await nextTick();
    return input;
  }

  it('announces itself as a modal dialog', async () => {
    // Without aria-modal a screen reader keeps offering the mail list
    // behind the composer as ordinary page content, so the user can read
    // and act on it while a message is open.
    const { wrapper } = await mountOpenCompose();
    const dialog = wrapper.get('.compose-dialog');
    expect(dialog.attributes('role')).toBe('dialog');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-labelledby')).toBe('compose-title');
    expect(wrapper.get('#compose-title').text()).toBe('New Message');
  });

  it('opens with To only, and offers both Cc and Bcc toggles inline', async () => {
    // Three empty fields on every new message is why Cc and Bcc were left
    // out to begin with; they appear when there is a reason for them. Both
    // toggles are offered at once, inline with To.
    const { wrapper } = await mountOpenCompose();
    expect(rowLabels(wrapper)).toEqual(['From', 'To', 'Subject']);
    expect(toggleLabels(wrapper)).toEqual(['Cc', 'Bcc']);

    await recipientToggle(wrapper, 'Cc').trigger('click');
    expect(rowLabels(wrapper)).toEqual(['From', 'To', 'Cc', 'Subject']);
    expect(toggleLabels(wrapper)).toEqual(['Bcc']);

    // Give Cc a recipient so revealing Bcc — which blurs the empty Cc —
    // does not collapse it; an empty field hides on blur by design.
    await enterRecipient(wrapper, 'Cc', 'cc@example.com');
    await recipientToggle(wrapper, 'Bcc').trigger('click');
    expect(rowLabels(wrapper)).toEqual(['From', 'To', 'Cc', 'Bcc', 'Subject']);
    expect(toggleLabels(wrapper)).toEqual([]);
  });

  it('collapses an empty Cc when focus leaves the row', async () => {
    const { wrapper } = await mountOpenCompose();
    await recipientToggle(wrapper, 'Cc').trigger('click');
    expect(rowLabels(wrapper)).toContain('Cc');

    // focusout bubbles from the field's input to the row; no relatedTarget
    // means focus left the row entirely.
    await recipientInput(wrapper, 'Cc').trigger('focusout');
    await nextTick();
    await nextTick();

    expect(rowLabels(wrapper)).not.toContain('Cc');
    // The toggle comes back, so the field can be reopened.
    expect(toggleLabels(wrapper)).toContain('Cc');
  });

  it('keeps a Cc that holds a recipient when focus leaves the row', async () => {
    const { wrapper } = await mountOpenCompose();
    await recipientToggle(wrapper, 'Cc').trigger('click');
    await enterRecipient(wrapper, 'Cc', 'cc@example.com');

    await recipientInput(wrapper, 'Cc').trigger('focusout');
    await nextTick();
    await nextTick();

    expect(rowLabels(wrapper)).toContain('Cc');
  });

  it('shows Cc already filled by a reply-all without being asked', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{ id: 1, email: 'sender@example.com' } as any];
    composeStore.open({
      to: [{ email: 'alice@example.com' }],
      cc: [{ name: 'Bob', email: 'bob@example.com' }],
    });
    const wrapper = mount(ComposeDialog, { attachTo: document.body });
    await nextTick();

    expect(rowLabels(wrapper)).toEqual(['From', 'To', 'Cc', 'Subject']);
    expect(pills(wrapper, 'Cc')).toEqual([{ text: 'Bob', invalid: false }]);
  });

  it('turns committed text into the draft addresses', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();

    await enterRecipient(wrapper, 'To', '"Smith, Alice" <alice@example.com>, bob@example.com');

    expect(composeStore.draft.to).toEqual([
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { email: 'bob@example.com' },
    ]);
    expect(pills(wrapper, 'To')).toEqual([
      { text: 'Smith, Alice', invalid: false },
      { text: 'bob@example.com', invalid: false },
    ]);
  });

  it('leaves what the user is typing alone', async () => {
    // An entry becomes a pill when the user says it is finished, not while
    // it is half-written: reformatting mid-word rewrites what is being
    // typed, and committing early makes a pill of `ali`.
    const { wrapper, composeStore } = await mountOpenCompose();
    const input = recipientInput(wrapper, 'To');

    input.element.value = 'ali';
    await input.trigger('input');
    await nextTick();

    expect(input.element.value).toBe('ali');
    expect(pills(wrapper, 'To')).toEqual([]);
    expect(composeStore.draft.to).toEqual([]);
  });

  it('commits an unreadable entry as an invalid pill that refuses the send', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();

    await enterRecipient(wrapper, 'To', 'alice@example.com, not an address');

    expect(pills(wrapper, 'To')).toEqual([
      { text: 'alice@example.com', invalid: false },
      { text: 'not an address', invalid: true },
    ]);
    expect(composeStore.rejectedRecipients.to).toEqual(['not an address']);
    expect(composeStore.draft.to).toEqual([{ email: 'alice@example.com' }]);
  });

  it('adds a chosen suggestion beside the recipients already committed', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const contactsStore = useContactsStore();
    contactsStore.autocomplete = vi.fn(async () => [
      { name: 'Bob', email: 'bob@example.com', source: 'contact' },
    ]) as any;
    await enterRecipient(wrapper, 'To', '"Smith, Alice" <alice@example.com>');

    const input = recipientInput(wrapper, 'To');
    input.element.value = 'bo';
    await input.trigger('input');
    await suggestionsSettled();

    await wrapper.get('.autocomplete__option').trigger('click');
    await nextTick();

    expect(pills(wrapper, 'To')).toEqual([
      { text: 'Smith, Alice', invalid: false },
      { text: 'Bob', invalid: false },
    ]);
    expect(composeStore.draft.to).toEqual([
      { name: 'Smith, Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
    ]);
  });

  it('re-reads the fields when a reply replaces the draft', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const input = recipientInput(wrapper, 'To');
    input.element.value = 'typing@example.com';
    await input.trigger('input');

    composeStore.open({ to: [{ name: 'Alice', email: 'alice@example.com' }] });
    await nextTick();

    expect(pills(wrapper, 'To')).toEqual([{ text: 'Alice', invalid: false }]);
    // The half-typed entry belonged to the message that was replaced.
    expect(recipientInput(wrapper, 'To').element.value).toBe('');
  });

  it('does not offer a contact who is already a recipient in another field', async () => {
    const { wrapper } = await mountOpenCompose();
    const contactsStore = useContactsStore();
    contactsStore.autocomplete = vi.fn(async () => [
      { name: 'Bob', email: 'bob@example.com', source: 'contact' },
      { name: 'Bobbie', email: 'bobbie@example.com', source: 'contact' },
    ]) as any;
    await enterRecipient(wrapper, 'To', 'bob@example.com');
    await recipientToggle(wrapper, 'Cc').trigger('click');

    const cc = recipientInput(wrapper, 'Cc');
    cc.element.value = 'bob';
    await cc.trigger('input');
    await suggestionsSettled();

    const offered = recipientRow(wrapper, 'Cc')
      .findAll('.autocomplete__option .ac-email')
      .map((el: any) => el.text());
    expect(offered).toEqual(['bobbie@example.com']);
  });

  it('leaves the Contacts view collection untouched when browse opens', async () => {
    // Compose needs a snapshot of the address book, while the store array
    // remains the reactive collection rendered by the Contacts space.
    const authStore = useAuthStore();
    authStore.accountId = 7;
    const contactsStore = useContactsStore();
    contactsStore.contacts = [{
      id: 1,
      remote_id: 'page-row',
      addressbook_ids: [10],
      display_name: 'Page row',
      email: 'page@example.com',
    }];
    const sharedContacts = contactsStore.contacts;
    __setRepositoryForTests({
      listContacts: vi.fn(async () => [{
        id: 2,
        remote_id: 'browse-row',
        addressbook_ids: [10],
        display_name: 'Browse row',
        email: 'browse@example.com',
      }]),
    });
    const { wrapper } = await mountOpenCompose();

    await recipientInput(wrapper, 'To').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    await nextTick();

    expect(contactsStore.contacts).toBe(sharedContacts);
    expect(contactsStore.contacts.map((contact) => contact.remote_id)).toEqual(['page-row']);
  });

  it('shows the repository browse rows in their existing order and shape', async () => {
    // CONTACT_LIST supplies display order and the preferred address; compose
    // preserves both while omitting cards that have no address to select.
    const authStore = useAuthStore();
    authStore.accountId = 7;
    const listContacts = vi.fn(async () => [
      {
        id: 3,
        remote_id: 'zed',
        addressbook_ids: [10],
        display_name: 'Zed',
        email: 'zed@example.com',
      },
      {
        id: 4,
        remote_id: 'no-address',
        addressbook_ids: [10],
        display_name: 'No address',
        email: null,
      },
      {
        id: 5,
        remote_id: 'ada',
        addressbook_ids: [10],
        display_name: 'Ada',
        email: 'ada@example.com',
      },
    ]);
    __setRepositoryForTests({ listContacts });
    const { wrapper } = await mountOpenCompose();

    await recipientInput(wrapper, 'To').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    await nextTick();

    expect(listContacts).toHaveBeenCalledWith(7);
    expect(wrapper.findAll('.autocomplete__option').map((option) =>
      option.attributes('aria-label'))).toEqual([
      'Zed <zed@example.com>',
      'Ada <ada@example.com>',
    ]);
  });
});

describe('ComposeDialog attachment controls', () => {
  it('places an accessible multiple picker immediately beside Send', async () => {
    const { wrapper } = await mountOpenCompose();
    const input = wrapper.get('footer input[type="file"]');
    const click = vi.spyOn(input.element as HTMLInputElement, 'click');
    const buttons = wrapper.findAll('footer button');

    expect(input.attributes('multiple')).toBeDefined();
    expect(input.attributes('hidden')).toBeDefined();
    expect(buttons.map((button) => button.attributes('aria-label') || button.text()))
      .toEqual(['Attach files', 'Send']);
    expect(buttons[0].text()).toBe('Attach');
    await buttons[0].trigger('click');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('shows progress and status-specific Retry, Cancel, and Remove actions', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const session = composeStore.activeSession!;
    session.attachments.push(
      {
        clientId: 'uploading',
        name: 'uploading.txt',
        type: 'text/plain',
        size: 3,
        source: 'picker',
        status: 'uploading',
        uploadBlobId: null,
        canonicalBlobId: null,
        partId: null,
        error: null,
        progress: 40,
      },
      {
        clientId: 'failed',
        name: 'failed.txt',
        type: 'text/plain',
        size: 4,
        source: 'paste',
        status: 'failed',
        uploadBlobId: null,
        canonicalBlobId: null,
        partId: null,
        error: 'Upload failed: offline',
        progress: 0,
      },
    );
    const retry = vi.spyOn(composeStore, 'retryAttachment').mockResolvedValue(true);
    const cancel = vi.spyOn(composeStore, 'cancelAttachment').mockReturnValue(true);
    const remove = vi.spyOn(composeStore, 'removeAttachment').mockReturnValue(true);
    await nextTick();

    expect(wrapper.get('progress').attributes('aria-label'))
      .toBe('Uploading uploading.txt: 40%');
    expect(wrapper.text()).toContain('uploading.txt');
    expect(wrapper.text()).toContain('3 B');
    expect(wrapper.text()).toContain('Upload failed: offline');

    await wrapper.get('[aria-label="Cancel upload of uploading.txt"]').trigger('click');
    await wrapper.get('[aria-label="Retry failed.txt"]').trigger('click');
    await wrapper.get('[aria-label="Remove failed.txt"]').trigger('click');
    expect(cancel).toHaveBeenCalledWith('uploading', session.id);
    expect(retry).toHaveBeenCalledWith('failed', session.id);
    expect(remove).toHaveBeenCalledWith('failed', session.id);
  });

  it('sanitizes attachment names in visible and accessible labels', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    composeStore.activeSession!.attachments.push({
      clientId: 'hostile-name',
      name: '../../CON\u202e.zip',
      type: 'application/zip',
      size: 22,
      source: 'picker',
      status: 'ready',
      uploadBlobId: 'uploaded',
      canonicalBlobId: null,
      partId: null,
      error: null,
      progress: 100,
    });
    await nextTick();

    expect(wrapper.get('.compose-attachment__name').text()).toBe('_CON.zip');
    expect(wrapper.get('[aria-label="Remove _CON.zip"]').attributes('aria-label'))
      .toBe('Remove _CON.zip');
    expect(wrapper.text()).not.toContain('\u202e');
  });

  it('uploads only regular classifications emitted by the editor', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const addAttachments = vi.spyOn(composeStore, 'addAttachments').mockResolvedValue(true);
    const inline = new File(['image'], 'inline.png', { type: 'image/png' });
    const regular = new File(['document'], 'document.pdf', { type: 'application/pdf' });

    wrapper.findComponent(RichTextEditor).vm.$emit('paste-files', [
      { file: inline, kind: 'inline' },
      { file: regular, kind: 'attachment' },
    ]);
    await flushPromises();

    expect(addAttachments).toHaveBeenCalledWith(
      [regular],
      'paste',
      composeStore.activeSessionId,
    );
  });

  it('explains uncheckpointed attachments in the close prompt', async () => {
    const { wrapper, composeStore } = await mountOpenCompose('');
    const session = composeStore.activeSession!;
    session.attachments.push({
      clientId: 'pending',
      name: 'pending.txt',
      type: 'text/plain',
      size: 1,
      source: 'picker',
      status: 'failed',
      uploadBlobId: null,
      canonicalBlobId: null,
      partId: null,
      error: 'Upload failed',
      progress: 0,
    });
    composeStore.requestClose(session.id);
    await nextTick();

    expect(wrapper.get('#compose-close-description').text())
      .toContain('attachments have not reached the draft');
  });
});

describe('ComposeDialog send control', () => {
  const footerButtons = (wrapper: any) => wrapper.findAll('footer button')
    .map((button: any) => button.attributes('aria-label') || button.text());

  it('offers Send while the outcome of the draft is still open', async () => {
    const { wrapper } = await mountOpenCompose();
    expect(footerButtons(wrapper)).toEqual(['Attach files', 'Send']);
  });

  it('greys Send through attachment preflight and upload, then re-enables it', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const session = composeStore.activeSession!;
    const send = wrapper.get('footer .compose-send');

    expect(send.attributes('disabled')).toBeUndefined();
    session.attachmentPreflights.push({ id: 'rejected-preflight', accountId: 1 });
    await nextTick();
    expect(send.attributes('disabled')).toBeDefined();

    session.attachmentPreflights.splice(0);
    await nextTick();
    expect(send.attributes('disabled')).toBeUndefined();

    session.attachmentPreflights.push({ id: 'accepted-preflight', accountId: 1 });
    await nextTick();
    expect(send.attributes('disabled')).toBeDefined();
    session.attachments.push({
      clientId: 'uploading',
      name: 'uploading.txt',
      type: 'text/plain',
      size: 1,
      source: 'picker',
      status: 'uploading',
      uploadBlobId: null,
      canonicalBlobId: null,
      partId: null,
      error: null,
      progress: 0,
    });
    session.attachmentPreflights.splice(0);
    await nextTick();
    expect(send.attributes('disabled')).toBeDefined();

    session.attachments[0].status = 'ready';
    session.attachments[0].uploadBlobId = 'uploaded';
    await nextTick();
    expect(send.attributes('disabled')).toBeUndefined();
  });

  it('keeps Send offered while an unconfirmed send holds the draft open', async () => {
    // When the outcome is unknown and no server copy is known, the store
    // keeps the dialog open with a warning to check Sent first. Send is
    // never resubmitted automatically, but it stays available: after that
    // check, sending again is the user's decision (CS-1.9).
    const { wrapper, composeStore } = await mountOpenCompose();
    composeStore.status = COMPOSE_STATE.FAILED;
    composeStore.error = 'Could not confirm whether this message was sent. '
      + 'Check your Sent folder before sending it again.';
    await nextTick();

    expect(footerButtons(wrapper)).toEqual(['Attach files', 'Send']);
    expect(wrapper.get('.compose-error').text()).toMatch(/check your sent folder/i);
  });

  it('announces a send error from an assertive live region', async () => {
    // A failed send is the one moment the user must not miss, and
    // StoreErrorToast stays silent while compose is open, so the inline
    // message carries the announcement itself.
    const { wrapper, composeStore } = await mountOpenCompose();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);

    composeStore.error = 'The message could not be sent.';
    await nextTick();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toBe('The message could not be sent.');
    expect(alert.attributes('aria-live')).toBe('assertive');
    expect(alert.attributes('aria-atomic')).toBe('true');

    // Nothing is rendered without an error: the card is a flex column with
    // a gap, so an always-present region would leave a space under the
    // footer in the state the composer is usually in.
    composeStore.error = null;
    await nextTick();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('keeps Discard available but disables conflicting actions while saving', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const session = composeStore.activeSession!;
    session.saveError = 'Draft autosave failed.';
    await nextTick();

    const status = wrapper.get('.compose-save-error');
    expect(status.text()).toContain('Draft autosave failed');

    session.isSaving = true;
    await nextTick();
    expect(wrapper.get('[aria-label="Close options"]').attributes('aria-disabled')).toBeUndefined();
    expect(wrapper.get('[aria-label="Minimize"]').attributes('disabled')).toBeDefined();
    const closeItems = wrapper.findAll('[role="menuitem"]');
    expect(closeItems.find((item) => item.text() === 'Discard')!.attributes('disabled'))
      .toBeUndefined();
    expect(closeItems.find((item) => item.text() === 'Save Draft')!.attributes('disabled'))
      .toBeDefined();
  });
});

describe('ComposeDialog opening focus', () => {
  it('starts a fresh message in the To field', async () => {
    await mountOpenCompose();
    await nextTick();
    await flushPromises();

    expect(document.activeElement?.id).toBe('compose-to');
  });

  it('starts a prefilled draft in the body, where writing continues', async () => {
    // A reply arrives already addressed; landing focus in To would put
    // the first keystrokes into a field that is finished.
    const composeStore = useComposeStore();
    composeStore.identities = [{
      id: 1,
      name: 'Sender',
      email: 'sender@example.com',
    } as any];
    composeStore.open({
      to: [{ email: 'alice@example.com' }],
      htmlBody: 'quoted',
    });
    const wrapper = mount(ComposeDialog, { attachTo: document.body });
    await nextTick();
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('.editor').element);
  });

  it('moves focus with a draft that replaces the open one', async () => {
    const { composeStore } = await mountOpenCompose();
    await flushPromises();

    composeStore.open({ to: [{ email: 'alice@example.com' }], htmlBody: 'quoted' });
    await nextTick();
    await flushPromises();

    expect(document.activeElement?.id).not.toBe('compose-to');
  });
});

describe('ComposeDialog accessibility', () => {
  it('names the dialog, subject, and message body', async () => {
    const { wrapper } = await mountOpenCompose();
    const dialog = wrapper.get('[role="dialog"]');
    const heading = wrapper.get('h2');
    const subject = wrapper.get('#compose-subject');
    const body = wrapper.get('.editor');

    expect(dialog.attributes('aria-labelledby')).toBe(heading.attributes('id'));
    expect(wrapper.get('label[for="compose-subject"]').text()).toBe('Subject');
    expect(subject.attributes('type')).toBe('text');
    expect(body.attributes()).toMatchObject({
      role: 'textbox',
      'aria-label': 'Message body',
      'aria-multiline': 'true',
    });
  });

  it('keeps the Save Draft menu label stable while autosaving', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    composeStore.activeSession!.isSaving = true;
    await nextTick();

    const saveDraft = wrapper.findAll('[role="menuitem"]')
      .find((item) => item.text() === 'Save Draft')!;
    expect(saveDraft.text()).toBe('Save Draft');
    expect(saveDraft.attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('footer button').map((button) => button.text()))
      .toEqual(['Attach', 'Send']);
  });

  it('keeps Tab focus inside the composer and its close prompt', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const dialog = wrapper.get('[role="dialog"]');
    const windowButtons = wrapper.findAll('.compose-dialog__window-actions button');
    const first = windowButtons[0].element as HTMLButtonElement;
    const send = wrapper.findAll('footer button').at(-1)!.element as HTMLButtonElement;
    send.focus();

    send.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(first);

    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(send);

    await wrapper.get('#compose-subject').setValue('Unsaved');
    const close = wrapper.get('[aria-label="Close options"]');
    await close.trigger('pointerdown');
    composeStore.requestClose(composeStore.activeSessionId);
    await nextTick();
    await flushPromises();
    const prompt = wrapper.get('[role="alertdialog"]');
    const promptButtons = prompt.findAll('button');
    expect(document.activeElement).toBe(prompt.element);
    expect(promptButtons.some((button) => button.element === document.activeElement)).toBe(false);

    prompt.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(promptButtons[0].element);

    const save = promptButtons.at(-1)!.element as HTMLButtonElement;
    save.focus();
    save.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(promptButtons[0].element);
    expect(dialog.attributes('role')).toBe('dialog');
  });

  it('does not visually preselect an action when Close is activated from the keyboard', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const sessionId = composeStore.activeSessionId;
    const save = vi.spyOn(composeStore, 'saveAndClose').mockResolvedValue(true);
    await wrapper.get('#compose-subject').setValue('Unsaved');
    const close = wrapper.get('[aria-label="Close options"]');

    await close.trigger('keydown', { key: 'Enter' });
    composeStore.requestClose(composeStore.activeSessionId);
    await nextTick();
    await flushPromises();

    const prompt = wrapper.get('[role="alertdialog"]');
    expect(document.activeElement).toBe(prompt.element);
    expect(prompt.findAll('button').some((button) =>
      button.element === document.activeElement)).toBe(false);
    prompt.element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));
    expect(save).toHaveBeenCalledWith(sessionId);
  });
});

describe('ComposeManager window presentation', () => {
  it('shows one expanded session and docks every minimized session', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{ id: 1, email: 'sender@example.com' } as any];
    const firstId = composeStore.open({ subject: 'First draft' });
    const secondId = composeStore.open({ subject: 'Second draft' });
    const wrapper = mount(ComposeManager, { attachTo: document.body });
    await nextTick();

    expect(wrapper.findAll('.compose-dialog')).toHaveLength(2);
    expect(wrapper.findAll('.compose-dialog--expanded')).toHaveLength(1);
    expect(wrapper.get('.compose-dialog--expanded h2').text()).toBe('Second draft');
    expect(wrapper.findAll('.compose-dock__item')).toHaveLength(1);
    expect(wrapper.get('.compose-dock__title').text()).toBe('First draft');

    await wrapper.get(`[aria-label="Restore First draft"]`).trigger('click');
    await nextTick();
    expect(composeStore.activeSessionId).toBe(firstId);
    expect(composeStore.sessionById(secondId)?.presentation).toBe('minimized');
    expect(wrapper.get('.compose-dialog--expanded h2').text()).toBe('First draft');
    wrapper.unmount();
    composeStore.$reset();
  });

  it('keeps body state and draft sync isolated while switching sessions', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{ id: 1, email: 'sender@example.com' } as any];
    const firstId = composeStore.open({
      subject: 'First draft',
      htmlBody: '<p>First body</p>',
    });
    const secondId = composeStore.open({
      subject: 'Second draft',
      htmlBody: '<p>Second body</p>',
    });
    const wrapper = mount(ComposeManager, { attachTo: document.body });
    await nextTick();
    const dialogFor = (title: string) => wrapper.findAll('.compose-dialog')
      .find((dialog) => dialog.get('h2').text() === title)!;
    const firstEditor = dialogFor('First draft').get('.editor').element as HTMLElement;
    const secondEditor = dialogFor('Second draft').get('.editor').element as HTMLElement;

    secondEditor.innerHTML = '<div>Second edit</div>';
    secondEditor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(composeStore.sessionById(secondId)?.draft).toMatchObject({
      htmlBody: '<div>Second edit</div>',
      textBody: secondEditor.innerText,
    });
    expect(composeStore.sessionById(firstId)?.draft.htmlBody).toBe('<p>First body</p>');

    await wrapper.get('[aria-label="Restore First draft"]').trigger('click');
    await nextTick();
    expect(wrapper.get('.compose-dialog--expanded .editor').element).toBe(firstEditor);
    expect(firstEditor.innerHTML).toContain('First body');
    expect(secondEditor.isConnected).toBe(true);

    firstEditor.innerHTML = '<div>First edit</div>';
    firstEditor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(composeStore.sessionById(firstId)?.draft.textBody).toBe(firstEditor.innerText);
    expect(composeStore.sessionById(secondId)?.draft.htmlBody).toBe('<div>Second edit</div>');
    wrapper.unmount();
    composeStore.$reset();
  });

  it('keeps the same editor mounted across minimize and restore', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{ id: 1, email: 'sender@example.com' } as any];
    const sessionId = composeStore.open({ htmlBody: '<p>Keep this</p>' });
    const wrapper = mount(ComposeManager, { attachTo: document.body });
    await nextTick();
    const editor = wrapper.get('.editor').element;

    await wrapper.get('[aria-label="Minimize"]').trigger('click');
    await nextTick();
    expect(editor.isConnected).toBe(true);
    expect(wrapper.findAll('.editor').map((node) => node.element)).toContain(editor);

    await wrapper.get('[aria-label="Restore New message"]').trigger('click');
    await nextTick();
    expect(composeStore.activeSessionId).toBe(sessionId);
    expect(wrapper.get('.editor').element).toBe(editor);
    expect(wrapper.get('.editor').html()).toContain('Keep this');
    wrapper.unmount();
    composeStore.$reset();
  });

  it('closes an empty message directly from the X', async () => {
    const { wrapper, composeStore } = await mountOpenCompose('');
    const sessionId = composeStore.activeSessionId!;
    await flushPromises();

    const close = wrapper.get('[aria-label="Close"]');
    await close.trigger('click');
    await nextTick();

    expect(composeStore.sessionById(sessionId)).toBeNull();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it('treats automatic Bcc and signature defaults as empty for the X', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{
      id: 1,
      remote_id: 'sender',
      name: 'Sender',
      email: 'sender@example.com',
      bcc: [{ name: 'Archive', email: 'archive@example.com' }],
      html_signature: '<p>Automatic signature</p>',
      text_signature: 'Automatic signature',
    } as any];
    const sessionId = composeStore.open();
    const wrapper = mount(ComposeManager, { attachTo: document.body });
    await nextTick();
    await flushPromises();

    expect(wrapper.find('[aria-label="Close"]').exists()).toBe(true);
    expect(wrapper.findAll('.pill__text').map((pill) => pill.text())).toContain('Archive');
    await wrapper.get('[aria-label="Close"]').trigger('click');
    await nextTick();

    expect(composeStore.sessionById(sessionId)).toBeNull();
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it('offers Discard and Save Draft from the close menu', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{ id: 1, email: 'sender@example.com' } as any];
    const sessionId = composeStore.open({ subject: 'Draft' });
    const wrapper = mount(ComposeManager, { attachTo: document.body });
    await nextTick();
    await flushPromises();
    const editor = wrapper.get('.editor').element as HTMLElement;
    composeStore.sessionById(sessionId)!.draft.textBody = `${editor.innerText}\n`;

    const closeMenu = wrapper.get('.compose-close-menu');
    const closeTrigger = closeMenu.get('summary');
    expect(closeTrigger.attributes()).toMatchObject({
      role: 'button',
      'aria-haspopup': 'menu',
      'aria-label': 'Close options',
    });
    await closeTrigger.trigger('click');
    await nextTick();
    expect(closeMenu.attributes('open')).toBeDefined();
    expect(closeMenu.findAll('[role="menuitem"]').map((item) => item.text()))
      .toEqual(['Discard', 'Save Draft']);

    await closeMenu.findAll('[role="menuitem"]')[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(composeStore.sessionById(sessionId)).toBeNull();
    wrapper.unmount();
    composeStore.$reset();
  });

  it('retains the dirty-close prompt for keyboard and dock close requests', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{ id: 1, email: 'sender@example.com' } as any];
    const sessionId = composeStore.open();
    const wrapper = mount(ComposeManager, { attachTo: document.body });
    await nextTick();

    const subjectRow = wrapper.findAll('.row')
      .find((row) => row.find('label').text() === 'Subject')!;
    await subjectRow.get('input').setValue('Unsaved subject');
    composeStore.requestClose(sessionId);
    await nextTick();

    const prompt = wrapper.get('[role="alertdialog"]');
    expect(prompt.text()).toContain('Save draft');
    expect(prompt.text()).toContain("Don't Save");
    expect(wrapper.findAll('footer button')
      .map((button) => button.attributes('aria-label') || button.text()))
      .toEqual(['Attach files', 'Send']);

    await prompt.findAll('button').find((button) => button.text() === "Don't Save")!.trigger('click');
    expect(composeStore.sessionById(sessionId)).toBeNull();
    wrapper.unmount();
    composeStore.$reset();
  });
});
