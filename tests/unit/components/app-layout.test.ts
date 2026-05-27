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
import {
  ACCOUNTS_URL,
  APPOINTMENT_URL,
  BUG_REPORT_URL,
  FEEDBACK_URL,
  SEND_URL,
} from '../../../src/defines.js';
import { useAuthStore } from '../../../src/stores/auth-store.js';
import { useMailStore } from '../../../src/stores/mail-store.js';
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/useRepository.js';

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

const mountedWrappers = [];

function mountApp() {
  const wrapper = mount(App, {
    global: {
      stubs: {
        LoginGate: { template: '<div />' },
        FolderTree: { template: '<aside />' },
        MessageList: {
          props: ['quickFilterQuery'],
          template: '<section class="msg-list" :data-filter="quickFilterQuery">list</section>',
        },
        MessageView: { template: '<section class="message-view">view</section>' },
        ComposeDialog: { template: '<div />' },
        ContactsView: { template: '<section />' },
      },
    },
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

function makePointerEvent(type: string, clientX: number, button = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: clientX });
  Object.defineProperty(event, 'button', { value: button });
  return event;
}

function dispatchClick(target: EventTarget) {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
}

function setWindowWidth(width: number, dispatchResize = false) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  if (dispatchResize) {
    window.dispatchEvent(new Event('resize'));
  }
}

beforeEach(() => {
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
  window.localStorage?.clear();
  setWindowWidth(1280);
  const authStore = useAuthStore();
  authStore.status = AUTH_STATE.CONNECTED;
  authStore.accountId = 1;
});

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) {
    wrapper.unmount();
  }
  vi.useRealTimers();
  __resetRepositoryForTests();
});

describe('App mail layout', () => {
  it('renders a centered quick filter above the mail columns and passes it to the message list', async () => {
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.quick-filter').exists()).toBe(true);
    expect(wrapper.find('.quick-filter').element).toBe(wrapper.find('.shell').element.firstElementChild);

    await wrapper.get('.quick-filter__input').setValue('alice');
    await nextTick();

    expect(wrapper.get('.msg-list').attributes('data-filter')).toBe('alice');
    expect(mailStore.selectedMessageId).toBeNull();
  });

  it('focuses and selects the quick filter with Ctrl+K', async () => {
    const wrapper = mountApp();
    await nextTick();

    await wrapper.get('.quick-filter__input').setValue('alice');
    const input = wrapper.get('.quick-filter__input').element as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');
    const selectSpy = vi.spyOn(input, 'select');
    input.blur();

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }));
    await nextTick();

    expect(focusSpy).toHaveBeenCalledOnce();
    expect(selectSpy).toHaveBeenCalledOnce();
  });

  it('renders a Thundermail menu linking to Thunderbird Appointment and Send', async () => {
    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.get('.app-menu__button').text()).toContain('Thundermail');
    expect(wrapper.get('.app-menu__logo').attributes('src')).toBe('/logo.png');

    const items = wrapper.findAll('.app-menu__popover .app-menu__item');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain('Thunderbird Appointment');
    expect(items[0].attributes('href')).toBe(APPOINTMENT_URL);
    expect(items[1].text()).toContain('Thunderbird Send');
    expect(items[1].attributes('href')).toBe(SEND_URL);
  });

  it('closes the Thundermail menu when clicking outside it', async () => {
    const wrapper = mountApp();
    await nextTick();

    const appMenu = wrapper.get('.app-menu').element as HTMLDetailsElement;
    appMenu.open = true;

    dispatchClick(document.body);
    await nextTick();

    expect(appMenu.open).toBe(false);
  });

  it('renders bug report and feedback links next to the theme toggle', async () => {
    const wrapper = mountApp();
    await nextTick();

    const bugLink = wrapper.get('.quick-filter__action[aria-label="Report a bug"]');
    expect(bugLink.attributes('href')).toBe(BUG_REPORT_URL);
    expect(bugLink.attributes('target')).toBe('_blank');
    expect(bugLink.get('svg').exists()).toBe(true);

    const feedbackLink = wrapper.get('.quick-filter__action[aria-label="Give feedback"]');
    expect(feedbackLink.attributes('href')).toBe(FEEDBACK_URL);
    expect(feedbackLink.attributes('target')).toBe('_blank');

    expect(wrapper.get('.theme-toggle').classes()).toContain('quick-filter__action');
  });

  it('shows the user identity, account settings link, and a log out button in the top-right avatar menu', async () => {
    const authStore = useAuthStore();
    authStore.username = 'alice@example.com';

    const wrapper = mountApp();
    await nextTick();

    const avatarMenu = wrapper.get('.account-menu');
    expect(avatarMenu.get('.account-menu__button').attributes('aria-label')).toBe('Open account menu');
    expect(avatarMenu.text()).toContain('alice@example.com');

    const settingsLink = avatarMenu.get('.account-menu__item[href]');
    expect(settingsLink.attributes('href')).toBe(ACCOUNTS_URL);
    expect(settingsLink.text()).toContain('Account Settings');

    const logoutButton = avatarMenu.get('button.account-menu__item');
    expect(logoutButton.text()).toContain('Log Out');

    expect(wrapper.find('.sidebar__signout').exists()).toBe(false);
  });

  it('hides the message view and expands the message list when nothing is selected', async () => {
    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(false);
    expect(wrapper.find('.shell').classes()).toContain('shell--message-view-hidden');
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar').exists()).toBe(true);
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');
    expect(wrapper.find('[aria-label="Resize folder list"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Resize message list"]').exists()).toBe(false);
  });

  it('shows the message view for either a viewed message or bulk selection', async () => {
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(true);
    expect(wrapper.find('.shell').classes()).not.toContain('shell--message-view-hidden');
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('[aria-label="Resize message list"]').exists()).toBe(true);

    mailStore.selectedMessageId = null;
    mailStore.selectedIds = new Set([7]);
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(true);
    expect(wrapper.find('.shell').classes()).not.toContain('shell--message-view-hidden');
  });

  it('lets the spaces toolbar hide and restore the folder list', async () => {
    const wrapper = mountApp();
    await nextTick();

    await wrapper.get('[aria-label="Hide folder list"]').trigger('click');
    await nextTick();

    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar').exists()).toBe(true);
    expect(wrapper.find('.sidebar-slot').classes()).toContain('sidebar-slot--hidden');
    expect(wrapper.find('[aria-label="Resize folder list"]').classes())
      .toContain('column-resizer--hidden');

    await wrapper.get('[aria-label="Show folder list"]').trigger('click');
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar').exists()).toBe(true);
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');
  });

  it('auto-hides the folder list at 1024px when a message is selected', async () => {
    vi.useFakeTimers();
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');

    setWindowWidth(1024, true);
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(false);
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).toContain('sidebar-slot--hidden');
    expect(wrapper.find('[aria-label="Show folder list"]').exists()).toBe(true);

    vi.advanceTimersByTime(310);
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(true);
  });

  it('waits for the folder slide before showing the message view in compact layout', async () => {
    vi.useFakeTimers();
    setWindowWidth(900);
    const mailStore = useMailStore();

    const wrapper = mountApp();
    await nextTick();

    mailStore.selectedMessageId = 42;
    await nextTick();

    // Initial frame after selection: the folder list is collapsing and
    // the message view is intentionally deferred so it does not crash
    // into the transition.
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).toContain('sidebar-slot--hidden');
    expect(wrapper.find('.message-view').exists()).toBe(false);

    // After the transition completes the message view becomes visible.
    // We advance comfortably past the transition (the exact boundary
    // is an internal layout knob, not a user-facing contract).
    vi.advanceTimersByTime(400);
    await nextTick();
    expect(wrapper.find('.message-view').exists()).toBe(true);
  });

  it('lets the toggle button change only the current folder-list state', async () => {
    setWindowWidth(900);
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');

    await wrapper.get('[aria-label="Show folder list"]').trigger('click');
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar').exists()).toBe(true);
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');

    setWindowWidth(899, true);
    await nextTick();

    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');
  });

  it('restores the folder list when compact reading no longer applies', async () => {
    vi.useFakeTimers();
    setWindowWidth(900);
    const mailStore = useMailStore();

    const wrapper = mountApp();
    await nextTick();

    mailStore.selectedMessageId = 42;
    await nextTick();
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');

    vi.advanceTimersByTime(310);
    await nextTick();
    expect(wrapper.find('.message-view').exists()).toBe(true);

    mailStore.selectedMessageId = null;
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar').exists()).toBe(true);
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');
  });

  it('restores a responsive-hidden folder list when leaving compact width', async () => {
    vi.useFakeTimers();
    setWindowWidth(900);
    const mailStore = useMailStore();

    const wrapper = mountApp();
    await nextTick();

    mailStore.selectedMessageId = 42;
    await nextTick();
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');

    setWindowWidth(1025, true);
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');

    vi.advanceTimersByTime(360);
    await nextTick();
    expect(wrapper.find('.message-view').exists()).toBe(true);
  });

  it('keeps the folder list visible at 1024px until a message is selected', async () => {
    setWindowWidth(1024);

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar').exists()).toBe(true);
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');
  });

  it('resizes the folder column by dragging its border', async () => {
    const wrapper = mountApp();
    await nextTick();

    const handle = wrapper.get('[aria-label="Resize folder list"]').element;
    handle.dispatchEvent(makePointerEvent('pointerdown', 200));
    window.dispatchEvent(makePointerEvent('pointermove', 260));
    window.dispatchEvent(makePointerEvent('pointerup', 260));
    await nextTick();

    expect(wrapper.get('.shell').attributes('style'))
      .toContain('--folder-list-width: 300px');
  });

  it('resizes the message list column by dragging the message-view border', async () => {
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();

    const handle = wrapper.get('[aria-label="Resize message list"]').element;
    handle.dispatchEvent(makePointerEvent('pointerdown', 300));
    window.dispatchEvent(makePointerEvent('pointermove', 220));
    window.dispatchEvent(makePointerEvent('pointerup', 220));
    await nextTick();

    expect(wrapper.get('.shell').attributes('style'))
      .toContain('--message-list-width: 280px');
  });

  it('toggles the document theme between dark and light and persists the choice (R-8.4)', async () => {
    window.localStorage?.setItem('stormbox.theme.v1', 'dark');

    const wrapper = mountApp();
    await nextTick();

    expect(document.documentElement.dataset.theme).toBe('dark');

    await wrapper.get('.theme-toggle').trigger('click');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('stormbox.theme.v1')).toBe('light');

    await wrapper.get('.theme-toggle').trigger('click');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('stormbox.theme.v1')).toBe('dark');
  });
});
