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

// Records whether the staff chunks (the dialog section with the kanban
// seed, and the celebration host with fireworks and the audio clip) were
// ever evaluated.
const staffModules = vi.hoisted(() => ({ section: false, celebration: false }));
vi.mock('../../../../src/features/kanban/StaffSettingsSection.vue', () => {
  staffModules.section = true;
  return {
    __esModule: true,
    default: { name: 'StaffSettingsSection', template: '<div data-staff-settings />' },
  };
});
vi.mock('../../../../src/features/kanban/KanbanCelebration.vue', () => {
  staffModules.celebration = true;
  return {
    __esModule: true,
    default: { name: 'KanbanCelebration', template: '<div data-kanban-celebration />' },
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

describe('staff chunk loading', () => {
  it('renders the gear and dialog for a non-staff session without evaluating any staff module', async () => {
    const authStore = useAuthStore();
    authStore.email = 'someone@gmail.com';
    const wrapper = mountApp();
    await flushPromises();
    expect(wrapper.find('[data-settings-gear]').exists()).toBe(true);

    await wrapper.get('[data-settings-gear]').trigger('click');
    await flushPromises();
    const dialog = document.body.querySelector('[data-settings-dialog]');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(dialog!.querySelector('[data-system-theme-toggle]')).not.toBeNull();
    expect(dialog!.querySelector('[data-staff-settings]')).toBeNull();
    expect(staffModules.section).toBe(false);
    expect(staffModules.celebration).toBe(false);

    // Becoming staff loads both: the celebration host right away, the
    // section once the dialog shows it.
    authStore.email = 'boss@thunderbird.net';
    await vi.waitFor(() => {
      expect(dialog!.querySelector('[data-staff-settings]')).not.toBeNull();
    });
    expect(staffModules.section).toBe(true);
    expect(staffModules.celebration).toBe(true);
  });
});
