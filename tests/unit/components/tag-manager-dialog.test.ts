// @vitest-environment happy-dom

/**
 * The tag manager is its own modal (specs/011 MK-6.7): a request from a
 * deep surface opens it over the shell, focus lands in the new-tag name
 * field, mail shortcuts are held while it is up, and Escape, the scrim
 * and the close button dismiss it. Settings does not host it.
 */

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

import App from '../../../src/App.vue';
import { requestTagManager } from '../../../src/composables/useTagManagerRequest';
import { AUTH_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import { LATEST_BEACON_SEQ } from '../../../src/constants/feature-beacons';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';

function makeRepo() {
  // Onboarding done: Welcome dismissed and every beacon seen.
  let settings: Record<string, unknown> = { onboarding: { beaconsSeenThrough: LATEST_BEACON_SEQ } };
  const doc = () => ({
    doc: {
      owner: 'stormbox', documentType: 'user-settings', version: 1, settings, updatedAt: {},
    },
    remoteNodeId: null,
  });
  return {
    subscribe() { return () => {}; },
    async getSettings() { return doc(); },
    async applySettingsPatch(_accountId: number, patch: Record<string, unknown>) {
      settings = { ...settings, ...patch };
      return doc();
    },
    async listAccounts() { return []; },
    async listFolders() { return []; },
    async listMessagesForView() { return []; },
    async listMessageKeywords() { return []; },
    async queryViewProgress() { return { total: 0, covered: 0, percent: 0 }; },
    async ensureFolderWindow() { return { total: 0, fetched: 0 }; },
    async ensureMessageBodies() { return { fetched: 0 }; },
    async getMessageBodyForDisplay() { return null; },
    async ensureFolderTree() { return { count: 0 }; },
    async listAddressbooks() { return []; },
    async listContacts() { return []; },
    async listIdentities() { return []; },
    async ensureIdentities() {},
    async insertPendingMutation() { return { id: 1 }; },
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

function dialog() {
  return document.body.querySelector('[data-tag-manager]') as HTMLElement | null;
}

async function openTagManager() {
  requestTagManager();
  await flushPromises();
  const panel = dialog();
  if (!panel) throw new Error('tag manager did not open');
  return panel;
}

beforeEach(() => {
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })));
  const authStore = useAuthStore();
  authStore.status = AUTH_STATE.CONNECTED;
  authStore.accountId = 1;
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  __resetRepositoryForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TagManagerDialog', () => {
  it('opens on request as a titled modal with the editor inside and focus in the name field', async () => {
    mountApp();
    await flushPromises();
    expect(dialog()).toBeNull();

    const panel = await openTagManager();
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.querySelector('h2')!.textContent).toBe('Tags');
    expect(panel.getAttribute('aria-labelledby')).toBe(panel.querySelector('h2')!.id);
    expect(panel.querySelector('[data-tag-editor]')).not.toBeNull();
    expect(panel.querySelector('ol')!.getAttribute('aria-labelledby')).toBe(panel.querySelector('h2')!.id);
    expect(panel.querySelectorAll('[data-tag-setting]')).toHaveLength(5);
    await nextTick();
    expect(document.activeElement).toBe(panel.querySelector('[data-tag-editor-name]'));
    // Settings is not open and did not gain the editor.
    expect(document.body.querySelector('[data-settings-dialog]')).toBeNull();
  });

  it('holds the mail shortcuts while open and closes on Escape, the scrim and its button', async () => {
    mountApp();
    await flushPromises();
    const composeStore = useComposeStore();
    const pressC = () => {
      const event = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event;
    };

    await openTagManager();
    expect(pressC().defaultPrevented).toBe(false);
    expect(composeStore.isOpen).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(dialog()).toBeNull();
    expect(pressC().defaultPrevented).toBe(true);
    expect(composeStore.isOpen).toBe(true);

    await openTagManager();
    (document.body.querySelector('.tag-manager') as HTMLElement).click();
    await nextTick();
    expect(dialog()).toBeNull();

    const panel = await openTagManager();
    (panel.querySelector('[aria-label="Close tags"]') as HTMLButtonElement).click();
    await nextTick();
    expect(dialog()).toBeNull();

    // A second request reopens it.
    await openTagManager();
    expect(dialog()).not.toBeNull();
  });
});
