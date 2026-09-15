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
import { BEACON_IDS } from '../../../src/constants/feature-beacons';
import { AUTH_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import { useFeatureBeaconsStore } from '../../../src/stores/feature-beacons-store';
import { useFeatureFlagsStore } from '../../../src/stores/feature-flags-store';
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
    async ensureIdentities() {},
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
  localStorage.setItem('stormbox.whatsNewSeen.2026-09-compose', '1');
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
  authStore.recoveryEmail = 'someone@gmail.com';
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
    expect(gear.classes()).toContain('app-spaces__item');
    expect(dialog()).toBeNull();

    const panel = await openSettings(wrapper);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.querySelector('h2')!.textContent).toBe('Settings');
    expect(document.activeElement).toBe(panel);
  });

  it('non-staff see exactly the shortcut picker, the follow-system switch and the Welcome button', async () => {
    const wrapper = mountApp();
    await flushPromises();
    const panel = await openSettings(wrapper);

    const titles = Array.from(panel.querySelectorAll('.settings-dialog__row-title'))
      .map((el) => el.textContent);
    expect(titles).toEqual(['Keyboard shortcuts', 'Follow system theme', 'Welcome & shortcuts']);
    expect(panel.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(panel.querySelector('[data-system-theme-toggle]')).not.toBeNull();
    expect(panel.querySelector('[data-show-welcome]')!.textContent!.trim()).toBe('Show welcome');
    expect(panel.querySelector('hr')).toBeNull();
    expect(panel.textContent).not.toContain('Staff settings');
    expect(panel.querySelector('[data-palette-toggle]')).toBeNull();
    expect(panel.querySelector('[data-refresh-beacons]')).toBeNull();
    expect(panel.querySelector('[data-feature-code]')).toBeNull();
  });

  it('staff get a feature-code box; a wrong code is rejected and enables nothing, Enter submits', async () => {
    useAuthStore().recoveryEmail = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();
    const panel = await openSettings(wrapper);
    const input = await vi.waitFor(() => {
      const el = panel.querySelector<HTMLInputElement>('[data-feature-code]');
      if (!el) throw new Error('feature code box not rendered');
      return el;
    });
    const submit = panel.querySelector<HTMLButtonElement>('[data-feature-code-submit]')!;
    expect(submit.textContent!.trim()).toBe('Activate');
    expect(submit.disabled).toBe(true);
    expect(panel.querySelector('[role="alert"]')).toBeNull();

    input.value = 'no-such-feature';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(submit.disabled).toBe(false);

    input.form!.requestSubmit();
    await flushPromises();
    const alert = panel.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Unknown feature code');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(dialog()).not.toBeNull();
    expect(useFeatureFlagsStore().enabled).toEqual([]);
    expect(localStorage.getItem('stormbox.featureFlags.1.v1')).toBeNull();

    // Editing the code clears the rejection.
    input.value = 'no-such-feature-2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });

  it('staff can restart a finished beacon round from Settings, which closes to show it', async () => {
    useAuthStore().recoveryEmail = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();
    const beaconStore = useFeatureBeaconsStore();
    expect(beaconStore.enabled).toBe(false);
    expect(wrapper.find('.beacon-menu').exists()).toBe(false);

    const panel = await openSettings(wrapper);
    const refresh = await vi.waitFor(() => {
      const button = panel.querySelector<HTMLButtonElement>('[data-refresh-beacons]');
      if (!button) throw new Error('refresh button not rendered');
      return button;
    });
    expect(refresh.textContent!.trim()).toBe('Refresh beacons');

    refresh.click();
    await flushPromises();

    expect(dialog()).toBeNull();
    expect(beaconStore.enabled).toBe(true);
    expect(beaconStore.sessions).toBe(1);
    expect(beaconStore.count).toBe(BEACON_IDS.length);
    expect(localStorage.getItem('stormbox.whatsNewSeen.2026-09-compose')).toBeNull();
    expect(wrapper.get('.beacon-menu').text()).toContain(`${BEACON_IDS.length} new`);
  });

  it('shows no staff section when the account has no recovery_email claim', async () => {
    useAuthStore().recoveryEmail = null;
    const wrapper = mountApp();
    await flushPromises();
    const panel = await openSettings(wrapper);
    expect(panel.querySelector('[data-staff-settings]')).toBeNull();
    expect(panel.textContent).not.toContain('Staff settings');
  });

  it('the gear sits at the foot of the spaces rail above the sidebar toggle', async () => {
    const wrapper = mountApp();
    await flushPromises();

    expect(wrapper.find('.quick-filter__actions [data-settings-gear]').exists()).toBe(false);
    const rail = wrapper.get('.app-spaces__bottom-actions');
    const children = Array.from(rail.element.children);
    expect(children[0]?.matches('[data-settings-gear]')).toBe(true);
    expect(children[1]?.getAttribute('aria-label')).toBe('Hide folder list');
  });

  it('staff get a rule and Staff settings with the palette switch below', async () => {
    useAuthStore().recoveryEmail = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();
    const panel = await openSettings(wrapper);

    await vi.waitFor(() => {
      expect(panel.querySelector('[data-staff-settings]')).not.toBeNull();
    });
    expect(panel.querySelector('hr')).not.toBeNull();
    expect(panel.querySelector('h3')!.textContent).toBe('Staff settings');
    const markers = Array.from(panel.querySelectorAll(
      '[data-system-theme-toggle], hr, h3, [data-palette-toggle]',
    ));
    expect(markers.map((el) => el.getAttribute('data-system-theme-toggle') != null
      ? 'system-theme'
      : el.getAttribute('data-palette-toggle') != null ? 'palette' : el.tagName.toLowerCase()))
      .toEqual(['system-theme', 'hr', 'h3', 'palette']);
    const titles = Array.from(panel.querySelectorAll('[data-staff-settings] .settings-dialog__row-title'))
      .map((el) => el.textContent);
    expect(titles).toEqual(['Bolt colors', 'Feature beacons']);
  });

  it('the Bolt colors switch persists the palette and flags <html>', async () => {
    useAuthStore().recoveryEmail = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();
    const panel = await openSettings(wrapper);
    const toggle = await vi.waitFor(() => {
      const button = panel.querySelector<HTMLButtonElement>('[data-palette-toggle]');
      if (!button) throw new Error('palette switch not rendered');
      return button;
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    toggle.click();
    await flushPromises();
    expect(useSettingsStore().get('palette')).toBe('bolt');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.classList.contains('palette-bolt')).toBe(true);

    toggle.click();
    await flushPromises();
    expect(useSettingsStore().get('palette')).toBe('classic');
    expect(document.documentElement.classList.contains('palette-bolt')).toBe(false);
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

  it('holds the mail shortcuts while open and hands them back on close', async () => {
    const wrapper = mountApp();
    await flushPromises();
    const composeStore = useComposeStore();
    const pressC = () => {
      const event = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event;
    };

    await openSettings(wrapper);
    expect(pressC().defaultPrevented).toBe(false);
    expect(composeStore.isOpen).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(dialog()).toBeNull();
    expect(pressC().defaultPrevented).toBe(true);
    expect(composeStore.isOpen).toBe(true);
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
