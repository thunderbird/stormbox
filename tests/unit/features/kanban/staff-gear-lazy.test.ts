// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

// Records whether the gear's module (and with it the dialog, fireworks
// and audio clip it imports) was ever evaluated.
const gearModule = vi.hoisted(() => ({ loaded: false }));
vi.mock('../../../../src/features/kanban/StaffGearButton.vue', () => {
  gearModule.loaded = true;
  return {
    __esModule: true,
    default: { name: 'StaffGearButton', template: '<button data-staff-gear />' },
  };
});

import App from '../../../../src/App.vue';
import { AUTH_STATE } from '../../../../src/constants/states';
import { useAuthStore } from '../../../../src/stores/auth-store';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../../src/composables/useRepository';

function makeRepo() {
  let settings: Record<string, unknown> = {};
  const doc = () => ({
    doc: {
      owner: 'stormbox', documentType: 'user-settings', version: 1, settings, updatedAt: {},
    },
    remoteNodeId: null,
  });
  return {
    subscribe() { return () => {}; },
    async getSettings() { return doc(); },
    async applySettingsPatch(_accountId, patch) { settings = { ...settings, ...patch }; return doc(); },
    async listAccounts() { return []; },
    async listFolders() { return []; },
    async listMessagesForView() { return []; },
    async queryViewProgress() { return { total: 0, covered: 0, percent: 0 }; },
    async ensureFolderWindow() { return { total: 0, fetched: 0 }; },
    async ensureMessageBodies() { return { fetched: 0 }; },
    async getMessageBodyForDisplay() { return null; },
    async ensureFolderTree() { return { count: 0 }; },
    async listAddressbooks() { return []; },
    async listContacts() { return []; },
    async listIdentities() { return []; },
  };
}

const mounted: Array<{ unmount: () => void }> = [];

function mountApp() {
  const wrapper = mount(App, {
    attachTo: document.body,
    global: {
      stubs: {
        LoginGate: { template: '<div />' },
        FolderTree: { template: '<aside />' },
        MessageList: { props: ['quickFilterQuery'], template: '<section class="msg-list">list</section>' },
        MessageView: { template: '<section class="message-view">view</section>' },
        ComposeDialog: { template: '<div />' },
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
  localStorage.clear();
  localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  const authStore = useAuthStore();
  authStore.status = AUTH_STATE.CONNECTED;
  authStore.accountId = 1;
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  __resetRepositoryForTests();
});

describe('staff gear loading', () => {
  it('never evaluates the gear module for a non-staff session, and loads it once for staff', async () => {
    const authStore = useAuthStore();
    authStore.email = 'someone@gmail.com';
    const wrapper = mountApp();
    await flushPromises();
    expect(gearModule.loaded).toBe(false);
    expect(wrapper.find('[data-staff-gear]').exists()).toBe(false);

    authStore.email = 'boss@thunderbird.net';
    await vi.waitFor(() => {
      expect(wrapper.find('[data-staff-gear]').exists()).toBe(true);
    });
    expect(gearModule.loaded).toBe(true);
  });
});
