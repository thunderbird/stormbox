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

import FolderTree from '../../../src/components/FolderTree.vue';
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
