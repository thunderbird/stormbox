// @vitest-environment happy-dom

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import App from '../../../src/App.vue';
import AppSpaces from '../../../src/components/AppSpaces.vue';
import ContactsView from '../../../src/components/ContactsView.vue';
import { AUTH_STATE } from '../../../src/constants/states';
import {
  ACCOUNTS_URL,
  APPOINTMENT_URL,
  BUG_REPORT_URL,
  FEEDBACK_URL,
  SEND_URL,
} from '../../../src/defines';
import { APP_TITLE } from '../../../src/app-config';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import { useSettingsStore } from '../../../src/stores/settings-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import {
  __setRepositoryForTests,
  __resetRepositoryForTests,
} from '../../../src/composables/useRepository';
import { TOUR_SUBJECT, TOUR_TYPING_MS_PER_CHAR } from '../../../src/composables/featureSpotlightScripts';
import { SPOTLIGHT_TIMING } from '../../../src/composables/useFeatureSpotlight';
import { FEATURE_BEACONS_STORAGE_KEY } from '../../../src/constants/feature-beacons';
import { useFeatureBeaconsStore } from '../../../src/stores/feature-beacons-store';
import type { ContactListRow } from '../../../src/types';
import { stubBeaconLayout, type BeaconLayoutStub } from '../_fixtures/beacon-layout';

// Pointer travel and press precede a step's `prepare`; settle follows it.
const TRAVEL_MS = SPOTLIGHT_TIMING.pointerTravelMs;
const PRESS_MS = SPOTLIGHT_TIMING.pointerPressMs;
const SETTLE_MS = SPOTLIGHT_TIMING.settleMs;

let repoContacts: ContactListRow[] = [];
let restoreContactListLayout: (() => void) | null = null;
let beaconLayout: BeaconLayoutStub | null = null;

// Viewport rects for the controls beacons anchor to; the composer's schedule
// trigger only exists once a compose session is open.
const BEACON_RECTS = {
  '.sidebar__compose': {
    left: 70, top: 60, width: 160, height: 36,
  },
  '.app-spaces [aria-label="Contacts"]': {
    left: 8, top: 120, width: 40, height: 40,
  },
  '.compose-dialog .compose-schedule-menu__trigger': {
    left: 600, top: 500, width: 30, height: 30,
  },
};

// A user who dismissed Welcome before this round and has not seen it.
function seedExistingUser() {
  window.localStorage?.removeItem(WHATS_NEW_KEY);
  beaconLayout = stubBeaconLayout(BEACON_RECTS);
}

async function settleBeacons() {
  await flushPromises();
  await nextTick();
  await flushPromises();
}

function stubContactListLayout() {
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

  // The contacts virtualizer needs viewport and row measurements because
  // happy-dom does not calculate layout.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('contacts__list')) return 510;
      if (this.classList.contains('contacts__row')) return 59;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('contacts__list') ? 800 : 0;
    },
  });

  return () => {
    if (offsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
    } else {
      delete (HTMLElement.prototype as any).offsetHeight;
    }
    if (offsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
    } else {
      delete (HTMLElement.prototype as any).offsetWidth;
    }
  };
}

function makeRepo() {
  let settings: Record<string, unknown> = {};
  return {
    subscribe() { return () => {}; },
    async getSettings() {
      return {
        doc: {
          owner: 'stormbox',
          documentType: 'user-settings',
          version: 1,
          settings,
          updatedAt: {},
        },
        remoteNodeId: null,
      };
    },
    async applySettingsPatch(_accountId, patch) {
      settings = { ...settings, ...patch };
      return {
        doc: {
          owner: 'stormbox',
          documentType: 'user-settings',
          version: 1,
          settings,
          updatedAt: {},
        },
      };
    },
    async listAccounts() { return []; },
    async listFolders() { return []; },
    async listMessagesForView() { return []; },
    async queryViewProgress() { return { total: 0, covered: 0, percent: 0 }; },
    async ensureFolderWindow() { return { total: 0, fetched: 0 }; },
    async ensureMessageBodies() { return { fetched: 0 }; },
    async getMessageBodyForDisplay() { return null; },
    async ensureFolderTree() { return { count: 0 }; },
    async listAddressbooks() { return []; },
    async listContacts() { return repoContacts; },
    async getContact(_accountId, contactId) {
      const contact = repoContacts.find((candidate) => candidate.id === contactId);
      if (!contact) return null;
      return {
        ...contact,
        full_name: contact.display_name,
        emails: contact.email
          ? [{
            mapKey: `email-${contact.id}`,
            position: 0,
            value: contact.email,
            label: null,
            contexts: [],
            pref: 1,
            isPreferred: true,
          }]
          : [],
        phones: [],
        links: [],
        anniversaries: [],
        notes: [],
        organizations: [],
        titles: [],
      };
    },
    async listIdentities() { return []; },
    async ensureIdentities() {},
  };
}

const mountedWrappers = [];

function mountApp() {
  const wrapper = mount(App, {
    attachTo: document.body,
    global: {
      stubs: {
        LoginGate: { template: '<div />' },
        FolderTree: { template: '<aside />' },
        MessageList: {
          props: ['quickFilterQuery'],
          template: '<section class="msg-list" :data-filter="quickFilterQuery">list</section>',
        },
        MessageView: { template: '<section class="message-view">view</section>' },
        // Carries the card the compose spotlights stage, the header controls
        // they press, and the schedule trigger the composeSchedule beacon anchors to.
        ComposeDialog: {
          template: '<div class="compose-dialog"><div class="compose-dialog__card"><button class="icon icon--minimize" /><div class="compose-close-menu" /><input id="compose-subject" /><details class="compose-schedule-menu"><summary class="compose-schedule-menu__trigger">Schedule</summary></details></div></div>',
        },
      },
    },
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

// Spotlight phases chain one timer after another via microtasks, so each
// phase is advanced and flushed on its own.
async function advanceSpotlight(...phasesMs: number[]) {
  for (const ms of phasesMs) {
    vi.advanceTimersByTime(ms);
    await flushPromises();
  }
}

// Steps that poll the DOM (waiting for a dialog or directory) chain many
// short timers; advance in small slices until `done` or the budget runs out.
async function advanceUntil(done: () => boolean, sliceMs = 50, budgetMs = 20_000) {
  for (let elapsed = 0; elapsed < budgetMs && !done(); elapsed += sliceMs) {
    await advanceSpotlight(sliceMs);
  }
  expect(done()).toBe(true);
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

const WELCOME_KEY = 'stormbox.welcomeModalDismissed.v1';
const WHATS_NEW_KEY = 'stormbox.whatsNewSeen.2026-09-compose';
const FEATURE_TITLES = [
  'Compose with confidence',
  'Send on your schedule',
  'Attachments and Clipboard',
  'Organize your mail',
  'Contacts and identities',
  'Smarter recipients',
];

function showMeButton(wrapper: ReturnType<typeof mountApp>, title: string) {
  return wrapper.get(`button[aria-label="Show me: ${title}"]`);
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Escape',
  }));
}

function stubReducedMotion(matches: boolean) {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? matches : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  return () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

beforeEach(() => {
  repoContacts = [];
  setActivePinia(createPinia());
  __setRepositoryForTests(makeRepo());
  document.title = APP_TITLE;
  window.localStorage?.clear();
  window.localStorage?.setItem('stormbox.welcomeModalDismissed.v1', '1');
  window.localStorage?.setItem('stormbox.whatsNewSeen.2026-09-compose', '1');
  setWindowWidth(1280);
  const authStore = useAuthStore();
  authStore.status = AUTH_STATE.CONNECTED;
  authStore.accountId = 1;
});

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) {
    wrapper.unmount();
  }
  restoreContactListLayout?.();
  restoreContactListLayout = null;
  beaconLayout?.restore();
  beaconLayout = null;
  vi.useRealTimers();
  __resetRepositoryForTests();
});

describe('App mail layout', () => {
  it('shows the welcome modal on first login and persists dismissal', async () => {
    window.localStorage?.removeItem(WELCOME_KEY);
    window.localStorage?.removeItem(WHATS_NEW_KEY);

    const wrapper = mountApp();
    await nextTick();

    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain('Welcome to Thundermail');
    expect(wrapper.findAll('.feature-card h3').map((heading) => heading.text())).toEqual(FEATURE_TITLES);
    expect(wrapper.findAll('.feature-card__show')).toHaveLength(6);
    expect(showMeButton(wrapper, 'Send on your schedule').attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).toContain('Keyboard Shortcuts');
    expect(wrapper.findAll('.welcome__shortcut-group h3').map((heading) => heading.text()))
      .toEqual(['Find and compose', 'Navigate', 'Message actions']);
    expect(wrapper.text()).toContain('Ctrl+K');
    expect(wrapper.findAll('.welcome__shortcut-group').at(2)!.findAll('dd').map((row) => row.text()))
      .toEqual(['Archive', 'Delete', 'Delete permanently', 'Mark read or unread', 'Select all', 'Clear selection']);
    expect(wrapper.get('#welcome-scheme-label').text()).toBe('Style');
    const picker = wrapper.get('.welcome [role="radiogroup"]');
    expect(picker.findAll('[role="radio"]').map((radio) => radio.text())).toEqual(['Web', 'Thunderbird']);
    expect(picker.get('[data-shortcut-scheme="web"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.find('.beacon-menu').exists()).toBe(false);

    await wrapper.get('.welcome').trigger('click');
    await nextTick();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(window.localStorage.getItem(WELCOME_KEY)).toBeNull();

    dialog.element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }));
    await nextTick();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(window.localStorage.getItem(WELCOME_KEY)).toBe('1');
    // Welcome covers the announced features, so beacons never follow it.
    expect(window.localStorage.getItem(WHATS_NEW_KEY)).toBe('1');
    expect(wrapper.find('.beacon-menu').exists()).toBe(false);
    expect(wrapper.find('.feature-beacons').exists()).toBe(false);
  });

  it('closes the welcome modal with Escape when no spotlight is running', async () => {
    window.localStorage?.removeItem(WELCOME_KEY);

    const wrapper = mountApp();
    await nextTick();
    expect(wrapper.find('.welcome').exists()).toBe(true);

    pressEscape();
    await nextTick();

    expect(wrapper.find('.welcome').exists()).toBe(false);
    expect(window.localStorage.getItem(WELCOME_KEY)).toBe('1');
  });

  it('keeps global shortcuts inactive while the welcome modal is open', async () => {
    window.localStorage?.removeItem('stormbox.welcomeModalDismissed.v1');

    const wrapper = mountApp();
    await nextTick();

    const input = wrapper.get('.quick-filter__input').element as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }));
    await nextTick();

    expect(focusSpy).not.toHaveBeenCalled();

    await wrapper.get('.welcome__primary').trigger('click');
    await nextTick();

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }));
    await nextTick();

    expect(focusSpy).toHaveBeenCalledOnce();
  });

  it('switching the welcome picker changes the kbd hints and persists the scheme', async () => {
    window.localStorage?.removeItem('stormbox.welcomeModalDismissed.v1');

    const wrapper = mountApp();
    await flushPromises();

    // First group only: New message, Reply, Reply all, Forward, Quick Filter.
    const kbds = () => wrapper.findAll('.welcome__shortcut-group').at(0)!.findAll('kbd').map((kbd) => kbd.text());
    expect(kbds()).toEqual(['C', 'R', 'Shift+R', 'F', '/ or Ctrl+K']);
    expect(wrapper.get('.welcome__scheme-hint').text()).toBe('Web shortcuts avoid conflicting with the browser. You can change shortcut style later in Settings.');

    await wrapper.get('[data-shortcut-scheme="thunderbird"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-shortcut-scheme="thunderbird"]').attributes('aria-checked')).toBe('true');
    expect(kbds()).toEqual(['Ctrl+N or Ctrl+M', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+L', 'Ctrl+K']);
    expect(wrapper.get('.welcome__scheme-hint').text()).toBe('Thunderbird shortcuts are the same as desktop, but may conflict with the browser in some cases.');
    expect(useSettingsStore().get('shortcutScheme')).toBe('thunderbird');
    expect(JSON.parse(window.localStorage.getItem('stormbox.settings.v1')!))
      .toMatchObject({ shortcutScheme: 'thunderbird' });

    // Arrow keys move the radio too.
    await wrapper.get('.welcome [role="radiogroup"]').trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect(useSettingsStore().get('shortcutScheme')).toBe('web');
  });

  it('runs the compose spotlight on a tour-owned empty session and closes it afterwards', async () => {
    vi.useFakeTimers();
    window.localStorage?.removeItem(WELCOME_KEY);
    const composeStore = useComposeStore();

    const wrapper = mountApp();
    await nextTick();
    expect(composeStore.sessions).toHaveLength(0);

    await showMeButton(wrapper, 'Compose with confidence').trigger('click');
    await flushPromises();

    expect(composeStore.sessions).toHaveLength(1);
    expect(composeStore.isExpanded).toBe(true);
    expect(wrapper.find('.welcome--spotlighting').exists()).toBe(true);
    expect(wrapper.find('.shell--spotlighting').exists()).toBe(true);
    const caption = () => wrapper.get('[data-testid="feature-caption"]');
    expect(caption().text()).toContain('Compose with confidence');
    expect(caption().text()).toContain('Drafts save themselves as you type');
    expect(caption().get('.feature-caption__steps').attributes('aria-label')).toBe('Step 1 of 3');
    expect(showMeButton(wrapper, 'Smarter recipients').attributes('disabled')).toBeDefined();
    // The panel is hidden but still mounted, so the dialog survives the tour.
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);

    // Step 1 types the tour subject into the composer opened by `prepare`,
    // one character per timer, before the ring lands on the subject field.
    // The card is staged (undimmed) rather than ringed.
    const session = composeStore.activeSession!;
    expect(session.draft.subject).toBe('');
    await advanceSpotlight(SETTLE_MS);
    expect(session.draft.subject).toBe(TOUR_SUBJECT.slice(0, 1));
    await advanceSpotlight(...TOUR_SUBJECT.slice(1).split('').map(() => TOUR_TYPING_MS_PER_CHAR));
    expect(session.draft.subject).toBe(TOUR_SUBJECT);
    // One more per-character pause follows the last character, then the settle.
    // The typing is the demonstration, so nothing is ringed in this step.
    await advanceSpotlight(TOUR_TYPING_MS_PER_CHAR, SETTLE_MS);
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-targets')).toBe('');
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-stage'))
      .toBe('.compose-dialog__card');

    // Step 2: the pointer travels to and presses Minimize, then the session
    // minimizes and the ring glides to the dock.
    await advanceSpotlight(2600);
    expect(caption().text()).toContain('Minimize a draft');
    expect(caption().get('.feature-caption__steps').attributes('aria-label')).toBe('Step 2 of 3');
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-pointer'))
      .toBe('.compose-dialog .icon--minimize');
    expect(composeStore.isExpanded).toBe(true);
    await advanceSpotlight(TRAVEL_MS, PRESS_MS);
    expect(composeStore.isExpanded).toBe(false);
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-pointer')).toBeUndefined();
    await advanceSpotlight(SETTLE_MS);
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-targets'))
      .toBe('.compose-dock__item');
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-stage'))
      .toBe('.compose-dock');

    // Step 3 presses the dock item to restore it; when the script ends the
    // empty session is closed.
    await advanceSpotlight(3400, TRAVEL_MS, PRESS_MS);
    expect(composeStore.isExpanded).toBe(true);

    await advanceSpotlight(SETTLE_MS, 3200);
    expect(session.draft.subject).toBe('');
    expect(composeStore.sessions).toHaveLength(0);
    expect(wrapper.find('.welcome--spotlighting').exists()).toBe(false);
    expect(wrapper.find('[data-testid="spotlight-overlay"]').exists()).toBe(false);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(window.localStorage.getItem(WELCOME_KEY)).toBeNull();
  });

  it('cancels a running spotlight with Escape before closing the modal', async () => {
    vi.useFakeTimers();
    window.localStorage?.removeItem(WELCOME_KEY);
    const composeStore = useComposeStore();

    const wrapper = mountApp();
    await nextTick();

    await showMeButton(wrapper, 'Smarter recipients').trigger('click');
    await flushPromises();
    expect(composeStore.sessions).toHaveLength(1);
    expect(wrapper.find('.welcome--spotlighting').exists()).toBe(true);

    pressEscape();
    await flushPromises();

    expect(composeStore.sessions).toHaveLength(0);
    expect(wrapper.find('.welcome--spotlighting').exists()).toBe(false);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);

    pressEscape();
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('leaves a session the user typed into open after the compose spotlight', async () => {
    vi.useFakeTimers();
    window.localStorage?.removeItem(WELCOME_KEY);
    const composeStore = useComposeStore();

    const wrapper = mountApp();
    await nextTick();

    await showMeButton(wrapper, 'Attachments and Clipboard').trigger('click');
    await flushPromises();
    const session = composeStore.activeSession;
    expect(session).not.toBeNull();
    composeStore.setBodyContent({ html: '<p>Keep me</p>', text: 'Keep me' }, session!.id);
    expect(composeStore.isSessionDirty(session!.id)).toBe(true);

    await wrapper.get('.feature-caption__done').trigger('click');
    await flushPromises();

    expect(composeStore.sessions).toHaveLength(1);
    expect(wrapper.find('.welcome--spotlighting').exists()).toBe(false);
  });

  it('switches to Contacts for the contacts spotlight and restores the previous space', async () => {
    vi.useFakeTimers();
    restoreContactListLayout = stubContactListLayout();
    window.localStorage?.removeItem(WELCOME_KEY);

    const wrapper = mountApp();
    await nextTick();
    const contactsButton = () => wrapper.get('.app-spaces [aria-label="Contacts"]');
    expect(contactsButton().attributes('aria-pressed')).toBe('false');

    await showMeButton(wrapper, 'Contacts and identities').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-targets'))
      .toBe('.app-spaces [aria-label="Contacts"]');
    // This tour rings without a scrim.
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-dim')).toBe('false');
    expect(wrapper.find('.spotlight-overlay__scrim').exists()).toBe(false);
    expect(contactsButton().attributes('aria-pressed')).toBe('false');

    // Step 2 presses the Contacts space button before switching.
    await advanceSpotlight(2600);
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-pointer'))
      .toBe('.app-spaces [aria-label="Contacts"]');
    expect(contactsButton().attributes('aria-pressed')).toBe('false');
    await advanceSpotlight(TRAVEL_MS, PRESS_MS);
    expect(contactsButton().attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('.shell--contacts').exists()).toBe(true);

    await advanceSpotlight(SETTLE_MS);
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-targets'))
      .toBe('.contacts-rail');

    // Step 3 presses Manage identities in the toolbar and opens that directory.
    const identitiesButton = () => wrapper.get('.contacts__identity-section button');
    await advanceSpotlight(3600);
    expect(wrapper.get('[data-testid="feature-caption"]').text()).toContain('Manage identities sets up');
    expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-pointer'))
      .toBe('.contacts__identity-section button');
    expect(identitiesButton().attributes('aria-pressed')).toBe('false');
    await advanceSpotlight(TRAVEL_MS, PRESS_MS);
    expect(identitiesButton().attributes('aria-pressed')).toBe('true');

    // With no identities to select the step waits out the directory load,
    // rings the list, and the tour ends back in Mail on All contacts.
    await advanceUntil(() => !wrapper.find('.welcome--spotlighting').exists());
    expect(contactsButton().attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('.shell--contacts').exists()).toBe(false);
    expect(wrapper.find('.contacts__identity-section button[aria-pressed="true"]').exists()).toBe(false);
  });

  it('honours prefers-reduced-motion in the tour', async () => {
    const restoreMatchMedia = stubReducedMotion(true);
    try {
      vi.useFakeTimers();
      window.localStorage?.removeItem(WELCOME_KEY);

      const wrapper = mountApp();
      await nextTick();
      expect(wrapper.find('.welcome--reduced-motion').exists()).toBe(true);

      await showMeButton(wrapper, 'Organize your mail').trigger('click');
      await flushPromises();
      expect(wrapper.find('.feature-tour--reduced-motion').exists()).toBe(true);
      expect(wrapper.find('.spotlight-overlay--static').exists()).toBe(true);
      pressEscape();
      await flushPromises();

      // No pointer play and no settle pause: the press's effect lands at once.
      restoreContactListLayout = stubContactListLayout();
      await showMeButton(wrapper, 'Contacts and identities').trigger('click');
      await flushPromises();
      await advanceSpotlight(2600);
      expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-pointer')).toBeUndefined();
      expect(wrapper.find('.shell--contacts').exists()).toBe(true);
      expect(wrapper.get('[data-testid="spotlight-overlay"]').attributes('data-targets'))
        .toContain('.contacts-rail');
    } finally {
      restoreMatchMedia();
    }
  });

  it('gives a user who dismissed Welcome before this announcement beacons instead of a dialog', async () => {
    seedExistingUser();

    const wrapper = mountApp();
    await settleBeacons();

    expect(wrapper.find('.welcome').exists()).toBe(false);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.get('.beacon-menu__pill').text()).toBe('6 new');
    expect(wrapper.findAll('.feature-beacons__dot').map((dot) => dot.attributes('data-beacon')))
      .toEqual(['newMessage', 'contacts']);
    expect(window.localStorage.getItem(WHATS_NEW_KEY)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(FEATURE_BEACONS_STORAGE_KEY)!))
      .toEqual({ seen: [], sessions: 1 });

    await wrapper.get('[data-beacon="newMessage"]').trigger('click');
    await settleBeacons();
    const card = wrapper.get('[role="dialog"]');
    expect(card.text()).toContain('A new composer');
    expect(card.text()).toContain('Open a message to see the new controls');

    await card.get('.feature-beacons__got-it').trigger('click');
    await settleBeacons();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.get('.beacon-menu__pill').text()).toBe('5 new');
    expect(wrapper.find('[data-beacon="newMessage"]').exists()).toBe(false);
    expect(window.localStorage.getItem(WHATS_NEW_KEY)).toBeNull();
  });

  it('Dismiss all finishes the round: flag written, pill and dots gone', async () => {
    seedExistingUser();

    const wrapper = mountApp();
    await settleBeacons();
    const menu = wrapper.get('.beacon-menu').element as HTMLDetailsElement;
    menu.open = true;
    await nextTick();
    expect(wrapper.findAll('.beacon-menu [role="menuitem"]')).toHaveLength(6);

    await wrapper.get('.beacon-menu__dismiss').trigger('click');
    await settleBeacons();

    expect(wrapper.find('.beacon-menu').exists()).toBe(false);
    expect(wrapper.find('.feature-beacons').exists()).toBe(false);
    expect(window.localStorage.getItem(WHATS_NEW_KEY)).toBe('1');
    expect(window.localStorage.getItem(FEATURE_BEACONS_STORAGE_KEY)).toBeNull();

    // A reload with the flag set shows nothing.
    const second = mountApp();
    await settleBeacons();
    expect(second.find('.beacon-menu').exists()).toBe(false);
    expect(second.find('[role="dialog"]').exists()).toBe(false);
  });

  it('shows no onboarding UI once both keys are set', async () => {
    const wrapper = mountApp();
    await settleBeacons();

    expect(wrapper.find('.welcome').exists()).toBe(false);
    expect(wrapper.find('.beacon-menu').exists()).toBe(false);
    expect(wrapper.find('.feature-beacons').exists()).toBe(false);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('keeps global shortcuts inactive while a beacon card is open', async () => {
    seedExistingUser();

    const wrapper = mountApp();
    await settleBeacons();

    const input = wrapper.get('.quick-filter__input').element as HTMLInputElement;
    const focusSpy = vi.spyOn(input, 'focus');
    const pressQuickFilter = () => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }));

    // Dots alone leave shortcuts live.
    pressQuickFilter();
    await nextTick();
    expect(focusSpy).toHaveBeenCalledOnce();

    await wrapper.get('[data-beacon="contacts"]').trigger('click');
    await settleBeacons();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    pressQuickFilter();
    await nextTick();
    expect(focusSpy).toHaveBeenCalledOnce();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settleBeacons();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    pressQuickFilter();
    await nextTick();
    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it('reveals a composer beacon from the pill by opening a compose session', async () => {
    seedExistingUser();
    const composeStore = useComposeStore();
    const beaconStore = useFeatureBeaconsStore();

    const wrapper = mountApp();
    await settleBeacons();
    expect(wrapper.find('[data-beacon="composeSchedule"]').exists()).toBe(false);

    (wrapper.get('.beacon-menu').element as HTMLDetailsElement).open = true;
    await nextTick();
    await wrapper.get('[data-beacon-item="composeSchedule"]').trigger('click');
    await settleBeacons();

    expect(composeStore.sessions).toHaveLength(1);
    expect(beaconStore.openId).toBe('composeSchedule');
    expect(wrapper.find('.compose-dialog .compose-schedule-menu__trigger').exists()).toBe(true);
    expect(wrapper.get('[data-beacon="composeSchedule"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[role="dialog"]').attributes('data-beacon-card')).toBe('composeSchedule');
    expect(wrapper.get('[role="dialog"]').text()).toContain('Send on your schedule');

    // Revealing again reuses the open session.
    beaconStore.close();
    (wrapper.get('.beacon-menu').element as HTMLDetailsElement).open = true;
    await nextTick();
    await wrapper.get('[data-beacon-item="composeMinimize"]').trigger('click');
    await settleBeacons();
    expect(composeStore.sessions).toHaveLength(1);
    expect(beaconStore.openId).toBe('composeMinimize');
  });

  it('hides beacons behind Welcome and keeps them when Welcome is reopened', async () => {
    seedExistingUser();

    const wrapper = mountApp();
    await settleBeacons();
    expect(wrapper.find('.feature-beacons').exists()).toBe(true);

    (wrapper.get('.account-menu').element as HTMLDetailsElement).open = true;
    await nextTick();
    const item = wrapper.findAll('[role="menuitem"]')
      .find((candidate) => candidate.text().includes('Welcome & shortcuts'));
    expect(item).toBeDefined();
    await item!.trigger('click');
    await settleBeacons();

    expect(wrapper.get('[role="dialog"]').text()).toContain('Welcome to Thundermail');
    expect(wrapper.find('.feature-beacons').exists()).toBe(false);

    pressEscape();
    await settleBeacons();
    expect(wrapper.find('.welcome').exists()).toBe(false);
    expect(wrapper.find('.feature-beacons').exists()).toBe(true);
    expect(wrapper.get('.beacon-menu__pill').text()).toBe('6 new');
    expect(window.localStorage.getItem(WELCOME_KEY)).toBe('1');
    expect(window.localStorage.getItem(WHATS_NEW_KEY)).toBeNull();
  });

  it('reopens Welcome from the account menu without touching either key', async () => {
    const wrapper = mountApp();
    await nextTick();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);

    (wrapper.get('.account-menu').element as HTMLDetailsElement).open = true;
    await nextTick();
    const item = wrapper.findAll('[role="menuitem"]')
      .find((candidate) => candidate.text().includes('Welcome & shortcuts'));
    expect(item).toBeDefined();
    await item!.trigger('click');
    await nextTick();

    expect(wrapper.get('[role="dialog"]').text()).toContain('Welcome to Thundermail');
    expect(wrapper.find('.beacon-menu').exists()).toBe(false);
    expect(window.localStorage.getItem(WELCOME_KEY)).toBe('1');
    expect(window.localStorage.getItem(WHATS_NEW_KEY)).toBe('1');
  });

  it('filters messages from the shared header box in the Mail space', async () => {
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

  it('filters contacts from the shared header box in the Contacts space', async () => {
    restoreContactListLayout = stubContactListLayout();
    repoContacts = [
      {
        id: 1,
        remote_id: 'alice',
        addressbook_ids: [],
        display_name: 'Alice Example',
        email: 'alice@example.com',
      },
      {
        id: 2,
        remote_id: 'bob',
        addressbook_ids: [],
        display_name: 'Bob Example',
        email: 'bob@example.net',
      },
    ];
    const wrapper = mountApp();
    await flushPromises();

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.contacts__row')).toHaveLength(2);
    expect(wrapper.find('.contacts__filter').exists()).toBe(false);

    await wrapper.get('.quick-filter__input').setValue('  ALICE  ');
    await nextTick();

    expect(wrapper.findAll('.contacts__row')).toHaveLength(1);
    expect(wrapper.get('.contacts__row').text()).toContain('Alice Example');

    await wrapper.get('.quick-filter__input').setValue('BOB@EXAMPLE.NET');
    await nextTick();

    expect(wrapper.findAll('.contacts__row')).toHaveLength(1);
    expect(wrapper.get('.contacts__row').text()).toContain('Bob Example');
  });

  it('clears the shared query whenever the active space changes', async () => {
    const wrapper = mountApp();
    await nextTick();

    await wrapper.get('.quick-filter__input').setValue('mail term');
    expect(wrapper.get('.msg-list').attributes('data-filter')).toBe('mail term');

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await nextTick();
    expect((wrapper.get('.quick-filter__input').element as HTMLInputElement).value).toBe('');
    expect(wrapper.getComponent(ContactsView).props('filterQuery')).toBe('');

    await wrapper.get('.quick-filter__input').setValue('contact term');
    expect(wrapper.getComponent(ContactsView).props('filterQuery')).toBe('contact term');

    await wrapper.get('[aria-label="Mail"]').trigger('click');
    await nextTick();
    expect((wrapper.get('.quick-filter__input').element as HTMLInputElement).value).toBe('');
    expect(wrapper.get('.msg-list').attributes('data-filter')).toBe('');
  });

  it('guards contact-filter invalidation and leaving Contacts for Mail', async () => {
    restoreContactListLayout = stubContactListLayout();
    repoContacts = [{
      id: 1,
      remote_id: 'alice',
      addressbook_ids: [],
      display_name: 'Alice Example',
      email: 'alice@example.com',
    }];
    const wrapper = mountApp();
    await flushPromises();
    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-entry-key="contact:1"]').trigger('click');
    await flushPromises();
    const edit = wrapper.findAll('button')
      .find((button) => button.attributes('aria-label') === 'Edit')!;
    await edit.trigger('click');
    await wrapper.get('input[autocomplete="name"]').setValue('Dirty Alice');

    await wrapper.get('.quick-filter__input').setValue('no match');
    await nextTick();
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Save your changes');
    await wrapper.findAll('button')
      .filter((button) => button.text().trim() === 'Cancel')
      .at(-1)!
      .trigger('click');
    await flushPromises();
    expect((wrapper.get('.quick-filter__input').element as HTMLInputElement).value).toBe('');
    expect(wrapper.find('.shell--contacts').exists()).toBe(true);

    await wrapper.get('[aria-label="Mail"]').trigger('click');
    await nextTick();
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Save your changes');
    await wrapper.findAll('button')
      .filter((button) => button.text().trim() === 'Cancel')
      .at(-1)!
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('.shell--contacts').exists()).toBe(true);

    await wrapper.get('[aria-label="Mail"]').trigger('click');
    await nextTick();
    await wrapper.findAll('button')
      .find((button) => button.text().trim() === 'Discard')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('.shell--contacts').exists()).toBe(false);
    expect(wrapper.find('.msg-list').exists()).toBe(true);
  });

  it('commits only the latest contact filter queued behind confirmation', async () => {
    restoreContactListLayout = stubContactListLayout();
    repoContacts = [{
      id: 1,
      remote_id: 'alice',
      addressbook_ids: [],
      display_name: 'Alice Example',
      email: 'alice@example.com',
    }];
    const wrapper = mountApp();
    await flushPromises();
    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-entry-key="contact:1"]').trigger('click');
    await flushPromises();
    const edit = wrapper.findAll('button')
      .find((button) => button.attributes('aria-label') === 'Edit')!;
    await edit.trigger('click');
    await wrapper.get('input[autocomplete="name"]').setValue('Dirty Alice');
    const filter = wrapper.get('.quick-filter__input');

    await filter.setValue('first query');
    await nextTick();
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Save your changes');
    await filter.setValue('latest query');
    await nextTick();
    await wrapper.findAll('button')
      .find((button) => button.text().trim() === 'Discard')!
      .trigger('click');
    await flushPromises();

    expect((filter.element as HTMLInputElement).value).toBe('latest query');
    expect(wrapper.getComponent(ContactsView).props('filterQuery')).toBe('latest query');
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it('does not change mail selection when the Contacts filter query changes', async () => {
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;
    const wrapper = mountApp();
    await nextTick();

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await nextTick();
    const selectMessageSpy = vi.spyOn(mailStore, 'selectMessage');

    await wrapper.get('.quick-filter__input').setValue('alice');

    expect(selectMessageSpy).not.toHaveBeenCalled();
    expect(mailStore.selectedMessageId).toBe(42);
  });

  it('describes the shared filter for the active space', async () => {
    const wrapper = mountApp();
    await nextTick();
    const input = wrapper.get('.quick-filter__input');

    expect(input.attributes('placeholder')).toBe('Filter messages');
    expect(input.attributes('aria-label')).toBe('Quick Filter messages by from, to, or subject');
    // Web scheme by default: `/` is the badge, both keys are announced.
    expect(input.attributes('aria-keyshortcuts')).toBe('/ Control+K');
    expect(wrapper.get('.quick-filter__shortcut').text()).toBe('/');

    useSettingsStore().settings = { shortcutScheme: 'thunderbird' };
    await nextTick();
    expect(input.attributes('aria-keyshortcuts')).toBe('Control+K');
    expect(wrapper.get('.quick-filter__shortcut').text()).toBe('Ctrl+K');
    useSettingsStore().settings = {};
    await nextTick();

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await nextTick();

    expect(input.attributes('placeholder')).toBe('Filter contacts or identities');
    expect(input.attributes('aria-label'))
      .toBe('Filter contacts or identities by name or email address');
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

    // The web scheme's primary key.
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: '/',
      bubbles: true,
      cancelable: true,
    }));
    await nextTick();

    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it('renders the Mail brand with the Thundermail bolt glyph', async () => {
    const wrapper = mountApp();
    await nextTick();

    const brand = wrapper.get('.quick-filter__brand');
    expect(brand.get('.quick-filter__wordmark').text()).toBe('Mail');
    expect(brand.get('.quick-filter__glyph').attributes('aria-hidden')).toBe('true');
    expect(brand.find('.quick-filter__glyph svg').exists()).toBe(true);
    expect(wrapper.get('.quick-filter__input').attributes('placeholder')).toBe('Filter messages');
  });

  it('opens an app drawer from the app switcher with Mail current and the other apps linked', async () => {
    const wrapper = mountApp();
    await nextTick();

    const drawer = wrapper.get('.quick-filter__actions .app-drawer');
    expect(drawer.get('.app-drawer__button').attributes('aria-label')).toBe('Open app drawer');
    expect(drawer.get('.app-drawer__button').classes()).toContain('quick-filter__action');

    const tiles = drawer.findAll('.app-drawer__popover [role="menuitem"]');
    expect(tiles).toHaveLength(3);
    expect(tiles[0].text()).toContain('Mail');
    expect(tiles[0].attributes('aria-current')).toBe('page');
    expect(tiles[0].get('img').attributes('src')).toBe('/icons/icon-mail.svg');
    expect(tiles[1].text()).toContain('Appointment');
    expect(tiles[1].attributes('href')).toBe(APPOINTMENT_URL);
    expect(tiles[1].attributes('target')).toBe('_blank');
    expect(tiles[1].attributes('rel')).toBe('noopener noreferrer');
    expect(tiles[1].get('img').attributes('src')).toBe('/icons/icon-appointment.svg');
    expect(tiles[2].text()).toContain('Send');
    expect(tiles[2].attributes('href')).toBe(SEND_URL);
    expect(tiles[2].attributes('target')).toBe('_blank');
    expect(tiles[2].attributes('rel')).toBe('noopener noreferrer');
    expect(tiles[2].get('img').attributes('src')).toBe('/icons/icon-send.svg');
  });

  it('collapses the actions into a menu with the same links, settings and theme toggle for compact layouts', async () => {
    window.localStorage?.setItem('stormbox.theme.v1', 'dark');
    const wrapper = mountApp();
    await flushPromises();

    // Beside the avatar, in the actions cluster at the right end of the bar.
    const menu = wrapper.get('.quick-filter__actions > .quick-filter__menu');
    expect(menu.element.nextElementSibling?.classList.contains('account-menu')).toBe(true);
    expect(menu.get('.top-nav-menu__button').attributes('aria-label')).toBe('Open menu');

    const toggleLabel = wrapper.get('.theme-toggle').attributes('aria-label');
    const items = menu.findAll('.top-nav-menu__popover [role="menuitem"]');
    expect(items.map((item) => item.text())).toEqual([
      'Report a bug',
      'Give feedback',
      'Settings',
      toggleLabel,
      'Appointment',
      'Send',
    ]);
    expect(items[0].attributes('href')).toBe(BUG_REPORT_URL);
    expect(items[1].attributes('href')).toBe(FEEDBACK_URL);
    expect(items[4].attributes('href')).toBe(APPOINTMENT_URL);
    expect(items[5].attributes('href')).toBe(SEND_URL);

    await items[3].trigger('click');
    await nextTick();
    expect(wrapper.get('.theme-toggle').attributes('aria-label')).not.toBe(toggleLabel);
    expect(menu.get('.top-nav-menu__item:nth-of-type(4)').text()).not.toBe(toggleLabel);

    expect(document.body.querySelector('[data-settings-dialog]')).toBeNull();
    await items[2].trigger('click');
    await nextTick();
    expect(document.body.querySelector('[data-settings-dialog]')).not.toBeNull();
  });

  it('drops the theme toggle from the bar and the compact menu while the theme follows the system', async () => {
    const wrapper = mountApp();
    await flushPromises();

    expect(useSettingsStore().get('theme')).toBe('system');
    expect(wrapper.find('.theme-toggle').exists()).toBe(false);
    const items = wrapper.findAll('.top-nav-menu__popover [role="menuitem"]');
    expect(items.map((item) => item.text())).toEqual([
      'Report a bug',
      'Give feedback',
      'Settings',
      'Appointment',
      'Send',
    ]);
    // The gear itself stays: it is how the toggle comes back.
    expect(wrapper.find('[data-settings-gear]').exists()).toBe(true);
  });

  it('updates the document title with the signed-in account email', async () => {
    const authStore = useAuthStore();
    authStore.username = 'alice@example.com';

    mountApp();
    await nextTick();

    expect(document.title).toBe(`${APP_TITLE} - alice@example.com`);

    authStore.username = 'bob@example.net';
    await nextTick();

    expect(document.title).toBe(`${APP_TITLE} - bob@example.net`);

    authStore.username = null;
    await nextTick();

    expect(document.title).toBe(APP_TITLE);
  });

  it('passes the Inbox unread count to the spaces toolbar badge', async () => {
    const mailStore = useMailStore();
    mailStore.folders = [
      {
        id: 1,
        account_id: 1,
        remote_id: 'inbox',
        parent_id: null,
        name: 'Inbox',
        role: 'inbox',
        sort_order: 0,
        total_emails: 10,
        unread_emails: 3,
        total_threads: null,
        unread_threads: null,
        may_read_items: 1,
        may_add_items: 1,
        may_remove_items: 1,
        rights_json: null,
        raw_json: null,
        is_subscribed: null,
        is_starred: 0,
        is_deleted: 0,
        updated_at: 0,
      },
      {
        id: 2,
        account_id: 1,
        remote_id: 'archive',
        parent_id: null,
        name: 'Archive',
        role: 'archive',
        sort_order: 1,
        total_emails: 10,
        unread_emails: 7,
        total_threads: null,
        unread_threads: null,
        may_read_items: 1,
        may_add_items: 1,
        may_remove_items: 1,
        rights_json: null,
        raw_json: null,
        is_subscribed: null,
        is_starred: 0,
        is_deleted: 0,
        updated_at: 0,
      },
    ];

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.getComponent(AppSpaces).props('unreadCount')).toBe(3);
    expect(wrapper.get('.app-spaces__badge').text()).toBe('3');
  });

  it('closes the app drawer when clicking outside it', async () => {
    const wrapper = mountApp();
    await nextTick();

    const drawer = wrapper.get('.app-drawer').element as HTMLDetailsElement;
    drawer.open = true;

    dispatchClick(document.body);
    await nextTick();

    expect(drawer.open).toBe(false);
  });

  it('renders bug report and feedback links next to the theme toggle', async () => {
    window.localStorage?.setItem('stormbox.theme.v1', 'dark');
    const wrapper = mountApp();
    await flushPromises();

    const bugLink = wrapper.get('.quick-filter__action[aria-label="Report a bug"]');
    expect(bugLink.attributes('href')).toBe(BUG_REPORT_URL);
    expect(bugLink.attributes('target')).toBe('_blank');
    expect(bugLink.find('svg').exists()).toBe(true);

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

    const logoutButton = avatarMenu.findAll('button.account-menu__item')
      .find((button) => button.text().includes('Log Out'));
    if (!logoutButton) throw new Error('Could not find Log Out account menu item');
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

  it('shows the message view for a viewed message but hides it during bulk selection', async () => {
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(true);
    expect(wrapper.find('.shell').classes()).not.toContain('shell--message-view-hidden');
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('[aria-label="Resize message list"]').exists()).toBe(true);

    // Multi-select owns the list header; the reading pane goes away
    // entirely — even while a message is still previewed.
    mailStore.selectedIds = new Set([7]);
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(false);
    expect(wrapper.find('.shell').classes()).toContain('shell--message-view-hidden');

    mailStore.selectedMessageId = null;
    mailStore.selectedIds = new Set([7]);
    await nextTick();

    expect(wrapper.find('.message-view').exists()).toBe(false);
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

  it('hosts the address-book rail in the shared sidebar slot in Contacts (R-8.5)', async () => {
    const wrapper = mountApp();
    await flushPromises();

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('.shell').classes()).toContain('shell--contacts');
    const slot = wrapper.get('.sidebar-slot');
    expect(slot.classes()).not.toContain('sidebar-slot--hidden');
    expect(slot.find('.contacts-rail').exists()).toBe(true);
    expect(slot.find('.sidebar__compose').exists()).toBe(false);
    expect(wrapper.find('.contacts .contacts-rail').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Hide address book list"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Resize address book list"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Hide folder list"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Resize folder list"]').exists()).toBe(false);

    await wrapper.get('[aria-label="Hide address book list"]').trigger('click');
    await nextTick();
    expect(slot.classes()).toContain('sidebar-slot--hidden');
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');

    await wrapper.get('[aria-label="Mail"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.contacts-rail').exists()).toBe(false);
    expect(wrapper.find('.sidebar-slot .sidebar__compose').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Show folder list"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Resize folder list"]').exists()).toBe(true);
  });

  it('collapses the address-book rail below 1024px while a contact detail is open (CT-1.3)', async () => {
    restoreContactListLayout = stubContactListLayout();
    repoContacts = [
      {
        id: 1,
        remote_id: 'alice',
        addressbook_ids: [],
        display_name: 'Alice Example',
        email: 'alice@example.com',
      },
    ];
    setWindowWidth(1000);
    const wrapper = mountApp();
    await flushPromises();

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');

    await wrapper.get('.contacts__row').trigger('click');
    await flushPromises();
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).toContain('sidebar-slot--hidden');
    expect(wrapper.find('[aria-label="Show address book list"]').exists()).toBe(true);
    // The teleported rail leaves keyboard and accessibility navigation with
    // the slot it lives in.
    expect(wrapper.get('.sidebar-slot .contacts-rail').element.closest('[inert]')).not.toBeNull();

    await wrapper.get('.contact-detail [aria-label="Back"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.contact-detail').exists()).toBe(false);
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');
    expect(wrapper.get('.sidebar-slot .contacts-rail').element.closest('[inert]')).toBeNull();

    await wrapper.get('.contacts__row').trigger('click');
    await flushPromises();
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');

    setWindowWidth(1024, true);
    await nextTick();
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');
  });

  it('forgets the Contacts detail collapse when the space changes (CT-1.3)', async () => {
    restoreContactListLayout = stubContactListLayout();
    repoContacts = [
      {
        id: 1,
        remote_id: 'alice',
        addressbook_ids: [],
        display_name: 'Alice Example',
        email: 'alice@example.com',
      },
    ];
    setWindowWidth(1000);
    const wrapper = mountApp();
    await flushPromises();

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await flushPromises();
    await wrapper.get('.contacts__row').trigger('click');
    await flushPromises();
    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');

    // Mail has no open message, so its folder list must come back even
    // though a contact detail was open when the space changed.
    await wrapper.get('[aria-label="Mail"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot .sidebar__compose').exists()).toBe(true);

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.contact-detail').exists()).toBe(false);
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot .contacts-rail').exists()).toBe(true);
  });

  it('hides the address-book rail by default below 640px and opens it from the toggle (R-10.10)', async () => {
    setWindowWidth(639);
    const wrapper = mountApp();
    await flushPromises();

    await wrapper.get('[aria-label="Contacts"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).toContain('sidebar-slot--hidden');
    expect(wrapper.find('.contacts').exists()).toBe(true);

    await wrapper.get('[aria-label="Show address book list"]').trigger('click');
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');
    expect(wrapper.find('.sidebar-slot .contacts-rail').exists()).toBe(true);
  });

  it('auto-hides the folder list below 1024px when a message is selected', async () => {
    vi.useFakeTimers();
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();
    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');

    setWindowWidth(1023, true);
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

  it('keeps the 640px boundary in a two-pane mail layout', async () => {
    vi.useFakeTimers();
    setWindowWidth(640);
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');
    expect(wrapper.find('.msg-list').exists()).toBe(true);
    expect(wrapper.find('.message-view').exists()).toBe(false);

    vi.advanceTimersByTime(400);
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--message-list-hidden');
    expect(wrapper.find('.msg-list').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Resize message list"]').exists()).toBe(true);
    expect(wrapper.find('.message-view').exists()).toBe(true);
  });

  it('uses a single mail column below 640px', async () => {
    vi.useFakeTimers();
    setWindowWidth(639);
    const mailStore = useMailStore();
    mailStore.selectedMessageId = 42;

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.shell').classes()).toContain('shell--message-list-hidden');
    expect(wrapper.find('.msg-list').exists()).toBe(false);
    expect(wrapper.find('.message-view').exists()).toBe(true);
  });

  it('keeps the message list visible for bulk selection in single-column layout', async () => {
    setWindowWidth(639);
    const mailStore = useMailStore();
    mailStore.selectedIds = new Set([7]);

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.shell').classes()).toContain('shell--message-view-hidden');
    expect(wrapper.find('.shell').classes()).not.toContain('shell--message-list-hidden');
    expect(wrapper.find('.msg-list').exists()).toBe(true);
    expect(wrapper.find('.message-view').exists()).toBe(false);
  });

  it('hides the folder list by default below the single-column threshold', async () => {
    setWindowWidth(639);

    const wrapper = mountApp();
    await nextTick();

    expect(wrapper.find('.shell').classes()).toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).toContain('sidebar-slot--hidden');
    expect(wrapper.find('.msg-list').exists()).toBe(true);
    expect(wrapper.find('.message-view').exists()).toBe(false);

    await wrapper.get('[aria-label="Show folder list"]').trigger('click');
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');
    expect(wrapper.find('.msg-list').exists()).toBe(true);
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

    setWindowWidth(1024, true);
    await nextTick();

    expect(wrapper.find('.shell').classes()).not.toContain('shell--folder-list-hidden');
    expect(wrapper.find('.sidebar-slot').classes()).not.toContain('sidebar-slot--hidden');

    vi.advanceTimersByTime(360);
    await nextTick();
    expect(wrapper.find('.message-view').exists()).toBe(true);
  });

  it('keeps the folder list visible at 1024px', async () => {
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
    expect(document.body.classList.contains('is-column-resizing')).toBe(true);
    window.dispatchEvent(makePointerEvent('pointermove', 260));
    window.dispatchEvent(makePointerEvent('pointerup', 260));
    await nextTick();

    expect(document.body.classList.contains('is-column-resizing')).toBe(false);
    expect(wrapper.get('.shell').attributes('style'))
      .toContain('--folder-list-width: 300px');
    expect(JSON.parse(
      window.localStorage.getItem('stormbox.mailColumnWidths.v1') ?? '',
    )).toEqual({ folderList: 300, messageList: 360 });
  });

  it('resizes and persists the folder column from its keyboard separator', async () => {
    const wrapper = mountApp();
    await nextTick();

    await wrapper.get('[aria-label="Resize folder list"]')
      .trigger('keydown', { key: 'ArrowRight', shiftKey: true });

    expect(wrapper.get('.shell').attributes('style'))
      .toContain('--folder-list-width: 280px');
    expect(JSON.parse(
      window.localStorage.getItem('stormbox.mailColumnWidths.v1') ?? '',
    )).toEqual({ folderList: 280, messageList: 360 });
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

  it('toggles explicit light and dark themes through the settings store (R-8.4)', async () => {
    window.localStorage?.setItem('stormbox.theme.v1', 'light');

    const wrapper = mountApp();
    await flushPromises();

    // Theme is applied as html.dark / html.light classes (services-ui's
    // dark-mode convention), no longer as a data-theme attribute.
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(wrapper.get('.theme-toggle').attributes('aria-label')).toBe('Switch to dark mode');

    await wrapper.get('.theme-toggle').trigger('click');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(wrapper.get('.theme-toggle').attributes('aria-label')).toBe('Switch to light mode');
    // The mirror also carries the scheduling time zone, initialized on
    // first connect; only the theme is under test here.
    expect(JSON.parse(window.localStorage.getItem('stormbox.settings.v1')!))
      .toMatchObject({ theme: 'dark' });

    await wrapper.get('.theme-toggle').trigger('click');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('stormbox.settings.v1')!))
      .toMatchObject({ theme: 'light' });
  });
});
