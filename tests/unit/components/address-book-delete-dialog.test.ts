// @vitest-environment happy-dom

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

import AddressBookDeleteDialog from '../../../src/components/contacts/AddressBookDeleteDialog.vue';
import { SERVICE_KIND } from '../../../src/constants/states';
import type {
  AddressBookInventory,
  AddressbookRow,
} from '../../../src/types';

const wrappers: VueWrapper[] = [];

function addressbook(): AddressbookRow {
  return {
    id: 1,
    account_id: 1,
    service_kind: SERVICE_KIND.JMAP_CONTACTS,
    remote_id: 'book-1',
    name: 'Server Default',
    description: null,
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
  };
}

function inventory(): AddressBookInventory {
  return {
    version: 1,
    addressbookId: 1,
    addressBookRemoteId: 'book-1',
    queryState: 'state-1',
    total: 5,
    exclusiveCount: 2,
    sharedCount: 3,
    mediaBearingCount: 1,
    contacts: [],
  };
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('AddressBookDeleteDialog', () => {
  it('describes every deletion consequence and defaults Enter to Cancel', async () => {
    const wrapper = mount(AddressBookDeleteDialog, {
      attachTo: document.body,
      props: {
        addressbook: addressbook(),
        inventory: inventory(),
      },
    });
    wrappers.push(wrapper);
    await nextTick();
    const dialog = wrapper.get('[role="alertdialog"]');

    expect(document.activeElement).toBe(dialog.element);
    expect(dialog.text()).toContain('“Server Default” will be deleted');
    expect(dialog.text()).toContain('2 contacts belong only');
    expect(dialog.text()).toContain('permanently destroyed');
    expect(dialog.text()).toContain('3 contacts have other address-book memberships');
    expect(dialog.text()).toContain('Only their memberships');
    expect(dialog.text()).toContain('1 contact includes photos or other media');
    expect(dialog.text()).toContain('server will choose a replacement default');

    await dialog.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });

  it('presents refreshed counts as an explicit reconfirmation', async () => {
    const wrapper = mount(AddressBookDeleteDialog, {
      props: {
        addressbook: addressbook(),
        inventory: inventory(),
        stale: true,
      },
    });
    wrappers.push(wrapper);

    expect(wrapper.text()).toContain('Address book contents changed');
    expect(wrapper.get('[role="status"]').text()).toContain('updated counts');
    expect(wrapper.findAll('button').map((button) => button.text().trim()))
      .toEqual(['Cancel', 'Confirm delete']);

    await wrapper.setProps({ busy: true });
    expect(wrapper.findAll('button').every((button) =>
      button.attributes('disabled') !== undefined)).toBe(true);
  });
});
