// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth.js', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import App from '../../../src/App.vue';
import { AUTH_STATE } from '../../../src/constants/states.js';
import { useAuthStore } from '../../../src/stores/auth-store.js';
import { useMailStore } from '../../../src/stores/mail-store.js';
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/use-repository.js';

function makeRepo() {
  return {
    subscribe() { return () => {}; },
    async listFolders() { return []; },
    async listMessagesForView() { return []; },
    async queryViewProgress() { return { total: 0, covered: 0, percent: 0 }; },
    async ensureFolderWindow() { return { total: 0, fetched: 0 }; },
    async ensureMessageBodies() { return { fetched: 0 }; },
    async getMessageBodyForDisplay() { return null; },
    async ensureFolderTree() { return { count: 0 }; },
    async listAddressbooks() { return []; },
    async listIdentities() { return []; },
  };
}

function mountApp() {
  return mount(App, {
    global: {
      stubs: {
        AppSpaces: { template: '<nav />' },
        LoginGate: { template: '<div />' },
        FolderTree: { template: '<aside />' },
        MessageList: { template: '<section class="msg-list">list</section>' },
        MessageView: { template: '<section class="message-view">view</section>' },
        ComposeDialog: { template: '<div />' },
        ContactsView: { template: '<section />' },
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
  const authStore = useAuthStore();
  authStore.status = AUTH_STATE.CONNECTED;
  authStore.accountId = 1;
});

afterEach(() => {
  __resetRepositoryForTests();
});

describe('App mail layout', () => {
  it('hides the message view and expands the message list when nothing is selected', async () => {
    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(false);
    expect(wrapper.find('.shell').classes()).toContain('shell--message-view-hidden');
  });

  it('shows the message view for either a viewed message or bulk selection', async () => {
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(true);
    expect(wrapper.find('.shell').classes()).not.toContain('shell--message-view-hidden');

    mailStore.selectedMessageId = null;
    mailStore.selectedIds = new Set([7]);
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(true);
    expect(wrapper.find('.shell').classes()).not.toContain('shell--message-view-hidden');
  });
});
