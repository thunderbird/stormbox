// @vitest-environment happy-dom

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  flushPromises,
  mount,
  type VueWrapper,
} from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import ContactsView from '../../../src/components/ContactsView.vue';
import { SERVICE_KIND } from '../../../src/constants/states';
import { useContactsStore } from '../../../src/stores/contacts-store';
import type {
  AddressbookRow,
  ContactDetail,
  ContactListRow,
  IdentityRow,
} from '../../../src/types';

const CONTACT_ROW_HEIGHT = 59;
const CONTACT_LIST_HEIGHT = 472;
const mountedWrappers: VueWrapper[] = [];
let offsetHeightDescriptor: PropertyDescriptor | undefined;
let offsetWidthDescriptor: PropertyDescriptor | undefined;

const addressbooks: AddressbookRow[] = [
  {
    id: 1,
    account_id: 1,
    service_kind: SERVICE_KIND.JMAP_CONTACTS,
    remote_id: 'book-1',
    name: 'Contacts',
    description: null,
    is_default: 1,
    is_subscribed: 1,
    may_write: 1,
    ctag: null,
    sync_token: null,
    raw_json: null,
    is_deleted: 0,
    updated_at: 1,
  },
  {
    id: 2,
    account_id: 1,
    service_kind: SERVICE_KIND.JMAP_CONTACTS,
    remote_id: 'book-2',
    name: 'Team',
    description: null,
    is_default: 0,
    is_subscribed: 1,
    may_write: 1,
    ctag: null,
    sync_token: null,
    raw_json: null,
    is_deleted: 0,
    updated_at: 1,
  },
];

function setWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
}

function makePointerEvent(type: string, clientX: number, button = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: clientX });
  Object.defineProperty(event, 'button', { value: button });
  return event;
}

function makeContact(index: number, email: string | null = undefined): ContactListRow {
  const suffix = String(index).padStart(4, '0');
  return {
    id: index + 1,
    remote_id: `contact-${index + 1}`,
    addressbook_ids: [index % 2 === 0 ? 1 : 2],
    display_name: `Person ${suffix}`,
    email: email === undefined ? `person${suffix}@example.com` : email,
  };
}

function makeDetail(
  contact: ContactListRow,
  overrides: Partial<ContactDetail> = {},
): ContactDetail {
  return {
    id: contact.id,
    remote_id: contact.remote_id,
    addressbook_ids: contact.addressbook_ids,
    display_name: contact.display_name,
    full_name: contact.display_name,
    emails: contact.email
      ? [{
        mapKey: `email-${contact.id}`,
        position: 0,
        value: contact.email,
        label: null,
        contexts: [],
        pref: 1,
        isPreferred: true,
      }]
      : [],
    phones: [],
    links: [],
    anniversaries: [],
    notes: [],
    organizations: [],
    titles: [],
    ...overrides,
  };
}

function makeIdentity(index: number, mayDelete: boolean): IdentityRow {
  return {
    id: 100 + index,
    account_id: 1,
    remote_id: `identity-${index}`,
    name: index === 0 ? 'Primary Sender' : 'Alias Sender',
    email: index === 0 ? 'primary@example.com' : 'alias@example.com',
    reply_to_json: null,
    bcc_json: null,
    text_signature: null,
    html_signature: null,
    may_delete: mayDelete ? 1 : 0,
    reply_to: null,
    bcc: null,
    raw_json: JSON.stringify({ mayDelete }),
    updated_at: 1,
  };
}

async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await nextTick();
}

async function mountContacts(options: {
  contacts?: ContactListRow[];
  details?: Map<number, ContactDetail>;
  filterQuery?: string;
  identities?: IdentityRow[];
  width?: number;
} = {}) {
  const rows = options.contacts ?? [];
  const identities = options.identities ?? [];
  const details = options.details ?? new Map(
    rows.map((contact) => [contact.id, makeDetail(contact)]),
  );
  setWindowWidth(options.width ?? 1280);
  const store = useContactsStore();
  store.addressbooks = addressbooks;
  store.contacts = rows;
  store.identities = identities;
  vi.spyOn(store, 'attach').mockResolvedValue();
  vi.spyOn(store, 'listContacts').mockResolvedValue(rows);
  vi.spyOn(store, 'listIdentities').mockResolvedValue(identities);
  vi.spyOn(store, 'getContact').mockImplementation(async (id) =>
    details.get(id) ?? null);
  const wrapper = mount(ContactsView, {
    attachTo: document.body,
    props: { filterQuery: options.filterQuery ?? '' },
  });
  mountedWrappers.push(wrapper);
  await settle();
  return { details, store, wrapper };
}

function option(wrapper: VueWrapper, key: string) {
  return wrapper.get(`[data-entry-key="${key}"]`);
}

function buttonWithText(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button')
    .filter((candidate) =>
      candidate.text().trim() === text
      || candidate.attributes('aria-label') === text)
    .at(-1);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

function buttonContainingText(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button')
    .find((candidate) => candidate.text().includes(text));
  if (!button) throw new Error(`Missing button containing: ${text}`);
  return button;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.removeItem('stormbox.contactsColumnWidths.v1');
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  );
  offsetWidthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth',
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('contacts__list')) return CONTACT_LIST_HEIGHT;
      if (this.classList.contains('contacts__row')) return CONTACT_ROW_HEIGHT;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('contacts__list') ? 360 : 0;
    },
  });
});

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  if (offsetHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor);
  } else {
    delete (HTMLElement.prototype as any).offsetHeight;
  }
  if (offsetWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidthDescriptor);
  } else {
    delete (HTMLElement.prototype as any).offsetWidth;
  }
  vi.restoreAllMocks();
});

describe('ContactsView directory shell', () => {
  it('hides an unselected detail pane and uses a 639px drill-in', async () => {
    const contact = makeContact(0);
    const { wrapper } = await mountContacts({ contacts: [contact] });

    expect(wrapper.attributes('data-layout')).toBe('desktop');
    expect(wrapper.findAll('[data-directory-pane]')).toHaveLength(1);
    expect(wrapper.get('[data-directory-pane]').attributes('data-directory-pane')).toBe('list');
    expect(wrapper.get('.directory-shell').classes()).toContain('directory-shell--detail-hidden');
    expect(wrapper.findComponent({ name: 'ContactsRail' }).exists()).toBe(true);

    setWindowWidth(640);
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(wrapper.attributes('data-layout')).toBe('tablet');
    expect(wrapper.findAll('[data-directory-pane]')).toHaveLength(1);

    setWindowWidth(639);
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(wrapper.attributes('data-layout')).toBe('phone');
    expect(wrapper.get('[data-directory-pane]').attributes('data-directory-pane')).toBe('list');

    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    expect(wrapper.get('[data-directory-pane]').attributes('data-directory-pane')).toBe('detail');
    expect(wrapper.find('.contacts__list').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.contact-detail__display-name').element);

    await wrapper.get('[aria-label="Back"]').trigger('click');
    await settle();
    expect(wrapper.get('[data-directory-pane]').attributes('data-directory-pane')).toBe('list');
    expect(document.activeElement).toBe(wrapper.get('[role="listbox"]').element);

    await wrapper.get('[role="listbox"]').trigger('keydown', { key: 'Enter' });
    await settle();
    expect(wrapper.get('[data-directory-pane]').attributes('data-directory-pane')).toBe('detail');
    expect(document.activeElement).toBe(wrapper.get('.contact-detail__display-name').element);
  });

  it('resizes and persists both desktop directory columns', async () => {
    const contact = makeContact(0);
    const { wrapper } = await mountContacts({ contacts: [contact] });
    await option(wrapper, 'contact:1').trigger('click');
    await settle();

    expect(wrapper.attributes('style')).toContain('--directory-list-width: 388px');

    const railHandle = wrapper.get('[aria-label="Resize address book list"]').element;
    railHandle.dispatchEvent(makePointerEvent('pointerdown', 200));
    window.dispatchEvent(makePointerEvent('pointermove', 260));
    window.dispatchEvent(makePointerEvent('pointerup', 260));
    await nextTick();
    expect(wrapper.attributes('style')).toContain('--contacts-rail-width: 300px');

    const listHandle = wrapper.get('[aria-label="Resize contact list"]').element;
    listHandle.dispatchEvent(makePointerEvent('pointerdown', 300));
    window.dispatchEvent(makePointerEvent('pointermove', 100));
    window.dispatchEvent(makePointerEvent('pointerup', 100));
    await nextTick();
    expect(wrapper.attributes('style')).toContain('--directory-list-width: 280px');
    expect(JSON.parse(
      window.localStorage.getItem('stormbox.contactsColumnWidths.v1') ?? '',
    )).toEqual({ list: 280, rail: 300 });
  });

  it('offers the list resizer on tablet and no resizers on phone', async () => {
    const contact = makeContact(0);
    const { wrapper } = await mountContacts({ contacts: [contact], width: 800 });
    await option(wrapper, 'contact:1').trigger('click');
    await settle();

    expect(wrapper.find('[aria-label="Resize address book list"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Resize contact list"]').exists()).toBe(true);

    setWindowWidth(639);
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(wrapper.find('[aria-label="Resize contact list"]').exists()).toBe(false);
  });

  it('keeps one bounded 10,000-row listbox with list-only row content and keyboard follow', async () => {
    const contacts = Array.from({ length: 10_000 }, (_, index) =>
      makeContact(index, index === 0 ? null : undefined));
    const { wrapper } = await mountContacts({ contacts });
    const list = wrapper.get('[role="listbox"]');
    const rows = wrapper.findAll('[role="option"]');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0].find('input[type="checkbox"]').exists()).toBe(true);
    expect(rows[0].findAll('.directory-list__row-content > span')).toHaveLength(2);
    expect(rows[0].text()).toBe('Person 0000No email address');
    expect(rows[0].find('button').exists()).toBe(false);
    expect(list.attributes('aria-activedescendant')).toContain('contact-1');

    await list.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    expect(list.attributes('aria-activedescendant')).toContain('contact-2');
    await list.trigger('keydown', { key: 'ArrowUp' });
    await nextTick();
    expect(list.attributes('aria-activedescendant')).toContain('contact-1');
    await list.trigger('keydown', { key: 'End' });
    await settle();
    expect(list.attributes('aria-activedescendant')).toContain('contact-10000');
    await list.trigger('keydown', { key: 'Home' });
    await settle();
    expect(list.attributes('aria-activedescendant')).toContain('contact-1');
    await list.trigger('keydown', { key: 'End' });
    await settle();
    expect(wrapper.findAll('[role="option"]').length).toBeLessThan(100);
    await list.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(list.attributes('aria-activedescendant')).toContain('contact-10000');
    expect(wrapper.text()).toContain('Person 9999');

    (list.element as HTMLElement).scrollTop = 50_000;
    await wrapper.setProps({ filterQuery: 'Person 0042' });
    await settle();
    expect((list.element as HTMLElement).scrollTop).toBe(0);
    expect(list.attributes('aria-activedescendant')).toBeUndefined();
    await list.trigger('keydown', { key: 'ArrowDown' });
    await settle();
    expect(list.attributes('aria-activedescendant')).toContain('contact-43');
  });

  it('ignores a stale contact read after a newer selection resolves', async () => {
    const first = makeContact(0);
    const second = makeContact(1);
    let resolveFirst!: (detail: ContactDetail) => void;
    let resolveSecond!: (detail: ContactDetail) => void;
    const firstRead = new Promise<ContactDetail>((resolve) => {
      resolveFirst = resolve;
    });
    const secondRead = new Promise<ContactDetail>((resolve) => {
      resolveSecond = resolve;
    });
    const { store, wrapper } = await mountContacts({ contacts: [first, second] });
    vi.mocked(store.getContact).mockImplementation((id) =>
      id === first.id ? firstRead : secondRead);

    await option(wrapper, 'contact:1').trigger('click');
    await nextTick();
    await option(wrapper, 'contact:2').trigger('click');
    resolveSecond(makeDetail(second, { full_name: 'Newer selection' }));
    await settle();
    resolveFirst(makeDetail(first, { full_name: 'Stale selection' }));
    await settle();

    expect(wrapper.text()).toContain('Newer selection');
    expect(wrapper.text()).not.toContain('Stale selection');
    expect(wrapper.get('[role="option"][aria-selected="true"]').attributes('data-entry-key'))
      .toBe('contact:2');
  });

  it('keeps the detail header mounted while switching contacts', async () => {
    const first = makeContact(0);
    const second = makeContact(1);
    const firstDetail = makeDetail(first);
    const secondDetail = makeDetail(second);
    let resolveSecond!: (detail: ContactDetail) => void;
    const secondRead = new Promise<ContactDetail>((resolve) => {
      resolveSecond = resolve;
    });
    const { store, wrapper } = await mountContacts({
      contacts: [first, second],
    });
    vi.mocked(store.getContact).mockImplementation((id) =>
      id === first.id ? Promise.resolve(firstDetail) : secondRead);

    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    const pane = wrapper.get('.contact-detail').element;
    const header = wrapper.get('.contact-detail__header').element;
    const back = wrapper.get('.contact-detail__header [aria-label="Back"]').element;

    await option(wrapper, 'contact:2').trigger('click');
    await nextTick();
    expect(wrapper.attributes('data-detail-state')).toBe('loading');
    expect(wrapper.get('.contact-detail__loading').text()).toContain('Loading contact');
    expect(wrapper.get('.contact-detail').element).toBe(pane);
    expect(wrapper.get('.contact-detail__header').element).toBe(header);
    expect(wrapper.get('.contact-detail__header [aria-label="Back"]').element).toBe(back);

    resolveSecond(secondDetail);
    await settle();
    expect(wrapper.attributes('data-detail-state')).toBe('view');
    expect(wrapper.get('.contact-detail').element).toBe(pane);
    expect(wrapper.get('.contact-detail__header').element).toBe(header);
    expect(wrapper.get('.contact-detail__header [aria-label="Back"]').element).toBe(back);
  });

  it('exposes each detail mode while reads and mutations settle', async () => {
    const contact = makeContact(0);
    const detail = makeDetail(contact);
    const { store, wrapper } = await mountContacts({ contacts: [contact] });
    let resolveDetail!: (value: ContactDetail) => void;
    vi.mocked(store.getContact).mockImplementation(() => new Promise((resolve) => {
      resolveDetail = resolve;
    }));

    await option(wrapper, 'contact:1').trigger('click');
    await nextTick();
    expect(wrapper.attributes('data-detail-state')).toBe('loading');
    expect(wrapper.get('[role="status"]').text()).toContain('Loading contact');

    resolveDetail(detail);
    await settle();
    expect(wrapper.attributes('data-detail-state')).toBe('view');

    await buttonWithText(wrapper, 'Edit').trigger('click');
    expect(wrapper.attributes('data-detail-state')).toBe('edit');
    const email = wrapper.get('input[aria-label="Email addresses value"]');
    await email.setValue('');
    await wrapper.get('.contact-detail__editor').trigger('submit');
    await nextTick();
    expect(wrapper.attributes('data-detail-state')).toBe('validation-error');

    await email.setValue('restored@example.com');
    vi.spyOn(store, 'updateContact').mockImplementation(async () => {
      store.error = 'Server refused the edit';
      return false;
    });
    await wrapper.get('.contact-detail__editor').trigger('submit');
    await settle();
    expect(wrapper.attributes('data-detail-state')).toBe('save-error');

    await buttonWithText(wrapper, 'Cancel').trigger('click');
    await buttonWithText(wrapper, 'New Contact').trigger('click');
    expect(wrapper.attributes('data-detail-state')).toBe('create');
    await buttonWithText(wrapper, 'Cancel').trigger('click');
    await option(wrapper, 'contact:1').trigger('click');
    await nextTick();
    resolveDetail(detail);
    await settle();

    let resolveDelete!: (value: {
      destroyedContactIds: number[];
      failures: { contactId: number; errorType: string }[];
      ok: boolean;
      succeededContactIds: number[];
      updatedContactIds: number[];
    }) => void;
    vi.spyOn(store, 'deleteContacts').mockImplementation(() => new Promise((resolve) => {
      resolveDelete = resolve;
    }));
    await wrapper.get('.contact-detail__delete').trigger('click');
    await nextTick();
    await wrapper.get('[role="alertdialog"] .contacts-confirm__danger').trigger('click');
    await Promise.resolve();
    await nextTick();
    expect(wrapper.attributes('data-detail-state')).toBe('deleting');
    resolveDelete({
      destroyedContactIds: [],
      failures: [{ contactId: contact.id, errorType: 'serverFail' }],
      ok: false,
      succeededContactIds: [],
      updatedContactIds: [],
    });
    await Promise.resolve();
    await nextTick();
    resolveDetail(detail);
    await settle();
    expect(wrapper.attributes('data-detail-state')).toBe('view');
  });

  it('clears invalid selection for filtering and address-book scope changes', async () => {
    const first = makeContact(0);
    const second = makeContact(1);
    const { wrapper } = await mountContacts({ contacts: [first, second] });

    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    await wrapper.setProps({ filterQuery: 'Person 0001' });
    await settle();
    expect(wrapper.find('[aria-selected="true"]').exists()).toBe(false);
    expect(wrapper.find('[data-directory-pane="detail"]').exists()).toBe(false);

    await wrapper.setProps({ filterQuery: '' });
    await settle();
    await option(wrapper, 'contact:2').trigger('click');
    await settle();
    await buttonContainingText(wrapper, 'Personal').trigger('click');
    await settle();
    expect(wrapper.find('[aria-selected="true"]').exists()).toBe(false);
    expect(wrapper.find('.directory-list__row--selected').exists()).toBe(false);
    expect(wrapper.find('[data-entry-key="contact:2"]').exists()).toBe(false);

    const list = wrapper.get('[role="listbox"]');
    expect(document.activeElement).toBe(list.element);
    expect(wrapper.get('.directory-list__row--active').attributes('data-entry-key'))
      .toBe('contact:1');
  });

  it('reselects next, then previous, after confirmed deletion', async () => {
    const contacts = [makeContact(0), makeContact(1), makeContact(2)];
    const { store, wrapper } = await mountContacts({ contacts });
    vi.spyOn(store, 'deleteContacts').mockImplementation(async (ids) => {
      store.contacts = store.contacts.filter((candidate) => !ids.includes(candidate.id));
      return {
        destroyedContactIds: ids,
        failures: [],
        ok: true,
        succeededContactIds: ids,
        updatedContactIds: [],
      };
    });

    await option(wrapper, 'contact:2').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Delete').trigger('click');
    await buttonWithText(wrapper, 'Delete permanently').trigger('click');
    await settle();
    expect(wrapper.get('[aria-selected="true"]').attributes('data-entry-key'))
      .toBe('contact:3');

    await buttonWithText(wrapper, 'Delete').trigger('click');
    await buttonWithText(wrapper, 'Delete permanently').trigger('click');
    await settle();
    expect(wrapper.get('[aria-selected="true"]').attributes('data-entry-key'))
      .toBe('contact:1');
  });

  it('guards row, scope, identity, filter, and mobile Back navigation', async () => {
    const first = makeContact(0);
    const second = makeContact(1);
    const { wrapper } = await mountContacts({
      contacts: [first, second],
      identities: [makeIdentity(0, false)],
    });
    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Edit').trigger('click');
    await wrapper.get('input[autocomplete="name"]').setValue('Dirty name');

    const guardedNavigations = [
      () => option(wrapper, 'contact:2').trigger('click'),
      () => buttonContainingText(wrapper, 'Personal').trigger('click'),
      () => buttonContainingText(wrapper, 'Manage identities').trigger('click'),
    ];
    for (const [index, navigate] of guardedNavigations.entries()) {
      await navigate();
      await nextTick();
      const dialog = wrapper.get('[role="alertdialog"]');
      expect(dialog.text()).toContain('Save your changes');
      expect(dialog.attributes('aria-labelledby')).toBe('contacts-confirm-title');
      expect(document.activeElement).toBe(dialog.element);
      expect(document.activeElement).not.toBe(buttonWithText(wrapper, 'Cancel').element);
      if (index === 0) {
        const save = buttonWithText(wrapper, 'Save');
        (save.element as HTMLButtonElement).focus();
        await save.trigger('keydown', { key: 'Tab' });
        expect(document.activeElement).toBe(buttonWithText(wrapper, 'Cancel').element);
      }
      await buttonWithText(wrapper, 'Cancel').trigger('click');
      await nextTick();
      expect(wrapper.get('[aria-selected="true"]').attributes('data-entry-key'))
        .toBe('contact:1');
    }

    const filterRequest = (wrapper.vm as any).requestFilterChange('no match');
    await nextTick();
    await buttonWithText(wrapper, 'Cancel').trigger('click');
    expect(await filterRequest).toBe(false);

    setWindowWidth(639);
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    await wrapper.get('[aria-label="Back"]').trigger('click');
    await nextTick();
    await buttonWithText(wrapper, 'Cancel').trigger('click');
    expect(wrapper.get('[data-directory-pane]').attributes('data-directory-pane')).toBe('detail');

    await wrapper.get('[aria-label="Back"]').trigger('click');
    await nextTick();
    await buttonWithText(wrapper, 'Discard').trigger('click');
    await settle();
    expect(wrapper.get('[data-directory-pane]').attributes('data-directory-pane')).toBe('list');
  });

  it('saves dirty edits before completing the pending row selection', async () => {
    const first = makeContact(0);
    const second = makeContact(1);
    const details = new Map([
      [first.id, makeDetail(first)],
      [second.id, makeDetail(second)],
    ]);
    const { store, wrapper } = await mountContacts({
      contacts: [first, second],
      details,
    });
    let resolveSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    vi.spyOn(store, 'updateContact').mockImplementation(async (input) => {
      await savePending;
      if (!('contactId' in input)) return false;
      const { contactId, contact } = input;
      details.set(contactId, {
        ...details.get(contactId)!,
        full_name: contact.fullName,
        display_name: contact.fullName,
      });
      return true;
    });

    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Edit').trigger('click');
    await wrapper.get('input[autocomplete="name"]').setValue('Saved first');
    await option(wrapper, 'contact:2').trigger('click');
    await nextTick();
    wrapper.get('[role="alertdialog"]').element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));
    await nextTick();
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Saving…');
    resolveSave();
    await settle();

    expect(store.updateContact).toHaveBeenCalled();
    expect(wrapper.get('[aria-selected="true"]').attributes('data-entry-key'))
      .toBe('contact:2');
  });

  it('focuses contact detail after a direct successful save', async () => {
    const contact = makeContact(0);
    const details = new Map([[contact.id, makeDetail(contact)]]);
    const { store, wrapper } = await mountContacts({
      contacts: [contact],
      details,
    });
    vi.spyOn(store, 'updateContact').mockImplementation(async (input) => {
      if (!('contactId' in input)) return false;
      details.set(contact.id, {
        ...details.get(contact.id)!,
        full_name: input.contact.fullName,
        display_name: input.contact.fullName,
      });
      return true;
    });
    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Edit').trigger('click');
    await wrapper.get('input[autocomplete="name"]').setValue('Saved contact');
    await wrapper.get('.contact-detail__editor').trigger('submit');
    await settle();

    expect(document.activeElement).toBe(wrapper.get('.contact-detail__display-name').element);
  });

  it('keeps a dirty draft when background sync removes its row', async () => {
    const first = makeContact(0);
    const { store, wrapper } = await mountContacts({ contacts: [first] });
    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Edit').trigger('click');
    const name = wrapper.get('input[autocomplete="name"]');
    await name.setValue('Unsaved local draft');

    store.saving = true;
    store.contacts = [];
    await nextTick();
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    store.saving = false;
    await nextTick();
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('changed elsewhere');
    await buttonWithText(wrapper, 'Cancel').trigger('click');
    await nextTick();
    expect(wrapper.get('input[autocomplete="name"]').element)
      .toHaveProperty('value', 'Unsaved local draft');
    expect(wrapper.find('.contact-detail__editor').exists()).toBe(true);
    store.error = 'Editor save failed';
    await nextTick();
    expect(wrapper.find('.directory-list [role="alert"]').exists()).toBe(false);

    store.contacts = [first];
    await nextTick();
    store.contacts = [];
    await nextTick();
    await buttonWithText(wrapper, 'Discard').trigger('click');
    await settle();
    expect(wrapper.find('.contact-detail__editor').exists()).toBe(false);
    expect(wrapper.find('[data-directory-pane="detail"]').exists()).toBe(false);
  });

  it('keeps basic identity create/edit/delete in the shared detail pane', async () => {
    const primary = makeIdentity(0, false);
    const alias = makeIdentity(1, true);
    const { store, wrapper } = await mountContacts({
      identities: [primary, alias],
    });
    vi.spyOn(store, 'createIdentity').mockImplementation(async (input) => {
      const created = {
        ...makeIdentity(2, true),
        name: input.name ?? '',
        email: input.email,
      };
      store.identities = [...store.identities, created];
      return { ok: true, identity: created };
    });
    vi.spyOn(store, 'updateIdentity').mockImplementation(async (input) => {
      store.identities = store.identities.map((identity) =>
        identity.remote_id === input.remoteId
          ? { ...identity, name: input.name ?? null }
          : identity);
      return {
        ok: true,
        identity: store.identities.find((identity) =>
          identity.remote_id === input.remoteId)!,
      };
    });
    vi.spyOn(store, 'deleteIdentity').mockImplementation(async (identity) => {
      store.identities = store.identities.filter((candidate) =>
        candidate.id !== identity.id);
      return { ok: true };
    });

    await buttonContainingText(wrapper, 'Manage identities').trigger('click');
    await settle();
    await option(wrapper, 'identity:100').trigger('click');
    await settle();
    expect(buttonWithText(wrapper, 'Delete').attributes('disabled')).toBeDefined();

    await option(wrapper, 'identity:101').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Edit').trigger('click');
    expect(wrapper.get('input[type="email"]').attributes('readonly')).toBeDefined();
    await wrapper.get('input[autocomplete="name"]').setValue('Renamed Alias');
    await wrapper.get('.identity-detail__editor').trigger('submit');
    await settle();
    expect(store.updateIdentity).toHaveBeenCalledWith(expect.objectContaining({
      remoteId: alias.remote_id,
      name: 'Renamed Alias',
      operationId: expect.any(String),
    }));
    expect(wrapper.text()).toContain('Renamed Alias');
    expect(document.activeElement).toBe(wrapper.get('.identity-detail__display-name').element);

    await buttonWithText(wrapper, 'Delete').trigger('click');
    await buttonWithText(wrapper, 'Delete').trigger('click');
    await settle();
    expect(wrapper.get('[aria-selected="true"]').attributes('data-entry-key'))
      .toBe('identity:100');

    await buttonWithText(wrapper, 'Add identity').trigger('click');
    await wrapper.get('input[autocomplete="name"]').setValue('New Alias');
    await wrapper.get('input[type="email"]').setValue('new@example.com');
    await wrapper.get('.identity-detail__editor').trigger('submit');
    await settle();
    expect(store.createIdentity).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Alias',
      email: 'new@example.com',
      operationId: expect.any(String),
    }));
    expect(wrapper.get('[aria-selected="true"]').attributes('data-entry-key'))
      .toBe('identity:102');
  });

  it('supports contact-only range and keyboard selection while hiding detail', async () => {
    const contacts = [makeContact(0), makeContact(1), makeContact(2)];
    const { wrapper } = await mountContacts({ contacts });

    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    expect(wrapper.find('[data-directory-pane="detail"]').exists()).toBe(true);

    await option(wrapper, 'contact:1').get('input[type="checkbox"]').trigger('click');
    await settle();
    expect(wrapper.text()).toContain('1 selected');
    expect(wrapper.find('[data-directory-pane="detail"]').exists()).toBe(false);

    await option(wrapper, 'contact:2').get('input[type="checkbox"]')
      .trigger('click', { shiftKey: true });
    await settle();
    expect(wrapper.text()).toContain('2 selected');

    await wrapper.get('[role="listbox"]').trigger('keydown', {
      key: 'a',
      ctrlKey: true,
    });
    await settle();
    expect(wrapper.text()).toContain('3 selected');

    await wrapper.get('[role="listbox"]').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(wrapper.text()).not.toContain('selected');
    expect(wrapper.find('[data-directory-pane="detail"]').exists()).toBe(true);

    await buttonContainingText(wrapper, 'Manage identities').trigger('click');
    await settle();
    expect(wrapper.find('.directory-list__checkbox').exists()).toBe(false);
    expect(wrapper.find('.selectable-list-header__select-all').exists()).toBe(false);
  });

  it('guards a dirty editor before checkbox selection hides it', async () => {
    const contact = makeContact(0);
    const { wrapper } = await mountContacts({ contacts: [contact] });
    await option(wrapper, 'contact:1').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Edit').trigger('click');
    await wrapper.get('input[autocomplete="name"]').setValue('Unsaved name');

    await option(wrapper, 'contact:1').get('input[type="checkbox"]').trigger('click');
    await nextTick();
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Save your changes');
    await buttonWithText(wrapper, 'Cancel').trigger('click');
    await settle();

    expect(wrapper.text()).not.toContain('1 selected');
    expect(wrapper.attributes('data-detail-state')).toBe('edit');
    expect(wrapper.find('[data-directory-pane="detail"]').exists()).toBe(true);
  });

  it('confirms all-contact deletion as permanent across every address book', async () => {
    const contact = {
      ...makeContact(0),
      addressbook_ids: [1, 2],
    };
    const { store, wrapper } = await mountContacts({ contacts: [contact] });
    const deletion = vi.spyOn(store, 'deleteContacts').mockResolvedValue({
      ok: true,
      destroyedContactIds: [contact.id],
      failures: [],
      succeededContactIds: [contact.id],
      updatedContactIds: [],
    });

    await option(wrapper, 'contact:1').get('input[type="checkbox"]').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Delete').trigger('click');
    await nextTick();
    const dialog = wrapper.get('[role="alertdialog"]');
    expect(dialog.text()).toContain('Permanently delete this contact');
    expect(dialog.text()).toContain('from all address books');
    dialog.element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));
    await settle();
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(deletion).not.toHaveBeenCalled();

    await buttonWithText(wrapper, 'Delete').trigger('click');
    await nextTick();
    await buttonWithText(wrapper, 'Delete permanently').trigger('click');
    await settle();

    expect(deletion).toHaveBeenCalledWith([contact.id], null);
  });

  it('moves from a concrete book and reports scoped final deletions precisely', async () => {
    const first = { ...makeContact(0), addressbook_ids: [1] };
    const second = { ...makeContact(1), addressbook_ids: [1, 2] };
    const { store, wrapper } = await mountContacts({ contacts: [first, second] });
    const move = vi.spyOn(store, 'moveContacts').mockResolvedValue({
      ok: true,
      destroyedContactIds: [],
      failures: [],
      succeededContactIds: [first.id],
      updatedContactIds: [first.id],
    });
    const remove = vi.spyOn(store, 'deleteContacts').mockResolvedValue({
      ok: true,
      destroyedContactIds: [first.id],
      failures: [],
      succeededContactIds: [first.id, second.id],
      updatedContactIds: [second.id],
    });

    await buttonContainingText(wrapper, 'Personal').trigger('click');
    await settle();
    await option(wrapper, 'contact:1').get('input[type="checkbox"]').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Move').trigger('click');
    await buttonWithText(wrapper, 'Team').trigger('click');
    await settle();
    expect(move).toHaveBeenCalledWith([first.id], 1, 2);

    await option(wrapper, 'contact:1').get('input[type="checkbox"]').trigger('click');
    await option(wrapper, 'contact:2').get('input[type="checkbox"]').trigger('click');
    await settle();
    await buttonWithText(wrapper, 'Delete').trigger('click');
    await nextTick();
    const dialog = wrapper.get('[role="alertdialog"]');
    expect(dialog.text()).toContain('removed from Personal');
    expect(dialog.text()).toContain(
      '1 selected contact currently has no other address-book membership',
    );
    await buttonWithText(wrapper, 'Delete').trigger('click');
    await settle();
    expect(remove).toHaveBeenCalledWith([first.id, second.id], 1);
  });
});
