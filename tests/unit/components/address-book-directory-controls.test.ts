// @vitest-environment happy-dom

import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import ContactsRail from '../../../src/components/contacts/ContactsRail.vue';
import DirectoryList from '../../../src/components/contacts/DirectoryList.vue';
import { contactEntry } from '../../../src/components/contacts/directory-types';
import { SERVICE_KIND } from '../../../src/constants/states';
import type {
  AddressbookRow,
  ContactListRow,
} from '../../../src/types';

function addressbook(
  id: number,
  overrides: Partial<AddressbookRow> = {},
): AddressbookRow {
  return {
    id,
    account_id: 1,
    service_kind: SERVICE_KIND.JMAP_CONTACTS,
    remote_id: `book-${id}`,
    name: `Book ${id}`,
    description: null,
    sort_order: id,
    is_default: 0,
    is_subscribed: 1,
    may_write: 1,
    may_delete: 1,
    ctag: null,
    sync_token: null,
    raw_json: null,
    is_deleted: 0,
    updated_at: 1,
    ...overrides,
  };
}

function contact(id: number, addressbookId: number): ContactListRow {
  return {
    id,
    remote_id: `contact-${id}`,
    addressbook_ids: [addressbookId],
    display_name: `Contact ${id}`,
    email: `contact-${id}@example.com`,
  };
}

function railProps(addressbooks: AddressbookRow[]) {
  return {
    addressbooks,
    bookCounts: new Map(addressbooks.map((book) => [book.id, 0])),
    canCreateAddressBook: true,
    contactCount: 0,
    identityCount: 0,
    trashCount: 0,
    kind: 'contacts' as const,
    selectedBookId: null,
  };
}

function listProps(
  addressbooks: AddressbookRow[],
  sourceAddressbookId: number | null,
  selectedContactIds = new Set<number>(),
) {
  const rows = sourceAddressbookId == null
    ? []
    : [contactEntry(contact(1, sourceAddressbookId))];
  return {
    addLabel: 'Add contact',
    addressbooks,
    emptyMessage: 'Empty',
    entries: rows,
    listKind: 'contacts' as const,
    resetToken: 'one',
    selectedContactIds,
    selectedKey: rows[0]?.key ?? null,
    sourceAddressbookId,
    title: sourceAddressbookId == null
      ? 'All contacts'
      : addressbooks.find((book) => book.id === sourceAddressbookId)?.name ?? '',
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('address book directory controls', () => {
  it('orders the capability-gated create control before New Contact', async () => {
    const wrapper = mount(ContactsRail, {
      props: railProps([addressbook(1)]),
    });
    const headerButtons = wrapper.get('.contacts-rail__header').findAll('button');

    expect(headerButtons.map((button) =>
      button.attributes('aria-label') || button.text().trim()))
      .toEqual(['Create address book', 'New Contact']);
    expect(headerButtons[0].attributes('title')).toBe('Create address book');
    expect(headerButtons[0].attributes('disabled')).toBeUndefined();

    await wrapper.setProps({
      canCreateAddressBook: false,
      kind: 'trash',
    });
    expect(wrapper.get('[aria-label="Create address book"]').attributes('disabled'))
      .toBeDefined();
    expect(wrapper.get('.contacts-rail__create').attributes('disabled')).toBeDefined();
  });

  it('shows real names with a separate Personal state', () => {
    const wrapper = mount(ContactsRail, {
      props: railProps([
        addressbook(1, {
          name: 'Server Default',
          is_default: 1,
        }),
        addressbook(2, {
          name: 'Remote Archive',
          is_subscribed: 0,
        }),
      ]),
    });
    const books = wrapper.findAll('.contacts-rail__book')
      .filter((book) => book.find('.contacts-rail__book-label').exists());

    expect(books[0].get('.contacts-rail__name').text()).toBe('Server Default');
    expect(books[0].get('.contacts-rail__badge').text()).toBe('Personal');
    expect(books[1].get('.contacts-rail__name').text()).toBe('Remote Archive');
    expect(wrapper.find('.contacts-rail__status').exists()).toBe(false);
  });

  it('places concrete-book actions after selection and hides them during bulk mode', async () => {
    const books = [
      addressbook(1, { name: 'Server Default', is_default: 1 }),
      addressbook(2, { name: 'Team' }),
    ];
    const wrapper = mount(DirectoryList, {
      props: listProps(books, 1),
    });
    const header = wrapper.get('.directory-list__header');
    const selectAll = header.get('.selectable-list-header__select-all').element;
    const edit = header.get('[aria-label="Edit address book"]');
    const remove = header.get('[aria-label="Delete address book"]');

    expect(
      selectAll.compareDocumentPosition(edit.element)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(header.get('h2').text()).toBe('Server Default');
    expect(header.get('.directory-list__normal-header').classes())
      .toContain('directory-list__normal-header--addressbook');
    expect(remove.attributes('disabled')).toBeUndefined();

    await wrapper.setProps({ selectedContactIds: new Set([1]) });
    expect(header.find('[aria-label="Edit address book"]').exists()).toBe(false);
    expect(header.find('[aria-label="Delete address book"]').exists()).toBe(false);
  });

  it('uses specific edit and delete disabled reasons', async () => {
    const denied = addressbook(1, {
      name: 'Read only',
      may_write: 0,
      may_delete: 0,
    });
    const other = addressbook(2);
    const wrapper = mount(DirectoryList, {
      props: listProps([denied, other], denied.id),
    });

    expect(wrapper.get('[aria-label="Edit address book"]').attributes('disabled'))
      .toBeDefined();
    expect(wrapper.get('[aria-label="Edit address book"]').attributes('title'))
      .toContain('permission');
    expect(wrapper.get('[aria-label="Delete address book"]').attributes('title'))
      .toContain('permission');

    const trusted = addressbook(3, { name: 'Trusted Senders' });
    await wrapper.setProps({
      addressbooks: [trusted, other],
      sourceAddressbookId: trusted.id,
      title: trusted.name,
    });
    expect(wrapper.get('[aria-label="Delete address book"]').attributes('title'))
      .toContain('Trusted Senders');

    await wrapper.setProps({
      addressbooks: [other, trusted],
      sourceAddressbookId: other.id,
      title: other.name,
    });
    expect(wrapper.get('[aria-label="Delete address book"]').attributes('title'))
      .toContain('final non-Trusted-Senders');

    await wrapper.setProps({
      addressbooks: [other],
      sourceAddressbookId: null,
      title: 'All contacts',
    });
    expect(wrapper.find('[aria-label="Edit address book"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Delete address book"]').exists()).toBe(false);
    expect(wrapper.get('.directory-list__normal-header').classes())
      .toContain('directory-list__normal-header--addressbook');
  });
});
