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

// The manage-folders dialog virtualizes its list; happy-dom has no
// layout, so materialize every item like the MessageList tests do.
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

import FolderTree from '../../../src/components/FolderTree.vue';
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
    total_emails: 0,
    unread_emails: 0,
    may_add_items: null,
    may_remove_items: null,
    ...overrides,
  } as any;
}

// Inbox (leaf, role) + a Projects > Alpha > Gamma user-folder chain
// and a leaf Reports folder. Distinct names avoid substring clashes.
function seedFolders(mailStore) {
  // The sidebar tree renders primaryFolders, which scopes rows to the
  // signed-in account; the seeded rows all use account_id 1.
  useAuthStore().accountId = 1;
  mailStore.folders = [
    makeFolder(1, { name: 'Inbox', role: 'inbox' }),
    makeFolder(10, { name: 'Projects' }),
    makeFolder(11, { name: 'Alpha', parent_id: 10 }),
    makeFolder(12, { name: 'Gamma', parent_id: 11 }),
    makeFolder(20, { name: 'Reports' }),
  ];
}

function nodeByName(wrapper, name) {
  return wrapper.findAll('.folder-node').find((node) => node.text().includes(name));
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('FolderTree collapse/expand', () => {
  it('starts fully collapsed: only top-level folders render, subfolders are hidden', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);

    const wrapper = mount(FolderTree);
    await nextTick();

    // Inbox + Projects + Reports, but not the nested Alpha/Gamma.
    expect(wrapper.findAll('.folder-node')).toHaveLength(3);
    expect(wrapper.text()).not.toContain('Alpha');
    expect(wrapper.text()).not.toContain('Gamma');

    // Only the folder with children (Projects) shows a disclosure
    // toggle; leaf folders render an inert spacer instead.
    expect(wrapper.findAll('button.folder-node__toggle')).toHaveLength(1);
    const projects = nodeByName(wrapper, 'Projects');
    expect(projects.find('button.folder-node__toggle').attributes('aria-expanded')).toBe('false');

    const reports = nodeByName(wrapper, 'Reports');
    expect(reports.find('button.folder-node__toggle').exists()).toBe(false);
    expect(reports.find('.folder-node__toggle--spacer').exists()).toBe(true);
  });

  it('reveals child folders when the disclosure toggle is clicked, and hides them again', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);

    const wrapper = mount(FolderTree);
    await nextTick();

    await nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('Alpha');
    // Alpha is itself a parent, so it now exposes its own toggle, but
    // its child (Gamma) stays collapsed until Alpha is expanded.
    expect(wrapper.findAll('.folder-node')).toHaveLength(4);
    expect(wrapper.text()).not.toContain('Gamma');
    expect(nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').attributes('aria-expanded')).toBe('true');

    await nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').trigger('click');
    await nextTick();

    expect(wrapper.findAll('.folder-node')).toHaveLength(3);
    expect(wrapper.text()).not.toContain('Alpha');
  });

  it('selecting a folder by name selects it without changing expansion', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);
    const select = vi.spyOn(mailStore, 'selectFolder').mockImplementation(() => {});

    const wrapper = mount(FolderTree);
    await nextTick();

    await nodeByName(wrapper, 'Projects').find('.folder-node__button').trigger('click');
    await nextTick();

    expect(select).toHaveBeenCalledWith(10);
    // Clicking the label must not expand the branch.
    expect(wrapper.text()).not.toContain('Alpha');
  });

  it('toggling expansion does not change the selected folder', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);
    const select = vi.spyOn(mailStore, 'selectFolder').mockImplementation(() => {});

    const wrapper = mount(FolderTree);
    await nextTick();

    await nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').trigger('click');
    await nextTick();

    expect(select).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Alpha');
  });

  it('tracks each folder’s expansion state independently', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);

    const wrapper = mount(FolderTree);
    await nextTick();

    await nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').trigger('click');
    await nextTick();
    await nodeByName(wrapper, 'Alpha').find('button.folder-node__toggle').trigger('click');
    await nextTick();
    expect(wrapper.text()).toContain('Gamma');

    // Collapsing the ancestor hides the whole subtree...
    await nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').trigger('click');
    await nextTick();
    expect(wrapper.text()).not.toContain('Alpha');
    expect(wrapper.text()).not.toContain('Gamma');

    // ...but re-expanding it restores Alpha's own retained expanded
    // state, so Gamma is visible again without re-toggling Alpha.
    await nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').trigger('click');
    await nextTick();
    expect(wrapper.text()).toContain('Alpha');
    expect(wrapper.text()).toContain('Gamma');
  });
});

describe('FolderTree collapsed unread totals', () => {
  // Projects(0) > Alpha(2) > Gamma(3), plus Projects > Beta(5).
  // Projects subtree unread = 0 + 2 + 3 + 5 = 10.
  function seedUnread(mailStore) {
    useAuthStore().accountId = 1;
    mailStore.folders = [
      makeFolder(1, { name: 'Inbox', role: 'inbox', unread_emails: 1 }),
      makeFolder(10, { name: 'Projects', unread_emails: 0 }),
      makeFolder(11, { name: 'Alpha', parent_id: 10, unread_emails: 2 }),
      makeFolder(12, { name: 'Gamma', parent_id: 11, unread_emails: 3 }),
      makeFolder(13, { name: 'Beta', parent_id: 10, unread_emails: 5 }),
      makeFolder(20, { name: 'Reports', unread_emails: 0 }),
    ];
  }

  it('sums the whole subtree unread on a collapsed parent', async () => {
    const mailStore = useMailStore();
    seedUnread(mailStore);

    const wrapper = mount(FolderTree);
    await nextTick();

    expect(nodeByName(wrapper, 'Projects').find('.folder-node__count').text()).toBe('10');
    // A leaf still shows only its own count.
    expect(nodeByName(wrapper, 'Inbox').find('.folder-node__count').text()).toBe('1');
  });

  it('shows only the own count once expanded, and rolls up at each level', async () => {
    const mailStore = useMailStore();
    seedUnread(mailStore);

    const wrapper = mount(FolderTree);
    await nextTick();

    await nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').trigger('click');
    await nextTick();

    // Projects' own unread is 0, so no badge once expanded.
    expect(nodeByName(wrapper, 'Projects').find('.folder-node__count').exists()).toBe(false);
    // Beta is a leaf: its own 5. Alpha is collapsed: its subtree 2 + 3 = 5.
    expect(nodeByName(wrapper, 'Beta').find('.folder-node__count').text()).toBe('5');
    expect(nodeByName(wrapper, 'Alpha').find('.folder-node__count').text()).toBe('5');

    await nodeByName(wrapper, 'Alpha').find('button.folder-node__toggle').trigger('click');
    await nextTick();

    // Expanded Alpha now shows only its own 2; Gamma shows its own 3.
    expect(nodeByName(wrapper, 'Alpha').find('.folder-node__count').text()).toBe('2');
    expect(nodeByName(wrapper, 'Gamma').find('.folder-node__count').text()).toBe('3');
  });
});

describe('FolderTree starred folders', () => {
  it('floats starred user folders to the top of the FOLDERS section', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 20 ? { ...f, is_starred: 1 } : f
    ));

    const wrapper = mount(FolderTree);
    await nextTick();

    // Reports (starred) precedes Projects; the role-anchored Inbox
    // group is untouched above them.
    const names = wrapper.findAll('.folder-node').map((n) => n.text());
    const inboxIdx = names.findIndex((t) => t.includes('Inbox'));
    const reportsIdx = names.findIndex((t) => t.includes('Reports'));
    const projectsIdx = names.findIndex((t) => t.includes('Projects'));
    expect(inboxIdx).toBeLessThan(reportsIdx);
    expect(reportsIdx).toBeLessThan(projectsIdx);

    // The leading gold star is the only group marker: the starred row
    // carries it, others don't, and there is no labeled divider.
    expect(nodeByName(wrapper, 'Reports').find('.folder-node__star').exists()).toBe(true);
    expect(nodeByName(wrapper, 'Projects').find('.folder-node__star').exists()).toBe(false);
  });

  it('renders no star markers when nothing is starred', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);

    const wrapper = mount(FolderTree);
    await nextTick();

    expect(wrapper.find('.folder-node__star').exists()).toBe(false);
  });

  it('pulls a starred subfolder out of its unstarred parent into the starred group', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);
    // Alpha is nested under Projects; starring it promotes it to a root.
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 11 ? { ...f, is_starred: 1 } : f
    ));

    const wrapper = mount(FolderTree);
    await nextTick();

    // Alpha renders immediately (a root now) even though the tree
    // starts collapsed, sitting between Inbox and the divider.
    const names = wrapper.findAll('.folder-node').map((n) => n.text());
    const alphaIdx = names.findIndex((t) => t.includes('Alpha'));
    expect(alphaIdx).toBeGreaterThan(names.findIndex((t) => t.includes('Inbox')));
    expect(alphaIdx).toBeLessThan(names.findIndex((t) => t.includes('Projects')));
    expect(nodeByName(wrapper, 'Alpha').find('.folder-node__star').exists()).toBe(true);

    // Its own child (Gamma) came along: expanding Alpha reveals it,
    // while expanding Projects no longer shows Alpha.
    await nodeByName(wrapper, 'Alpha').find('button.folder-node__toggle').trigger('click');
    await nextTick();
    expect(wrapper.text()).toContain('Gamma');
    expect(nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').exists()).toBe(false);
  });

  it('promotes a starred child to its own root even when the parent is starred too', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 10 || f.id === 11 ? { ...f, is_starred: 1 } : f
    ));

    const wrapper = mount(FolderTree);
    await nextTick();

    // Both Projects and Alpha are top-level favorites; starring is
    // never a latent no-op. Alpha's own subtree (Gamma) came with it.
    expect(wrapper.text()).toContain('Alpha');
    expect(nodeByName(wrapper, 'Projects').find('.folder-node__star').exists()).toBe(true);
    expect(nodeByName(wrapper, 'Alpha').find('.folder-node__star').exists()).toBe(true);

    // Projects no longer has Alpha nested (its only child), so it has
    // no disclosure toggle; expanding Alpha reveals Gamma.
    expect(nodeByName(wrapper, 'Projects').find('button.folder-node__toggle').exists()).toBe(false);
    await nodeByName(wrapper, 'Alpha').find('button.folder-node__toggle').trigger('click');
    await nextTick();
    expect(wrapper.text()).toContain('Gamma');
  });

  it('keeps the FOLDERS heading and manage button when every folder is starred', async () => {
    const mailStore = useMailStore();
    seedFolders(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.role == null && f.parent_id == null ? { ...f, is_starred: 1 } : f
    ));

    const wrapper = mount(FolderTree);
    await nextTick();

    expect(wrapper.find('.folder-tree__manage').exists()).toBe(true);
    expect(wrapper.findAll('.folder-node__star').length).toBeGreaterThan(0);
  });
});

describe('FolderTree own-folder subscription filtering', () => {
  it('hides unsubscribed user folders but always shows role folders', async () => {
    const mailStore = useMailStore();
    useAuthStore().accountId = 1;
    mailStore.folders = [
      // Role folder explicitly unsubscribed on the server: still shown.
      makeFolder(1, { name: 'Inbox', role: 'inbox', is_subscribed: 0 }),
      makeFolder(10, { name: 'Projects', is_subscribed: 1 }),
      makeFolder(20, { name: 'Hidden', is_subscribed: 0 }),
      // NULL = server never reported the property: treated as visible.
      makeFolder(30, { name: 'Legacy', is_subscribed: null }),
    ];

    const wrapper = mount(FolderTree);
    await nextTick();

    expect(wrapper.text()).toContain('Inbox');
    expect(wrapper.text()).toContain('Projects');
    expect(wrapper.text()).toContain('Legacy');
    expect(wrapper.text()).not.toContain('Hidden');
  });

  it('promotes a subscribed child of an unsubscribed user folder to a root', async () => {
    const mailStore = useMailStore();
    useAuthStore().accountId = 1;
    mailStore.folders = [
      makeFolder(1, { name: 'Inbox', role: 'inbox' }),
      makeFolder(10, { name: 'Parent', is_subscribed: 0 }),
      makeFolder(11, { name: 'Child', parent_id: 10, is_subscribed: 1 }),
    ];

    const wrapper = mount(FolderTree);
    await nextTick();

    expect(wrapper.text()).not.toContain('Parent');
    expect(wrapper.text()).toContain('Child');
  });
});

describe('FolderTree shared account sections', () => {
  function seedShared(mailStore) {
    useAuthStore().accountId = 1;
    mailStore.accounts = [
      { id: 1, is_primary: 1, is_personal: 1, display_name: 'me@example.org', server_origin: 'o' },
      { id: 2, is_primary: 0, is_personal: 0, display_name: 'other@example.org', server_origin: 'o' },
    ];
    mailStore.folders = [
      makeFolder(1, { name: 'Inbox', role: 'inbox' }),
      // Shared account folders: only subscribed ones belong in the sidebar.
      makeFolder(30, { account_id: 2, name: 'Team', is_subscribed: 1 }),
      makeFolder(31, { account_id: 2, name: 'Private', is_subscribed: 0 }),
      makeFolder(32, { account_id: 2, name: 'Nested', parent_id: 31, is_subscribed: 1 }),
    ];
  }

  it('renders a section per shared account with only subscribed folders', async () => {
    const mailStore = useMailStore();
    seedShared(mailStore);

    const wrapper = mount(FolderTree);
    await nextTick();

    expect(wrapper.find('.folder-tree__heading--shared').text()).toBe('other@example.org');
    expect(wrapper.text()).toContain('Team');
    expect(wrapper.text()).not.toContain('Private');
  });

  it('promotes a subscribed folder under an unsubscribed parent to a section root', async () => {
    const mailStore = useMailStore();
    seedShared(mailStore);

    const wrapper = mount(FolderTree);
    await nextTick();

    // Nested's parent (Private) is unsubscribed and hidden; Nested must
    // still be reachable rather than silently dropped.
    expect(wrapper.text()).toContain('Nested');
  });

  it('shows no shared section when no shared folder is subscribed', async () => {
    const mailStore = useMailStore();
    seedShared(mailStore);
    mailStore.folders = mailStore.folders.map((f) =>
      f.account_id === 2 ? { ...f, is_subscribed: 0 } : f);

    const wrapper = mount(FolderTree);
    await nextTick();

    expect(wrapper.find('.folder-tree__heading--shared').exists()).toBe(false);
  });

  it('moves a starred shared folder into the favorites group at the top', async () => {
    const mailStore = useMailStore();
    seedShared(mailStore);
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 30 ? { ...f, is_starred: 1 } : f
    ));

    const wrapper = mount(FolderTree);
    await nextTick();

    // Team leaves the shared section and renders in the favorites
    // group above it, with the star marker; the section keeps its
    // remaining folder (Nested).
    expect(nodeByName(wrapper, 'Team').find('.folder-node__star').exists()).toBe(true);
    const html = wrapper.html();
    expect(html.indexOf('Team')).toBeLessThan(html.indexOf('folder-tree__heading--shared'));
    const shared = wrapper.find('.folder-tree__heading--shared');
    expect(shared.exists()).toBe(true);
    expect(wrapper.text()).toContain('Nested');
  });

  it('drops the shared section heading when all its folders are starred', async () => {
    const mailStore = useMailStore();
    seedShared(mailStore);
    // Star both sidebar-visible shared folders (Team and Nested).
    mailStore.folders = mailStore.folders.map((f) => (
      f.id === 30 || f.id === 32 ? { ...f, is_starred: 1 } : f
    ));

    const wrapper = mount(FolderTree);
    await nextTick();

    expect(wrapper.find('.folder-tree__heading--shared').exists()).toBe(false);
    expect(wrapper.text()).toContain('Team');
    expect(wrapper.text()).toContain('Nested');
  });

  it('opens the folder subscriptions dialog from the manage button', async () => {
    const mailStore = useMailStore();
    seedShared(mailStore);

    // The dialog teleports to <body>; stub the teleport so it renders
    // inside the wrapper and stays queryable.
    const wrapper = mount(FolderTree, { global: { stubs: { teleport: true } } });
    await nextTick();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await wrapper.find('.folder-tree__manage').trigger('click');
    await nextTick();

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    // The dialog lists every folder (subscribed or not) grouped by
    // account, including the unsubscribed shared folder hidden from
    // the sidebar.
    expect(dialog.text()).toContain('Private');
    expect(dialog.text()).toContain('shared');
  });
});
