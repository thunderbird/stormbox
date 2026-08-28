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

import ContactsView from '../../../src/components/ContactsView.vue';
import { useContactsStore } from '../../../src/stores/contacts-store';
import type { ContactListRow, IdentityRow } from '../../../src/types';

const CONTACT_ROW_HEIGHT = 51;
const CONTACT_LIST_HEIGHT = 510;
const mountedWrappers = [];
let offsetHeightDescriptor: PropertyDescriptor | undefined;
let offsetWidthDescriptor: PropertyDescriptor | undefined;

function makeContact(index: number): ContactListRow {
  const suffix = String(index).padStart(4, '0');
  return {
    id: index + 1,
    remote_id: `contact-${index + 1}`,
    addressbook_ids: [index % 2 === 0 ? 1 : 2],
    display_name: `Person ${suffix}`,
    organization: index % 3 === 0 ? `Organization ${suffix}` : null,
    email: `person${suffix}@example.com`,
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
    raw_json: JSON.stringify({ mayDelete }),
    updated_at: 1,
  };
}

function mountContacts(contacts: ContactListRow[], filterQuery = '') {
  const store = useContactsStore();
  store.contacts = contacts;
  vi.spyOn(store, 'attach').mockResolvedValue();
  vi.spyOn(store, 'listContacts').mockResolvedValue(contacts);

  const wrapper = mount(ContactsView, {
    attachTo: document.body,
    props: { filterQuery },
  });
  mountedWrappers.push(wrapper);
  return { store, wrapper };
}

async function settleVirtualizer() {
  await flushPromises();
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  );
  offsetWidthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth',
  );

  // These dimensions give the real virtualizer a finite viewport and
  // preserve the row height established by the component's CSS.
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
      return this.classList.contains('contacts__list') ? 800 : 0;
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

describe('ContactsView', () => {
  it('mounts a bounded window for a large contact list', async () => {
    const contacts = Array.from({ length: 3_000 }, (_, index) => makeContact(index));
    const { wrapper } = mountContacts(contacts);
    await settleVirtualizer();

    const list = wrapper.get('.contacts__list');
    const rows = wrapper.findAll('.contacts__row');
    const totalHeight = Number.parseFloat(
      (wrapper.get('.contacts__list-spacer').element as HTMLElement).style.height,
    );

    expect(list.attributes('role')).toBe('list');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows.every((row) => row.attributes('role') === 'listitem')).toBe(true);
    expect(rows[0].attributes('aria-setsize')).toBe('3000');
    expect(totalHeight).toBeGreaterThan(CONTACT_LIST_HEIGHT);
  });

  it('narrows and widens the filtered virtual window from the top', async () => {
    const contacts = Array.from({ length: 3_000 }, (_, index) => makeContact(index));
    const { wrapper } = mountContacts(contacts);
    await settleVirtualizer();

    const list = wrapper.get('.contacts__list');
    (list.element as HTMLElement).scrollTop = 10_000;
    await list.trigger('scroll');

    await wrapper.setProps({ filterQuery: '  PERSON 2999  ' });
    await settleVirtualizer();

    expect(wrapper.findAll('.contacts__row')).toHaveLength(1);
    expect(wrapper.get('.contacts__row').text()).toContain('Person 2999');
    expect((wrapper.get('.contacts__list').element as HTMLElement).scrollTop).toBe(0);

    await wrapper.setProps({ filterQuery: 'person 2' });
    await settleVirtualizer();

    const widenedRows = wrapper.findAll('.contacts__row');
    expect(widenedRows.length).toBeGreaterThan(1);
    expect(widenedRows.length).toBeLessThan(100);
    expect(widenedRows.every((row) => row.text().includes('Person 2'))).toBe(true);
  });

  it('renders both empty-list messages', async () => {
    const { store, wrapper } = mountContacts([]);
    await settleVirtualizer();

    expect(wrapper.get('.contacts__empty').text()).toBe('No contacts yet.');
    expect(wrapper.find('.contacts__list').exists()).toBe(false);

    store.contacts = [makeContact(0)];
    await wrapper.setProps({ filterQuery: 'no such contact' });
    await settleVirtualizer();

    expect(wrapper.get('.contacts__empty').text()).toBe('No matches.');
    expect(wrapper.find('.contacts__list').exists()).toBe(false);
  });

  it('keeps rendered-row edit and remove actions accessible and working', async () => {
    const contact = {
      ...makeContact(0),
      display_name: 'Ada Lovelace',
      email: 'ada@example.com',
    };
    const { store, wrapper } = mountContacts([contact]);
    const getContact = vi.spyOn(store, 'getContact').mockResolvedValue({
      id: contact.id,
      remote_id: contact.remote_id,
      addressbook_ids: contact.addressbook_ids,
      display_name: contact.display_name,
      full_name: contact.display_name,
      organization: contact.organization,
      emails: [{
        email: contact.email!,
        label: null,
        is_preferred: 1,
        position: 0,
      }],
    });
    const deleteContact = vi.spyOn(store, 'deleteContact').mockResolvedValue(true);
    await settleVirtualizer();

    const edit = wrapper.get('button[aria-label="Edit Ada Lovelace"]');
    const remove = wrapper.get('button[aria-label="Remove Ada Lovelace"]');
    expect((edit.element as HTMLButtonElement).tabIndex).toBe(0);
    expect((remove.element as HTMLButtonElement).tabIndex).toBe(0);

    await edit.trigger('click');
    await flushPromises();
    expect(getContact).toHaveBeenCalledWith(contact.id);
    expect((wrapper.get('.contacts__input').element as HTMLInputElement).value)
      .toBe('Ada Lovelace');

    await remove.trigger('click');
    await flushPromises();
    expect(deleteContact).toHaveBeenCalledWith(contact);
  });

  it('loads identities through the contact list when the rail button is activated', async () => {
    const { store, wrapper } = mountContacts([makeContact(0)]);
    const identityList = [makeIdentity(0, false), makeIdentity(1, true)];
    store.identities = identityList;
    const listIdentities = vi.spyOn(store, 'listIdentities')
      .mockResolvedValue(identityList);

    const manageIdentityButton = wrapper.findAll('button')
      .find((button) => button.text().includes('Manage identities'))!;
    expect(manageIdentityButton.exists()).toBe(true);
    expect(wrapper.get('.contacts__rail').element.lastElementChild)
      .toBe(wrapper.get('.contacts__identity-section').element);

    await manageIdentityButton.trigger('click');
    await settleVirtualizer();

    expect(listIdentities).toHaveBeenCalledWith({ refreshServer: true });
    expect(wrapper.get('.contacts__header h2').text()).toBe('Identities');
    expect(wrapper.get('.contacts__add').text()).toContain('Add identity');
    expect(wrapper.get('.contacts__list').attributes('role')).toBe('list');
    expect(wrapper.findAll('.contacts__row').map((row) => row.text()))
      .toEqual([
        expect.stringContaining('Primary Sender'),
        expect.stringContaining('Alias Sender'),
      ]);

    await wrapper.setProps({ filterQuery: 'alias@example.com' });
    await settleVirtualizer();
    expect(wrapper.findAll('.contacts__row')).toHaveLength(1);
    expect(wrapper.get('.contacts__row').text()).toContain('Alias Sender');
  });

  it('creates, edits, and removes identities while protecting non-deletable rows', async () => {
    const { store, wrapper } = mountContacts([]);
    const primary = makeIdentity(0, false);
    const alias = makeIdentity(1, true);
    store.identities = [primary, alias];
    vi.spyOn(store, 'listIdentities').mockResolvedValue(store.identities);
    const createIdentity = vi.spyOn(store, 'createIdentity').mockResolvedValue({ ok: true });
    const updateIdentity = vi.spyOn(store, 'updateIdentity').mockResolvedValue({ ok: true });
    const deleteIdentity = vi.spyOn(store, 'deleteIdentity').mockResolvedValue({ ok: true });

    await wrapper.findAll('button')
      .find((button) => button.text().includes('Manage identities'))!
      .trigger('click');
    await settleVirtualizer();

    const protectedRemove = wrapper.get('button[aria-label="Primary Sender cannot be removed"]');
    expect(protectedRemove.attributes('disabled')).toBeDefined();

    await wrapper.get('.contacts__add').trigger('click');
    await wrapper.get('input[type="text"]').setValue('New Alias');
    await wrapper.get('input[type="email"]').setValue('new-alias@example.com');
    await wrapper.get('.contacts__form').trigger('submit');
    await flushPromises();
    expect(createIdentity).toHaveBeenCalledWith({
      name: 'New Alias',
      email: 'new-alias@example.com',
    });

    const editAlias = wrapper.get('button[aria-label="Edit Alias Sender"]');
    await editAlias.trigger('click');
    expect(wrapper.get('input[type="email"]').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('.contacts__field-label').map((label) => label.text()))
      .toContain('Email (cannot be changed)');
    await wrapper.get('input[type="text"]').setValue('Renamed Alias');
    await wrapper.get('.contacts__form').trigger('submit');
    await flushPromises();
    expect(updateIdentity).toHaveBeenCalledWith({
      remoteId: alias.remote_id,
      name: 'Renamed Alias',
    });

    await wrapper.get('button[aria-label="Remove Alias Sender"]').trigger('click');
    await flushPromises();
    expect(deleteIdentity).toHaveBeenCalledWith(alias);
  });
});
