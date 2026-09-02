// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

const audio = vi.hoisted(() => {
  let endClip: () => void = () => {};
  return {
    DEFAULT_CELEBRATION_VOLUME: 0.9,
    preloadCelebrationAudio: vi.fn(() => null),
    playCelebrationAudio: vi.fn(() => Promise.resolve()),
    whenCelebrationAudioEnds: vi.fn(() => new Promise<void>((resolve) => { endClip = resolve; })),
    endClip: () => endClip(),
    getCelebrationVolume: vi.fn(() => 0.9),
    setCelebrationVolume: vi.fn(),
    onCelebrationVolumeChange: vi.fn(() => () => {}),
  };
});
vi.mock('../../../../src/features/kanban/celebration/audio', () => audio);

const seed = vi.hoisted(() => ({
  seedKanbanFolders: vi.fn(async () => ({ needsReplyFolderId: 1, blockedFolderId: 2, created: 38 })),
}));
vi.mock('../../../../src/features/kanban/kanban-seed', () => seed);

// The canvas animation needs rAF + 2D context; the stub only records
// that the overlay was shown, and ends the show when clicked.
vi.mock('../../../../src/features/kanban/celebration/FireworksOverlay.vue', () => ({
  default: {
    name: 'FireworksOverlay',
    emits: ['done'],
    template: '<div data-kanban-fireworks @click="$emit(\'done\')" />',
  },
}));

import App from '../../../../src/App.vue';
import StaffGearButton from '../../../../src/features/kanban/StaffGearButton.vue';
import { kanbanStorageKey, useKanbanStore } from '../../../../src/features/kanban/kanban-store';
import { AUTH_STATE } from '../../../../src/constants/states';
import { useAuthStore } from '../../../../src/stores/auth-store';
import { useMailStore } from '../../../../src/stores/mail-store';
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

function dialog() {
  return document.body.querySelector('[data-kanban-unlock-dialog]') as HTMLElement | null;
}

/** The board is an async chunk; its import settles on its own schedule. */
async function expectBoard(wrapper: ReturnType<typeof mountApp>) {
  await vi.waitFor(() => {
    expect(wrapper.find('[data-testid="kanban-board"]').exists()).toBe(true);
  });
}

async function submitCode(code: string) {
  const input = dialog()!.querySelector('[data-kanban-unlock-code]') as HTMLInputElement;
  input.value = code;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  dialog()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
  localStorage.clear();
  localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  audio.preloadCelebrationAudio.mockClear();
  audio.playCelebrationAudio.mockClear();
  audio.setCelebrationVolume.mockClear();
  seed.seedKanbanFolders.mockClear();
  const authStore = useAuthStore();
  authStore.status = AUTH_STATE.CONNECTED;
  authStore.accountId = 1;
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  __resetRepositoryForTests();
  vi.restoreAllMocks();
});

describe('staff gear in App', () => {
  it('is absent for non-staff and nothing kanban-related renders', async () => {
    useAuthStore().email = 'someone@gmail.com';
    const wrapper = mountApp();
    await flushPromises();

    expect(wrapper.find('[data-staff-gear]').exists()).toBe(false);
    expect(wrapper.find('.msg-list').exists()).toBe(true);
    expect(wrapper.find('[data-testid="kanban-board"]').exists()).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('is absent when the account has no email claim (password login)', async () => {
    useAuthStore().email = null;
    const wrapper = mountApp();
    await flushPromises();
    expect(wrapper.find('[data-staff-gear]').exists()).toBe(false);
  });

  it('sits directly left of the avatar for staff and leaves the list untouched while locked', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();

    const actions = wrapper.get('.quick-filter__actions');
    const children = Array.from(actions.element.children);
    const gearIndex = children.findIndex((el) => el.matches('[data-staff-gear]'));
    expect(gearIndex).toBeGreaterThan(0);
    expect(children[gearIndex + 1]?.classList.contains('account-menu')).toBe(true);
    expect(children[gearIndex - 1]?.classList.contains('theme-toggle')).toBe(true);
    expect(wrapper.find('.msg-list').exists()).toBe(true);
    expect(wrapper.find('[data-testid="kanban-board"]').exists()).toBe(false);
  });

  it('stays out of the top bar below 700px, where a fifth action overflows the shell', () => {
    // The bar's end cluster fits five 36px actions only from ~670px up; the
    // sidebar-layout e2e pins the 640px and 340px layouts against overflow.
    const source = readFileSync(resolve(process.cwd(), 'src/features/kanban/StaffGearButton.vue'), 'utf8');
    expect(source).toMatch(/class="quick-filter__action staff-gear"/);
    expect(source).toMatch(
      /@media\s*\(max-width:\s*699px\)\s*\{[\s\S]*?\.staff-gear\s*\{[\s\S]*?display:\s*none;/,
    );
  });

  it('gear opens a code dialog; a wrong code is rejected and changes nothing', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();

    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('[data-kanban-unlock-code]')).not.toBeNull();
    expect(dialog()!.querySelector('[role="switch"]')).toBeNull();
    // Opening the dialog is what buffers the clip, before any code is typed.
    expect(audio.preloadCelebrationAudio).toHaveBeenCalledTimes(1);

    await submitCode('kanbans');
    const alert = dialog()!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Unknown feature code');
    const input = dialog()!.querySelector('[data-kanban-unlock-code]') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(useKanbanStore().enabled).toBe(false);
    expect(wrapper.find('.msg-list').exists()).toBe(true);
    expect(audio.playCelebrationAudio).not.toHaveBeenCalled();
    expect(seed.seedKanbanFolders).not.toHaveBeenCalled();
    expect(localStorage.getItem(kanbanStorageKey(1))).toBeNull();

    // Editing the code retracts the rejection until the next submit.
    input.value = 'kanban';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('the code "kanban" unlocks: board replaces the list, music + fireworks + seeding start together', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();
    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();

    let seedResolve: (v: any) => void = () => {};
    seed.seedKanbanFolders.mockImplementationOnce(() => new Promise((resolve) => { seedResolve = resolve; }));

    await submitCode('  Kanban ');

    const kanban = useKanbanStore();
    expect(kanban.unlocked).toBe(true);
    expect(kanban.enabled).toBe(true);
    expect(dialog()).toBeNull();
    expect(audio.playCelebrationAudio).toHaveBeenCalledTimes(1);
    expect(seed.seedKanbanFolders).toHaveBeenCalledTimes(1);
    expect(kanban.seedState).toBe('running');
    expect(document.body.querySelector('[data-kanban-fireworks]')).not.toBeNull();
    expect(wrapper.find('.msg-list').exists()).toBe(false);

    seedResolve({ needsReplyFolderId: 1, blockedFolderId: 2, created: 38 });
    await flushPromises();
    await expectBoard(wrapper);
    expect(kanban.seedState).toBe('done');
    expect(JSON.parse(localStorage.getItem(kanbanStorageKey(1))!)).toMatchObject({ unlocked: true, enabled: true });
  });

  it('docks a volume pill for the whole celebration: it outlives the fireworks until the clip ends', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();
    expect(document.body.querySelector('[data-kanban-volume]')).toBeNull();
    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    await submitCode('kanban');

    const pill = document.body.querySelector('[data-kanban-volume]') as HTMLElement;
    expect(pill).not.toBeNull();
    const slider = pill.querySelector('[data-kanban-volume-slider]') as HTMLInputElement;
    expect(slider.getAttribute('aria-label')).toBe('Celebration volume');
    slider.value = '0.35';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(audio.setCelebrationVolume).toHaveBeenCalledWith(0.35);

    // Fireworks end first; the music is still going, so the pill stays.
    (document.body.querySelector('[data-kanban-fireworks]') as HTMLElement).click();
    await flushPromises();
    expect(document.body.querySelector('[data-kanban-fireworks]')).toBeNull();
    expect(document.body.querySelector('[data-kanban-volume]')).not.toBeNull();

    audio.endClip();
    await flushPromises();
    expect(document.body.querySelector('[data-kanban-volume]')).toBeNull();

    // Later toggles never bring it back.
    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    const toggle = dialog()!.querySelector('[role="switch"]') as HTMLButtonElement;
    toggle.click();
    await flushPromises();
    toggle.click();
    await flushPromises();
    expect(document.body.querySelector('[data-kanban-volume]')).toBeNull();
  });

  it('after unlocking the gear shows a switch; toggling never celebrates or seeds again', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    const wrapper = mountApp();
    await flushPromises();
    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    await submitCode('kanban');
    audio.playCelebrationAudio.mockClear();
    seed.seedKanbanFolders.mockClear();

    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    const toggle = dialog()!.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(dialog()!.querySelector('[data-kanban-unlock-code]')).toBeNull();
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    toggle.click();
    await flushPromises();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(useKanbanStore().enabled).toBe(false);
    expect(wrapper.find('.msg-list').exists()).toBe(true);
    expect(wrapper.find('[data-testid="kanban-board"]').exists()).toBe(false);

    toggle.click();
    await flushPromises();
    expect(useKanbanStore().enabled).toBe(true);
    await expectBoard(wrapper);
    expect(audio.playCelebrationAudio).not.toHaveBeenCalled();
    expect(seed.seedKanbanFolders).not.toHaveBeenCalled();
  });

  it('a persisted flag renders the board on load without any celebration', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    localStorage.setItem(kanbanStorageKey(1), JSON.stringify({ unlocked: true, enabled: true, columns: [null, null] }));
    const wrapper = mountApp();
    await flushPromises();
    await expectBoard(wrapper);
    expect(wrapper.find('.msg-list').exists()).toBe(false);
    expect(audio.playCelebrationAudio).not.toHaveBeenCalled();
    expect(seed.seedKanbanFolders).not.toHaveBeenCalled();
  });

  it('a column selection hides the reading pane, exactly like the list\'s checkbox selection', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    localStorage.setItem(kanbanStorageKey(1), JSON.stringify({ unlocked: true, enabled: true, columns: [null, null] }));
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;
    const wrapper = mountApp();
    await flushPromises();
    await expectBoard(wrapper);
    expect(wrapper.find('.message-view').exists()).toBe(true);
    expect(wrapper.find('.shell').classes()).toContain('shell--kanban-compact');

    const kanban = useKanbanStore();
    kanban.setSelection(3, new Set([7, 8]));
    await nextTick();
    expect(wrapper.find('.message-view').exists()).toBe(false);
    expect(wrapper.find('.shell').classes()).toContain('shell--message-view-hidden');
    expect(wrapper.find('.shell').classes()).not.toContain('shell--kanban-compact');

    kanban.clearSelection();
    await nextTick();
    expect(wrapper.find('.message-view').exists()).toBe(true);
  });

  it('records a seeding failure without breaking the board', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    seed.seedKanbanFolders.mockRejectedValueOnce(new Error('serverFail'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapper = mountApp();
    await flushPromises();
    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    await submitCode('kanban');

    const kanban = useKanbanStore();
    expect(kanban.seedState).toBe('failed');
    expect(kanban.seedError).toBe('serverFail');
    expect(kanban.enabled).toBe(true);
    await expectBoard(wrapper);
    expect(warn).toHaveBeenCalled();
    // The dialog closed on unlock, so the failure is surfaced where the
    // user is looking: the store's error toast.
    expect(useMailStore().error).toMatch(/sample folders/i);
    expect(useMailStore().error).toMatch(/serverFail/);
  });

  it('offers a retry after a failed seed that does not celebrate again', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    seed.seedKanbanFolders.mockRejectedValueOnce(new Error('serverFail'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapper = mountApp();
    await flushPromises();
    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    await submitCode('kanban');
    await flushPromises();
    expect(useKanbanStore().seedState).toBe('failed');
    audio.playCelebrationAudio.mockClear();
    const fireworksBefore = document.body.querySelectorAll('[data-kanban-fireworks]').length;

    // Reopen the gear: the failure is shown with a retry, no code box.
    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    expect(dialog()!.querySelector('[data-kanban-unlock-code]')).toBeNull();
    expect(dialog()!.textContent).toContain('serverFail');
    const retry = dialog()!.querySelector('[data-kanban-seed-retry]') as HTMLButtonElement;
    expect(retry).not.toBeNull();

    retry.click();
    await flushPromises();
    await flushPromises();

    expect(seed.seedKanbanFolders).toHaveBeenCalledTimes(2);
    expect(useKanbanStore().seedState).toBe('done');
    expect(audio.playCelebrationAudio).not.toHaveBeenCalled();
    expect(document.body.querySelectorAll('[data-kanban-fireworks]')).toHaveLength(fireworksBefore);
    expect(dialog()!.querySelector('[data-kanban-seed-retry]')).toBeNull();
  });
});

describe('KanbanUnlockDialog keyboard', () => {
  it('closes on Escape and on the backdrop, submits on Enter', async () => {
    useAuthStore().email = 'boss@thunderbird.net';
    const wrapper = mount(StaffGearButton, { attachTo: document.body });
    mounted.push(wrapper);
    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    expect(dialog()).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(dialog()).toBeNull();

    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    (document.body.querySelector('.kanban-unlock') as HTMLElement).click();
    await flushPromises();
    expect(dialog()).toBeNull();

    await wrapper.get('[data-staff-gear]').trigger('click');
    await flushPromises();
    const input = dialog()!.querySelector('[data-kanban-unlock-code]') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = 'kanban';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(useKanbanStore().enabled).toBe(true);
    expect(dialog()).toBeNull();
  });
});
