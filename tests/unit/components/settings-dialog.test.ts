// @vitest-environment happy-dom

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
import { AUTH_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useSettingsStore } from '../../../src/stores/settings-store';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';

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

function dialog() {
  return document.body.querySelector('[data-settings-dialog]') as HTMLElement | null;
}

async function openSettings(wrapper: ReturnType<typeof mountApp>) {
  await wrapper.get('[data-settings-gear]').trigger('click');
  await flushPromises();
  const panel = dialog();
  if (!panel) throw new Error('settings dialog did not open');
  return panel;
}

let matchesLight = false;

beforeEach(() => {
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
  localStorage.clear();
  localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  matchesLight = false;
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return matchesLight; },
    addEventListener() {},
    removeEventListener() {},
  })));
  const authStore = useAuthStore();
  authStore.status = AUTH_STATE.CONNECTED;
  authStore.accountId = 1;
  authStore.email = 'someone@gmail.com';
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  __resetRepositoryForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('settings gear and dialog', () => {
  it('every signed-in user gets a Settings gear that opens a titled dialog', async () => {
    const wrapper = mountApp();
    await flushPromises();

    const gear = wrapper.get('[data-settings-gear]');
    expect(gear.attributes('aria-label')).toBe('Settings');
    expect(gear.classes()).toContain('quick-filter__action');
    expect(dialog()).toBeNull();

    const panel = await openSettings(wrapper);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.querySelector('h2')!.textContent).toBe('Settings');
    expect(document.activeElement).toBe(panel);
  });

  it('non-staff see exactly the shortcut picker and the follow-system switch', async () => {
    const wrapper = mountApp();
    await flushPromises();
    const panel = await openSettings(wrapper);

    const titles = Array.from(panel.querySelectorAll('.settings-dialog__row-title'))
      .map((el) => el.textContent);
    expect(titles).toEqual(['Keyboard shortcuts', 'Follow system theme']);
    expect(panel.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(panel.querySelector('[data-system-theme-toggle]')).not.toBeNull();
    expect(panel.querySelector('hr')).toBeNull();
    expect(panel.textContent).not.toContain('Staff settings');
    expect(panel.querySelector('[data-kanban-unlock-code]')).toBeNull();
  });

  it('staff get a rule and Staff settings with the feature code below', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();
    const panel = await openSettings(wrapper);

    await vi.waitFor(() => {
      expect(panel.querySelector('[data-staff-settings]')).not.toBeNull();
    });
    expect(panel.querySelector('hr')).not.toBeNull();
    expect(panel.querySelector('h3')!.textContent).toBe('Staff settings');
    const markers = Array.from(panel.querySelectorAll(
      '[data-system-theme-toggle], hr, h3, [data-kanban-unlock-code]',
    ));
    expect(markers.map((el) => el.getAttribute('data-system-theme-toggle') != null
      ? 'system-theme'
      : el.getAttribute('data-kanban-unlock-code') != null ? 'code' : el.tagName.toLowerCase()))
      .toEqual(['system-theme', 'hr', 'h3', 'code']);
  });

  it('the scheme radio persists shortcutScheme and re-labels the Quick Filter badge', async () => {
    const wrapper = mountApp();
    await flushPromises();
    expect(wrapper.get('.quick-filter__shortcut').text()).toBe('/');
    const panel = await openSettings(wrapper);

    const web = panel.querySelector('[data-shortcut-scheme="web"]')!;
    const thunderbird = panel.querySelector('[data-shortcut-scheme="thunderbird"]') as HTMLButtonElement;
    expect(web.getAttribute('aria-checked')).toBe('true');
    expect(thunderbird.getAttribute('aria-checked')).toBe('false');
    expect(panel.textContent).toContain('C new message');

    thunderbird.click();
    await flushPromises();

    expect(thunderbird.getAttribute('aria-checked')).toBe('true');
    expect(web.getAttribute('aria-checked')).toBe('false');
    expect(useSettingsStore().get('shortcutScheme')).toBe('thunderbird');
    expect(JSON.parse(localStorage.getItem('stormbox.settings.v1')!))
      .toMatchObject({ shortcutScheme: 'thunderbird' });
    expect(panel.textContent).toContain('Ctrl+N or Ctrl+M new message');
    expect(wrapper.get('.quick-filter__shortcut').text()).toBe('Ctrl+K');
  });

  it('follow-system on hides the theme toggle; off restores it with an explicit theme equal to the resolved one', async () => {
    matchesLight = true;
    const wrapper = mountApp();
    await flushPromises();

    expect(useSettingsStore().get('theme')).toBe('system');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(wrapper.find('.theme-toggle').exists()).toBe(false);

    const panel = await openSettings(wrapper);
    const toggle = panel.querySelector('[data-system-theme-toggle]') as HTMLButtonElement;
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    toggle.click();
    await flushPromises();

    // Nothing flips on screen: the explicit theme is the one already resolved.
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(useSettingsStore().get('theme')).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(wrapper.find('.theme-toggle').exists()).toBe(true);
    expect(wrapper.get('.theme-toggle').attributes('aria-label')).toBe('Switch to dark mode');

    await wrapper.get('.theme-toggle').trigger('click');
    await flushPromises();
    expect(useSettingsStore().get('theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    toggle.click();
    await flushPromises();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(useSettingsStore().get('theme')).toBe('system');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(wrapper.find('.theme-toggle').exists()).toBe(false);
  });

  it('closes on Escape, on the backdrop and from its close button', async () => {
    const wrapper = mountApp();
    await flushPromises();

    await openSettings(wrapper);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(dialog()).toBeNull();

    await openSettings(wrapper);
    (document.body.querySelector('.settings-dialog') as HTMLElement).click();
    await nextTick();
    expect(dialog()).toBeNull();

    const panel = await openSettings(wrapper);
    (panel.querySelector('[aria-label="Close settings"]') as HTMLButtonElement).click();
    await nextTick();
    expect(dialog()).toBeNull();
  });
});
