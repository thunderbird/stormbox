// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import FolderCreateDialog from '../../../src/components/FolderCreateDialog.vue';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';

function makeFolder(id, overrides = {}) {
  return {
    id,
    account_id: 1,
    remote_id: `mb-${id}`,
    name: `Folder ${id}`,
    role: null,
    sort_order: 0,
    parent_id: null,
    is_deleted: 0,
    is_subscribed: 1,
    total_emails: 0,
    unread_emails: 0,
    rights_json: null,
    ...overrides,
  } as any;
}

function seed(mailStore) {
  useAuthStore().accountId = 1;
  mailStore.accounts = [
    { id: 1, is_primary: 1, is_personal: 1, display_name: 'me@example.org', server_origin: 'o' },
    { id: 2, is_primary: 0, is_personal: 0, display_name: 'other@example.org', server_origin: 'o' },
  ] as any;
  mailStore.folders = [
    makeFolder(1, { name: 'Inbox', role: 'inbox' }),
    makeFolder(10, { name: 'Projects' }),
    // Shared folders: only the one granting mayCreateChild is a
    // legal parent (RFC 9670); shared accounts get no top-level option.
    makeFolder(30, {
      account_id: 2,
      name: 'TeamOpen',
      rights_json: JSON.stringify({ mayCreateChild: true }),
    }),
    makeFolder(31, {
      account_id: 2,
      name: 'TeamLocked',
      rights_json: JSON.stringify({ mayCreateChild: false }),
    }),
  ];
}

function mountDialog() {
  return mount(FolderCreateDialog, {
    global: { stubs: { teleport: true } },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('FolderCreateDialog', () => {
  it('offers top level plus own folders and only shared folders with mayCreateChild', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    const labels = wrapper.find('[data-folder-create-parent]')
      .findAll('option')
      .map((o) => o.text().replaceAll('\u00a0', ''));
    expect(labels).toContain('Top Level');
    expect(labels).toContain('Inbox');
    expect(labels).toContain('Projects');
    expect(labels).toContain('TeamOpen');
    expect(labels).not.toContain('TeamLocked');
    // Exactly one root option — none for the shared account.
    expect(labels.filter((l) => l === 'Top Level')).toHaveLength(1);
  });

  it('submits the trimmed name and selected parent, closing on success', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.createFolder = vi.fn(async () => ({ ok: true }));

    const wrapper = mountDialog();
    await nextTick();

    await wrapper.find('[data-folder-create-name]').setValue('  Receipts  ');
    await wrapper.find('[data-folder-create-parent]').setValue('10');
    await wrapper.find('form').trigger('submit');
    await nextTick();

    expect(mailStore.createFolder).toHaveBeenCalledWith({
      name: '  Receipts  ',
      parentFolderId: 10,
    });
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('stays open and shows the reason when the create fails', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.createFolder = vi.fn(async () => ({ ok: false, reason: 'duplicateName' }));

    const wrapper = mountDialog();
    await nextTick();

    await wrapper.find('[data-folder-create-name]').setValue('Projects');
    await wrapper.find('form').trigger('submit');
    await nextTick();

    expect(wrapper.emitted('close')).toBeFalsy();
    expect(wrapper.text()).toContain('already exists');
  });

  it('disables the submit button until a name is entered', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    expect(wrapper.find('[data-folder-create-submit]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-folder-create-name]').setValue('Receipts');
    await nextTick();
    expect(wrapper.find('[data-folder-create-submit]').attributes('disabled')).toBeUndefined();
  });
});
