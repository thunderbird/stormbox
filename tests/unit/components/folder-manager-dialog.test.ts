// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { computed, nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

// happy-dom has no layout, so the real virtualizer would render nothing.
// Materialize every item; the dialog's own item -> DOM mapping is what
// these tests exercise.
vi.mock('@tanstack/vue-virtual', () => ({
  useVirtualizer: (optionsRef) => computed(() => {
    const count = Number(optionsRef.value.count ?? 0);
    return {
      getTotalSize: () => count * 33,
      getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
        index,
        key: optionsRef.value.getItemKey?.(index) ?? index,
        start: index * 33,
        size: 33,
      })),
      measureElement: () => {},
      measure: () => {},
    };
  }),
}));

import FolderManagerDialog from '../../../src/components/FolderManagerDialog.vue';
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
  ];
  mailStore.folders = [
    makeFolder(1, { name: 'Inbox', role: 'inbox' }),
    makeFolder(10, { name: 'Projects' }),
    makeFolder(11, { name: 'Alpha', parent_id: 10 }),
    makeFolder(12, { name: 'Gamma', parent_id: 11 }),
    makeFolder(20, { name: 'Reports' }),
  ];
}

function mountDialog() {
  return mount(FolderManagerDialog, {
    global: { stubs: { teleport: true } },
  });
}

/** The services-ui subscription switch (root div; inner input = state). */
function subSwitch(wrapper, name) {
  return wrapper.find(`[data-folder-name="${name}"]`);
}

function switchChecked(wrapper, name) {
  return (subSwitch(wrapper, name).find('input').element as HTMLInputElement).checked;
}

/** The multi-select checkbox (only rendered for deletable folders). */
function selectBox(wrapper, name) {
  return wrapper.find(`input[data-folder-select="${name}"]`);
}

function editButton(wrapper, name) {
  return wrapper.find(`button[data-folder-edit="${name}"]`);
}

/** The draggable row body for a (non-system) folder. */
function rowMain(wrapper, name) {
  return wrapper.findAll('.folder-subs__row-main')
    .find((row) => row.find(`[data-folder-name="${name}"]`).exists());
}

function renderedNames(wrapper) {
  return wrapper.findAll('.folder-subs__name').map((el) => el.text());
}

/** Expand a collapsed parent row via its chevron. */
async function expand(wrapper, name) {
  await wrapper.find(`button[data-folder-toggle="${name}"]`).trigger('click');
  await nextTick();
}

/** Expand the own account's default (system) folder block. */
async function expandDefaults(wrapper) {
  await wrapper.find('button[data-account-toggle]').trigger('click');
  await nextTick();
}

/** Minimal DataTransfer stand-in; happy-dom drag events carry none. */
function makeDataTransfer() {
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn(),
    getData: vi.fn(() => ''),
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('FolderManagerDialog cascading subscription toggles', () => {
  it('unsubscribing a parent unsubscribes its whole subtree, not siblings', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    const calls: Array<[number[], boolean]> = [];
    mailStore.setFolderSubscriptions = vi.fn(async (ids, isSubscribed) => {
      calls.push([ids, isSubscribed]);
      return true;
    });

    const wrapper = mountDialog();
    await nextTick();

    expect(switchChecked(wrapper, 'Projects')).toBe(true);
    await subSwitch(wrapper, 'Projects').trigger('click');
    await nextTick();

    // One batched call so the sidebar repaints once, not per child.
    expect(calls).toEqual([[[10, 11, 12], false]]);
  });

  it('subscribing a parent resubscribes only descendants that are unsubscribed', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      // Projects and Gamma off, Alpha (the middle of the chain) still on.
      f.id === 10 || f.id === 12 ? { ...f, is_subscribed: 0 } : f
    ));
    const calls: Array<[number[], boolean]> = [];
    mailStore.setFolderSubscriptions = vi.fn(async (ids, isSubscribed) => {
      calls.push([ids, isSubscribed]);
      return true;
    });

    const wrapper = mountDialog();
    await nextTick();

    expect(switchChecked(wrapper, 'Projects')).toBe(false);
    await subSwitch(wrapper, 'Projects').trigger('click');
    await nextTick();

    expect(calls).toEqual([[[10, 12], true]]);
  });

  it('toggling a leaf touches only that folder', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    const calls: Array<[number[], boolean]> = [];
    mailStore.setFolderSubscriptions = vi.fn(async (ids, isSubscribed) => {
      calls.push([ids, isSubscribed]);
      return true;
    });

    const wrapper = mountDialog();
    await nextTick();

    await subSwitch(wrapper, 'Reports').trigger('click');
    await nextTick();

    expect(calls).toEqual([[[20], false]]);
  });

  it('greys out the label of hidden folders', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 20 ? { ...f, is_subscribed: 0 } : f
    ));

    const wrapper = mountDialog();
    await nextTick();
    await expandDefaults(wrapper);

    const names = Object.fromEntries(
      wrapper.findAll('.folder-subs__name').map((el) => [el.text(), el.classes()]),
    );
    expect(names.Reports).toContain('is-hidden');
    expect(names.Projects).not.toContain('is-hidden');
    expect(names.Inbox).not.toContain('is-hidden');
  });

  it('system folders get no subscription switch', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();
    await expandDefaults(wrapper);

    expect(subSwitch(wrapper, 'Inbox').exists()).toBe(false);
    expect(wrapper.text()).toContain('always shown');
  });
});

describe('FolderManagerDialog collapse/expand', () => {
  it('starts collapsed like the sidebar and expands per chevron', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    // Only top-level user folders render initially; the default
    // (system) folders sit collapsed behind the account heading.
    expect(renderedNames(wrapper)).toEqual(['Projects', 'Reports']);

    await expandDefaults(wrapper);
    expect(renderedNames(wrapper)).toEqual(['Inbox', 'Projects', 'Reports']);

    await expand(wrapper, 'Projects');
    expect(renderedNames(wrapper)).toEqual(['Inbox', 'Projects', 'Alpha', 'Reports']);

    await expand(wrapper, 'Alpha');
    expect(renderedNames(wrapper)).toEqual(['Inbox', 'Projects', 'Alpha', 'Gamma', 'Reports']);

    // Collapsing the root hides the whole subtree again.
    await expand(wrapper, 'Projects');
    expect(renderedNames(wrapper)).toEqual(['Inbox', 'Projects', 'Reports']);

    // And the default block collapses back too.
    await expandDefaults(wrapper);
    expect(renderedNames(wrapper)).toEqual(['Projects', 'Reports']);
  });

  it('leaf folders get no chevron', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    expect(wrapper.find('button[data-folder-toggle="Projects"]').exists()).toBe(true);
    expect(wrapper.find('button[data-folder-toggle="Reports"]').exists()).toBe(false);
  });

  it('search reaches folders hidden under collapsed ancestors', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();
    expect(renderedNames(wrapper)).not.toContain('Gamma');

    await wrapper.find('.folder-subs__search-input').setValue('gam');
    await nextTick();

    expect(renderedNames(wrapper)).toEqual(['Gamma']);
    // Collapse state is ignored while filtering, so no chevrons.
    expect(wrapper.find('.folder-subs__collapse').exists()).toBe(false);
  });
});

describe('FolderManagerDialog search filter', () => {
  it('narrows the list to matching folder names', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();
    expect(renderedNames(wrapper)).toContain('Reports');

    await wrapper.find('.folder-subs__search-input').setValue('alph');
    await nextTick();

    expect(renderedNames(wrapper)).toEqual(['Alpha']);
  });
});

describe('FolderManagerDialog create entry point', () => {
  it('opens the create dialog from the header button', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();
    expect(wrapper.findComponent(FolderCreateDialog).exists()).toBe(false);

    await wrapper.find('[data-folder-new]').trigger('click');
    await nextTick();

    expect(wrapper.findComponent(FolderCreateDialog).exists()).toBe(true);
  });
});

describe('FolderManagerDialog multi-select + bulk delete', () => {
  it('selecting a parent cascades to its subtree and shows the action bar', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();
    await expand(wrapper, 'Projects');
    await expand(wrapper, 'Alpha');
    expect(wrapper.find('[data-folder-bulkbar]').exists()).toBe(false);

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();

    expect((selectBox(wrapper, 'Alpha').element as HTMLInputElement).checked).toBe(true);
    expect((selectBox(wrapper, 'Gamma').element as HTMLInputElement).checked).toBe(true);
    expect((selectBox(wrapper, 'Reports').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.find('[data-folder-bulkbar]').text()).toContain('3 selected');
  });

  it('deselecting the parent clears the subtree again', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();
    await expand(wrapper, 'Projects');

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();

    expect((selectBox(wrapper, 'Alpha').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.find('[data-folder-bulkbar]').exists()).toBe(false);
  });

  it('bulk delete confirms once, then deletes deepest-first with skipChildCheck', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    const calls: Array<{ ids: number[]; removeEmails: boolean; skipChildCheck: boolean }> = [];
    mailStore.deleteFolders = vi.fn(async (ids, opts = {}) => {
      calls.push({
        ids,
        removeEmails: opts.removeEmails === true,
        skipChildCheck: opts.skipChildCheck === true,
      });
      return { ok: true, succeededIds: ids };
    });

    const wrapper = mountDialog();
    await nextTick();

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();

    await wrapper.find('[data-folder-bulk-delete]').trigger('click');
    await nextTick();
    expect(calls).toHaveLength(0);
    expect(wrapper.find('[data-folder-bulkbar]').text()).toContain('Delete 3 folders?');

    await wrapper.find('[data-folder-bulk-confirm]').trigger('click');
    await nextTick();

    expect(calls).toEqual([{
      ids: [12, 11, 10],
      removeEmails: false,
      skipChildCheck: true,
    }]);
    // Everything deleted -> selection cleared -> bar gone.
    expect(wrapper.find('[data-folder-bulkbar]').exists()).toBe(false);
  });

  it('escalates when folders still contain mail and retries with removeEmails', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    const calls: Array<{ ids: number[]; removeEmails: boolean }> = [];
    mailStore.deleteFolders = vi.fn(async (ids, opts = {}) => {
      calls.push({ ids, removeEmails: opts.removeEmails === true });
      if (opts.removeEmails === true) return { ok: true, succeededIds: ids };
      return {
        ok: false,
        reason: 'mailboxHasEmail',
        succeededIds: [],
        errors: {
          12: { type: 'notDestroyed', detail: { type: 'mailboxHasEmail' } },
          11: { type: 'childFailed' },
          10: { type: 'childFailed' },
        },
      };
    });

    const wrapper = mountDialog();
    await nextTick();

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await wrapper.find('[data-folder-bulk-delete]').trigger('click');
    await nextTick();
    await wrapper.find('[data-folder-bulk-confirm]').trigger('click');
    await nextTick();

    // First pass failed on all three, escalation prompt is up.
    expect(calls.filter((c) => !c.removeEmails).map((c) => c.ids)).toEqual([[12, 11, 10]]);
    expect(wrapper.find('[data-folder-bulkbar]').text()).toContain('permanently delete');

    await wrapper.find('[data-folder-bulk-confirm]').trigger('click');
    await nextTick();

    expect(calls.filter((c) => c.removeEmails).map((c) => c.ids)).toEqual([[12, 11, 10]]);
    expect(wrapper.find('[data-folder-bulkbar]').exists()).toBe(false);
  });

  it('blocks bulk delete when a selected folder keeps an unselected child', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.deleteFolders = vi.fn(async () => ({ ok: true, succeededIds: [] }));

    const wrapper = mountDialog();
    await nextTick();
    await expand(wrapper, 'Projects');

    // Select the subtree, then carve the middle folder back out.
    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Alpha').trigger('click');
    await nextTick();

    await wrapper.find('[data-folder-bulk-delete]').trigger('click');
    await nextTick();

    expect(mailStore.deleteFolders).not.toHaveBeenCalled();
    expect(wrapper.find('[data-folder-bulk-confirm]').exists()).toBe(false);
    expect(wrapper.find('[data-folder-bulkbar]').text()).toContain('Select the whole subtree');
  });

  it('shift-click selects the visual range between the anchor and the target', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();
    await expand(wrapper, 'Projects');
    await expand(wrapper, 'Alpha');

    // Anchor on Projects (cascade selects its subtree), then
    // shift-click Reports: everything between joins the selection.
    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Reports').trigger('click', { shiftKey: true });
    await nextTick();

    expect(wrapper.find('[data-folder-bulkbar]').text()).toContain('4 selected');
    expect((selectBox(wrapper, 'Gamma').element as HTMLInputElement).checked).toBe(true);
    expect((selectBox(wrapper, 'Reports').element as HTMLInputElement).checked).toBe(true);
  });

  it('shift-click on a selected target deselects the range', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();
    await expand(wrapper, 'Projects');
    await expand(wrapper, 'Alpha');

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Reports').trigger('click', { shiftKey: true });
    await nextTick();
    // Re-anchor on Alpha, then shift-click the (selected) Reports:
    // the Alpha..Reports range clears, Projects stays.
    await selectBox(wrapper, 'Alpha').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Alpha').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Reports').trigger('click', { shiftKey: true });
    await nextTick();

    expect((selectBox(wrapper, 'Projects').element as HTMLInputElement).checked).toBe(true);
    expect((selectBox(wrapper, 'Alpha').element as HTMLInputElement).checked).toBe(false);
    expect((selectBox(wrapper, 'Reports').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.find('[data-folder-bulkbar]').text()).toContain('1 selected');
  });

  it('ctrl-click on the row body toggles selection', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    await rowMain(wrapper, 'Reports')!.trigger('click', { ctrlKey: true });
    await nextTick();
    expect((selectBox(wrapper, 'Reports').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.find('[data-folder-bulkbar]').text()).toContain('1 selected');

    // A plain (unmodified) click on the row body is not a selection.
    await rowMain(wrapper, 'Projects')!.trigger('click');
    await nextTick();
    expect((selectBox(wrapper, 'Projects').element as HTMLInputElement).checked).toBe(false);
  });

  it('bulk star button stars all only when nothing selected is starred', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.setFoldersStarred = vi.fn(async () => true);

    const wrapper = mountDialog();
    await nextTick();

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Reports').trigger('click', { shiftKey: true });
    await nextTick();

    // Nothing starred -> the action is "star all".
    expect(wrapper.find('[data-bulk-star]').attributes('aria-label'))
      .toBe('Star selected folders');
    await wrapper.find('[data-bulk-star]').trigger('click');
    await nextTick();
    expect(mailStore.setFoldersStarred).toHaveBeenCalledTimes(1);
    expect(mailStore.setFoldersStarred).toHaveBeenCalledWith([10, 11, 12, 20], true);
  });

  it('bulk star button unstars everything when any selected folder is starred', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 20 ? { ...f, is_starred: 1 } : f
    ));
    mailStore.setFoldersStarred = vi.fn(async () => true);

    const wrapper = mountDialog();
    await nextTick();

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Reports').trigger('click', { shiftKey: true });
    await nextTick();

    // Reports is starred -> the action flips to "unstar all"; only the
    // starred folder needs a store call.
    expect(wrapper.find('[data-bulk-star]').attributes('aria-label'))
      .toBe('Unstar selected folders');
    await wrapper.find('[data-bulk-star]').trigger('click');
    await nextTick();
    expect(mailStore.setFoldersStarred).toHaveBeenCalledTimes(1);
    expect(mailStore.setFoldersStarred).toHaveBeenCalledWith([20], false);
  });

  it('bulk subscription button unsubscribes when any selected folder is subscribed', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    // Reports starts unsubscribed; the rest are subscribed.
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 20 ? { ...f, is_subscribed: 0 } : f
    ));
    mailStore.setFolderSubscriptions = vi.fn(async () => true);

    const wrapper = mountDialog();
    await nextTick();

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Reports').trigger('click', { shiftKey: true });
    await nextTick();

    // Mixed selection -> the bulk switch reads "on" and flipping it
    // unsubscribes in one batch; already-off Reports is skipped, and
    // there is no descendant cascade.
    const bulkSwitch = wrapper.find('[data-bulk-subscribe]');
    expect((bulkSwitch.find('input').element as HTMLInputElement).checked).toBe(true);
    await bulkSwitch.trigger('click');
    await nextTick();
    expect(mailStore.setFolderSubscriptions).toHaveBeenCalledTimes(1);
    expect(mailStore.setFolderSubscriptions).toHaveBeenCalledWith([10, 11, 12], false);
  });

  it('bulk subscription button subscribes when the whole selection is unsubscribed', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.role == null ? { ...f, is_subscribed: 0 } : f
    ));
    mailStore.setFolderSubscriptions = vi.fn(async () => true);

    const wrapper = mountDialog();
    await nextTick();

    await selectBox(wrapper, 'Projects').trigger('click');
    await nextTick();
    await selectBox(wrapper, 'Reports').trigger('click', { shiftKey: true });
    await nextTick();

    // Whole selection unsubscribed -> the bulk switch reads "off" and
    // flipping it subscribes everything in one batch.
    const bulkSwitch = wrapper.find('[data-bulk-subscribe]');
    expect((bulkSwitch.find('input').element as HTMLInputElement).checked).toBe(false);
    await bulkSwitch.trigger('click');
    await nextTick();
    expect(mailStore.setFolderSubscriptions).toHaveBeenCalledTimes(1);
    expect(mailStore.setFolderSubscriptions).toHaveBeenCalledWith([10, 11, 12, 20], true);
  });

  it('offers no selection checkbox for system folders', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    expect(selectBox(wrapper, 'Inbox').exists()).toBe(false);
    expect(selectBox(wrapper, 'Reports').exists()).toBe(true);
  });
});

describe('FolderManagerDialog drag and drop move', () => {
  it('moves a folder dropped onto another folder', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.updateFolder = vi.fn(async () => ({ ok: true }));

    const wrapper = mountDialog();
    await nextTick();

    const dataTransfer = makeDataTransfer();
    await rowMain(wrapper, 'Reports')!.trigger('dragstart', { dataTransfer });
    await rowMain(wrapper, 'Projects')!.trigger('dragover', { dataTransfer });
    await rowMain(wrapper, 'Projects')!.trigger('drop');
    await nextTick();

    expect(mailStore.updateFolder).toHaveBeenCalledWith(20, { parentFolderId: 10 });
  });

  it('rejects dropping a folder into its own descendant', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.updateFolder = vi.fn(async () => ({ ok: true }));

    const wrapper = mountDialog();
    await nextTick();
    await expand(wrapper, 'Projects');
    await expand(wrapper, 'Alpha');

    const dataTransfer = makeDataTransfer();
    await rowMain(wrapper, 'Projects')!.trigger('dragstart', { dataTransfer });
    await rowMain(wrapper, 'Gamma')!.trigger('drop');
    await nextTick();

    expect(mailStore.updateFolder).not.toHaveBeenCalled();
  });

  it('moves a folder dropped on the tree root to top level', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.updateFolder = vi.fn(async () => ({ ok: true }));

    const wrapper = mountDialog();
    await nextTick();
    await expand(wrapper, 'Projects');

    const dataTransfer = makeDataTransfer();
    await rowMain(wrapper, 'Alpha')!.trigger('dragstart', { dataTransfer });
    await wrapper.find('[data-folder-root]').trigger('drop');
    await nextTick();

    expect(mailStore.updateFolder).toHaveBeenCalledWith(11, { parentFolderId: null });
  });

  it('renders the tree root only for the own account and not while searching', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.accounts = [
      ...mailStore.accounts,
      { id: 2, is_primary: 0, is_personal: 0, display_name: 'other@example.org', server_origin: 'o' },
    ] as any;
    mailStore.folders = [
      ...mailStore.folders,
      makeFolder(30, { account_id: 2, name: 'SharedThing' }),
    ];

    const wrapper = mountDialog();
    await nextTick();
    await expandDefaults(wrapper);

    // One root (the own account); shared accounts can't host top-level
    // folders, so they get none.
    expect(wrapper.findAll('[data-folder-root]')).toHaveLength(1);

    // The root sits below the system folders (which can't be moved)
    // and directly above the movable user folders.
    const itemTexts = wrapper
      .findAll('.folder-subs__item')
      .map((el) => el.text().replace(/\s+/g, ' ').trim());
    const rootIdx = itemTexts.findIndex((t) => t.includes('Top Level'));
    const inboxIdx = itemTexts.findIndex((t) => t.includes('Inbox'));
    const projectsIdx = itemTexts.findIndex((t) => t.includes('Projects'));
    expect(inboxIdx).toBeGreaterThan(-1);
    expect(rootIdx).toBeGreaterThan(inboxIdx);
    expect(rootIdx).toBeLessThan(projectsIdx);

    await wrapper.find('.folder-subs__search-input').setValue('alph');
    await nextTick();
    expect(wrapper.findAll('[data-folder-root]')).toHaveLength(0);
  });
});

describe('FolderManagerDialog row editor', () => {
  it('renames a folder through the editor', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.updateFolder = vi.fn(async () => ({ ok: true }));

    const wrapper = mountDialog();
    await nextTick();

    await editButton(wrapper, 'Reports').trigger('click');
    await nextTick();

    const input = wrapper.find('[data-folder-rename-input]');
    expect(input.exists()).toBe(true);
    await input.setValue('Quarterly Reports');
    await wrapper.find('[data-folder-save]').trigger('click');
    await nextTick();

    expect(mailStore.updateFolder).toHaveBeenCalledWith(20, { name: 'Quarterly Reports' });
    // Editor closes on success.
    expect(wrapper.find('[data-folder-rename-input]').exists()).toBe(false);
  });

  it('moves a folder by selecting a new location', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.updateFolder = vi.fn(async () => ({ ok: true }));

    const wrapper = mountDialog();
    await nextTick();

    await editButton(wrapper, 'Reports').trigger('click');
    await nextTick();

    await wrapper.find('[data-folder-move-select]').setValue('10');
    await wrapper.find('[data-folder-save]').trigger('click');
    await nextTick();

    expect(mailStore.updateFolder).toHaveBeenCalledWith(20, { parentFolderId: 10 });
  });

  it('excludes the folder itself and its descendants from move targets', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    await editButton(wrapper, 'Projects').trigger('click');
    await nextTick();

    const labels = wrapper.find('[data-folder-move-select]')
      .findAll('option')
      .map((o) => o.text().replaceAll('\u00a0', ''));
    expect(labels).toContain('Top Level');
    expect(labels).toContain('Reports');
    expect(labels).not.toContain('Projects');
    expect(labels).not.toContain('Alpha');
    expect(labels).not.toContain('Gamma');
  });

  it('deletes after confirmation and escalates on mailboxHasEmail', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    const calls: Array<{ id: number; removeEmails: boolean }> = [];
    mailStore.deleteFolder = vi.fn(async (id, opts = {}) => {
      calls.push({ id, removeEmails: opts.removeEmails === true });
      // First (removeEmails: false) attempt is rejected: folder has mail.
      return opts.removeEmails === true
        ? { ok: true }
        : { ok: false, reason: 'mailboxHasEmail' };
    });

    const wrapper = mountDialog();
    await nextTick();

    await editButton(wrapper, 'Reports').trigger('click');
    await nextTick();

    // Stage 1: ask for confirmation, no mutation yet.
    await wrapper.find('[data-folder-delete]').trigger('click');
    await nextTick();
    expect(calls).toHaveLength(0);
    expect(wrapper.text()).toContain('Delete “Reports”?');

    // Stage 2: confirmed; server rejects with mailboxHasEmail.
    await wrapper.find('[data-folder-delete-confirm]').trigger('click');
    await nextTick();
    expect(calls).toEqual([{ id: 20, removeEmails: false }]);
    expect(wrapper.text()).toContain('permanently delete');

    // Stage 3: escalated confirmation retries with removeEmails: true.
    await wrapper.find('[data-folder-delete-confirm]').trigger('click');
    await nextTick();
    expect(calls).toEqual([
      { id: 20, removeEmails: false },
      { id: 20, removeEmails: true },
    ]);
    expect(wrapper.find('[data-folder-delete-confirm]').exists()).toBe(false);
  });

  it('gates the editor by role and shared-folder rights', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.accounts = [
      ...mailStore.accounts,
      { id: 2, is_primary: 0, is_personal: 0, display_name: 'other@example.org', server_origin: 'o' },
    ] as any;
    mailStore.folders = [
      ...mailStore.folders,
      makeFolder(30, {
        account_id: 2,
        name: 'SharedReadOnly',
        rights_json: JSON.stringify({ mayRename: false, mayDelete: false }),
      }),
      makeFolder(31, {
        account_id: 2,
        name: 'SharedWritable',
        rights_json: JSON.stringify({ mayRename: true, mayDelete: true }),
      }),
    ];

    const wrapper = mountDialog();
    await nextTick();

    // Role folders never get a pencil; neither do shared folders where
    // the owner granted no modify/delete rights.
    expect(editButton(wrapper, 'Inbox').exists()).toBe(false);
    expect(editButton(wrapper, 'SharedReadOnly').exists()).toBe(false);
    expect(editButton(wrapper, 'SharedWritable').exists()).toBe(true);
    expect(editButton(wrapper, 'Reports').exists()).toBe(true);

    // The per-row + (create child) needs mayCreateChild on shared
    // folders; own folders always have it.
    expect(wrapper.find('[data-folder-add="SharedReadOnly"]').exists()).toBe(false);
    expect(wrapper.find('[data-folder-add="SharedWritable"]').exists()).toBe(false);
    expect(wrapper.find('[data-folder-add="Reports"]').exists()).toBe(true);
  });

  it('star button toggles the client-local star through the store', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 20 ? { ...f, is_starred: 1 } : f
    ));
    mailStore.setFolderStarred = vi.fn(async () => true);

    const wrapper = mountDialog();
    await nextTick();

    const reportsStar = wrapper.find('button[data-folder-star="Reports"]');
    const projectsStar = wrapper.find('button[data-folder-star="Projects"]');
    expect(reportsStar.attributes('aria-pressed')).toBe('true');
    expect(reportsStar.classes()).toContain('is-starred');
    expect(projectsStar.attributes('aria-pressed')).toBe('false');

    await projectsStar.trigger('click');
    await reportsStar.trigger('click');
    expect(mailStore.setFolderStarred).toHaveBeenCalledWith(10, true);
    expect(mailStore.setFolderStarred).toHaveBeenCalledWith(20, false);
  });

  it('keeps structural order regardless of stars, system folders get no star', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 20 ? { ...f, is_starred: 1 } : f
    ));

    const wrapper = mountDialog();
    await nextTick();

    // The manager view never re-sorts on star state — rows must not
    // jump around while the user is clicking stars. Priority grouping
    // is sidebar-only. Inbox gets no star button.
    expect(renderedNames(wrapper)).toEqual(['Projects', 'Reports']);
    await expandDefaults(wrapper);
    expect(wrapper.find('button[data-folder-star="Inbox"]').exists()).toBe(false);
  });

  it('orders row controls star, switch, pencil, then + last for column alignment', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    const controls = rowMain(wrapper, 'Reports')!
      .findAll('button[data-folder-star], [data-folder-name], button[data-folder-edit], button[data-folder-add]')
      .map((el) => (
        el.attributes('data-folder-star') != null ? 'star'
          : el.attributes('data-folder-edit') != null ? 'edit'
            : el.attributes('data-folder-add') != null ? 'add'
              : 'switch'
      ));
    expect(controls).toEqual(['star', 'switch', 'edit', 'add']);
  });

  it('shows no star hint on collapsed ancestors of starred folders', async () => {
    const mailStore = useMailStore();
    seed(mailStore);
    // Gamma (Projects > Alpha > Gamma) is starred; collapsed ancestors
    // stay unmarked by design — search is the way to locate the star.
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 12 ? { ...f, is_starred: 1 } : f
    ));

    const wrapper = mountDialog();
    await nextTick();

    expect(wrapper.find('[data-folder-star-hint]').exists()).toBe(false);
  });

  it('shows the ancestor path next to search matches', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    await wrapper.find('.folder-subs__search-input').setValue('gam');
    await nextTick();

    // Gamma is nested under Projects > Alpha; the breadcrumb locates
    // it. Top-level matches get no breadcrumb.
    expect(wrapper.find('.folder-subs__path').text()).toBe('Projects / Alpha');
    await wrapper.find('.folder-subs__search-input').setValue('rep');
    await nextTick();
    expect(wrapper.find('.folder-subs__path').exists()).toBe(false);
  });

  it('opens the create dialog with the row preselected as parent', async () => {
    const mailStore = useMailStore();
    seed(mailStore);

    const wrapper = mountDialog();
    await nextTick();

    await wrapper.find('[data-folder-add="Projects"]').trigger('click');
    await nextTick();

    const parentSelect = wrapper.find('[data-folder-create-parent]');
    expect(parentSelect.exists()).toBe(true);
    // Projects has id 10 in the seed.
    expect((parentSelect.element as HTMLSelectElement).value).toBe('10');
  });
});
