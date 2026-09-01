// @vitest-environment happy-dom

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  flushPromises,
  mount,
} from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import AddressBookDetailPane from '../../../src/components/contacts/AddressBookDetailPane.vue';
import { ADDRESSBOOK_ERROR } from '../../../src/constants/addressbook-errors';
import { SERVICE_KIND } from '../../../src/constants/states';
import { useContactsStore } from '../../../src/stores/contacts-store';
import type { AddressbookRow } from '../../../src/types';

function addressbook(
  overrides: Partial<AddressbookRow> = {},
): AddressbookRow {
  return {
    id: 1,
    account_id: 1,
    service_kind: SERVICE_KIND.JMAP_CONTACTS,
    remote_id: 'book-1',
    name: 'Server Default',
    description: 'Synced description',
    sort_order: 0,
    is_default: 1,
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

async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('AddressBookDetailPane', () => {
  it('validates the required name, tracks dirty state, and saves create options', async () => {
    const store = useContactsStore();
    const created = addressbook({
      id: 3,
      remote_id: 'book-3',
      name: 'Projects',
      description: 'Client work',
      is_default: 0,
    });
    const create = vi.spyOn(store, 'createAddressBook')
      .mockResolvedValue({ ok: true, addressbook: created });
    const wrapper = mount(AddressBookDetailPane, {
      attachTo: document.body,
      props: {
        addressbook: null,
        mode: 'create',
      },
    });
    expect(wrapper.find('[data-address-book-subscription]').exists()).toBe(false);

    await wrapper.get('form').trigger('submit');
    await nextTick();
    expect(wrapper.get('[role="alert"]').text()).toContain('Enter an address book name');
    expect(create).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(wrapper.get('input[type="text"]').element);

    await wrapper.get('input[type="text"]').setValue('Projects');
    await wrapper.get('textarea').setValue('Client work');
    await wrapper.get('input[type="checkbox"]').setValue(true);

    await wrapper.get('form').trigger('submit');
    await settle();

    expect(create).toHaveBeenCalledWith({
      name: 'Projects',
      description: 'Client work',
      setAsDefault: true,
    });
    expect(wrapper.emitted('dirtyChange')?.some(([dirty]) => dirty === true))
      .toBe(true);
    expect(wrapper.emitted('saved')?.at(-1)).toEqual([created]);
    wrapper.unmount();
  });

  it('disables the already-default control and saves metadata changes', async () => {
    const store = useContactsStore();
    const original = addressbook();
    const updated = {
      ...original,
      description: 'Updated description',
    };
    const update = vi.spyOn(store, 'updateAddressBook')
      .mockResolvedValue({ ok: true, addressbook: updated });
    const wrapper = mount(AddressBookDetailPane, {
      props: {
        addressbook: original,
        mode: 'edit',
      },
    });
    const defaultControl = wrapper.get('input[type="checkbox"]');

    expect((defaultControl.element as HTMLInputElement).checked).toBe(true);
    expect(defaultControl.attributes('disabled')).toBeDefined();
    await wrapper.get('textarea').setValue('Updated description');
    await wrapper.get('form').trigger('submit');
    await settle();

    expect(update).toHaveBeenCalledWith({
      addressbookId: original.id,
      description: 'Updated description',
    });
    expect(wrapper.emitted('saved')?.at(-1)).toEqual([updated]);
  });

  it('renders a structured store failure when no message was supplied', async () => {
    const store = useContactsStore();
    vi.spyOn(store, 'updateAddressBook').mockResolvedValue({
      ok: false,
      error: ADDRESSBOOK_ERROR.PERMISSION_DENIED,
    });
    const wrapper = mount(AddressBookDetailPane, {
      props: {
        addressbook: addressbook(),
        mode: 'edit',
      },
    });

    await wrapper.get('textarea').setValue('Changed');
    await wrapper.get('form').trigger('submit');
    await settle();

    expect(wrapper.get('.address-book-detail__error').text())
      .toContain('don’t have permission');
    expect(wrapper.emitted('stateChange')?.at(-1)).toEqual(['save-error']);

    await wrapper.get('textarea').setValue('Changed again');
    await nextTick();

    expect(wrapper.find('.address-book-detail__error').exists()).toBe(false);
    expect(wrapper.emitted('stateChange')?.at(-1)).toEqual([null]);
  });
});
