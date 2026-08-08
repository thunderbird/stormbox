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
import type { ContactListRow } from '../../../src/types';

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
});
