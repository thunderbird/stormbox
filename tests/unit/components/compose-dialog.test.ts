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
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { COMPOSE_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import { useContactsStore } from '../../../src/stores/contacts-store';

function firstTextNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node;
  for (const child of node.childNodes) {
    const match = firstTextNode(child);
    if (match) return match;
  }
  return null;
}

function selectEditorText(editor, start = 0, end = 5) {
  const text = firstTextNode(editor);
  expect(text?.nodeValue).toBeTruthy();

  editor.focus();
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

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

async function pasteImageIntoEditor(editor, composeStore) {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new File([bytes], 'paste.png', { type: 'image/png' });
  const clipboardData = {
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    types: ['Files'],
    getData: () => '',
  };
  // Squire's real paste handler detects the image-only clipboard,
  // preventDefaults, and fires its 'pasteImage' custom event, which our
  // component listens for. Drive that whole path with a paste event.
  const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardData });
  editor.dispatchEvent(pasteEvent);

  // FileReader.readAsDataURL is async; poll until the draft picks it up.
  for (let i = 0; i < 50 && !/<img[^>]+src="data:image\/png/i.test(composeStore.draft.htmlBody); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await nextTick();
  }
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

describe('ComposeDialog rich text toolbar', () => {
  it('initializes Squire when compose opens after the component is already mounted', async () => {
    const composeStore = useComposeStore();
    composeStore.identities = [{
      id: 1,
      name: 'Sender',
      email: 'sender@example.com',
    } as any];

    const wrapper = mount(ComposeDialog, { attachTo: document.body });
    composeStore.open({ htmlBody: 'hello world' });
    await nextTick();
    await nextTick();

    const editor = wrapper.get('.editor').element;
    selectEditorText(editor);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(composeStore.draft.htmlBody).toMatch(/<b\b[^>]*>hello<\/b>/i);
  });

  it('applies inline formatting to the selected editor text from toolbar buttons', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const editor = wrapper.get('.editor').element;

    selectEditorText(editor);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(composeStore.draft.htmlBody).toMatch(/<b\b[^>]*>hello<\/b>/i);
  });

  it('depresses toolbar buttons when selected text already has that format', async () => {
    const { wrapper } = await mountOpenCompose('<p><b>hello</b> world</p>');
    const editor = wrapper.get('.editor').element;

    selectEditorText(editor);
    await nextTick();

    expect(wrapper.get('[aria-label="Bold"]').classes()).toContain('active');
  });

  it('formats root-level text typed into an empty editor', async () => {
    const { wrapper, composeStore } = await mountOpenCompose('');
    const editor = wrapper.get('.editor').element;
    editor.textContent = 'hello world';

    selectEditorText(editor);
    await wrapper.get('[aria-label="Bold"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Bold"]').trigger('click');
    await nextTick();

    expect(composeStore.draft.htmlBody).toMatch(/<div><b\b[^>]*>hello<\/b> world<\/div>/i);
  });

  it('keeps the selected range when applying color controls', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const editor = wrapper.get('.editor').element;
    const colorInput = wrapper.get('input[aria-label="Text color"]');

    selectEditorText(editor);
    await colorInput.trigger('pointerdown');
    (colorInput.element as HTMLInputElement).value = '#ff0000';
    await colorInput.trigger('input');
    await nextTick();

    expect(composeStore.draft.htmlBody).toContain('color:#ff0000');
    expect(composeStore.draft.htmlBody).toContain('hello');
  });

  it('supports basic word-style keyboard shortcuts', async () => {
    const { wrapper, composeStore } = await mountOpenCompose();
    const editor = wrapper.get('.editor').element;

    selectEditorText(editor);
    const event = new window.KeyboardEvent('keydown', {
      key: 'i',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(composeStore.draft.htmlBody).toMatch(/<i\b[^>]*>hello<\/i>/i);
    expect(wrapper.get('[aria-label="Italic"]').classes()).toContain('active');
  });

  it('inlines a pasted image as a data: URL via the squire pasteImage hook', async () => {
    const { wrapper, composeStore } = await mountOpenCompose('<p>hello</p>');
    const editor = wrapper.get('.editor').element as HTMLElement;

    await pasteImageIntoEditor(editor, composeStore);

    expect(composeStore.draft.htmlBody).toMatch(/<img[^>]+src="data:image\/png;base64,/i);
    // Pasted images default to centered, applied to the containing block
    // (text-align) so the toolbar alignment buttons can re-align them.
    expect(composeStore.draft.htmlBody).toMatch(/text-align:\s*center/i);
  });

  it('re-aligns a pasted image with the toolbar alignment buttons', async () => {
    const { wrapper, composeStore } = await mountOpenCompose('<p>hello</p>');
    const editor = wrapper.get('.editor').element as HTMLElement;

    await pasteImageIntoEditor(editor, composeStore);
    expect(composeStore.draft.htmlBody).toMatch(/text-align:\s*center/i);

    await wrapper.get('[aria-label="Align right"]').trigger('pointerdown');
    await wrapper.get('[aria-label="Align right"]').trigger('click');
    await nextTick();

    expect(composeStore.draft.htmlBody).toMatch(/text-align:\s*right/i);
    expect(composeStore.draft.htmlBody).not.toMatch(/text-align:\s*center/i);
  });

  it('opens one toolbar dropdown at a time', async () => {
    // Font, Size, and More are AppDropdowns in the default group, so
    // opening any of them closes whichever was open.
    const { wrapper } = await mountOpenCompose();
    const dropdowns = wrapper.get('.compose-toolbar').findAll('details');
    expect(dropdowns.length).toBeGreaterThanOrEqual(3);
    const [font, size] = dropdowns;

    font.element.open = true;
    await font.trigger('toggle');
    size.element.open = true;
    await size.trigger('toggle');

    expect(size.element.open).toBe(true);
    expect(font.element.open, 'opening Size closed Font').toBe(false);
  });

  it('moves rightmost toolbar groups into More as width shrinks', async () => {
    const { wrapper } = await mountOpenCompose();
    const toolbar = wrapper.get('.compose-toolbar').element;
    const groupWidths = {
      style: 116,
      font: 180,
      insert: 70,
      lists: 130,
      alignment: 130,
    };

    Object.defineProperty(toolbar, 'clientWidth', { configurable: true, value: 500 });
    toolbar.querySelectorAll('[data-toolbar-group]').forEach((group: any) => {
      group.getBoundingClientRect = () => ({
        width: groupWidths[group.dataset.toolbarGroup as keyof typeof groupWidths],
      } as DOMRect);
    });
    (wrapper.get('.toolbar-more').element as any).getBoundingClientRect = () => ({ width: 70 } as DOMRect);

    window.dispatchEvent(new Event('resize'));
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-toolbar-group="alignment"]').exists()).toBe(false);
    expect(wrapper.find('[data-toolbar-group="lists"]').exists()).toBe(false);
    expect(wrapper.find('[data-toolbar-group="insert"]').exists()).toBe(true);
    // Scoped to the More control: the font and size dropdowns reuse the
    // same menu classes for their own popups.
    expect(wrapper.get('.toolbar-more .toolbar-more__menu').text()).toContain('Align left');
    expect(wrapper.get('.toolbar-more .toolbar-more__menu').text()).toContain('Bulleted list');
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
    expect(dialog.attributes('aria-label')).toBe('Compose');
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
      organization: null,
      email: 'page@example.com',
    }];
    const sharedContacts = contactsStore.contacts;
    __setRepositoryForTests({
      listContacts: vi.fn(async () => [{
        id: 2,
        remote_id: 'browse-row',
        addressbook_ids: [10],
        display_name: 'Browse row',
        organization: null,
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
        organization: null,
        email: 'zed@example.com',
      },
      {
        id: 4,
        remote_id: 'no-address',
        addressbook_ids: [10],
        display_name: 'No address',
        organization: null,
        email: null,
      },
      {
        id: 5,
        remote_id: 'ada',
        addressbook_ids: [10],
        display_name: 'Ada',
        organization: null,
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

describe('ComposeDialog send control', () => {
  const footerButtons = (wrapper: any) => wrapper.findAll('footer button').map((b: any) => b.text());

  it('offers Send while the outcome of the draft is still open', async () => {
    const { wrapper } = await mountOpenCompose();
    expect(footerButtons(wrapper)).toContain('Send');
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

    expect(footerButtons(wrapper)).toContain('Send');
    expect(footerButtons(wrapper)).toContain('Discard');
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
