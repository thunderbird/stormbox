// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { nextTick } from 'vue';

import FeatureBeaconLayer from '../../../src/components/FeatureBeaconLayer.vue';
import { BEACON_TIMING, FEATURE_BEACONS_STORAGE_KEY } from '../../../src/constants/feature-beacons';
import { useFeatureBeaconsStore } from '../../../src/stores/feature-beacons-store';
import { stubBeaconLayout, type BeaconLayoutStub } from '../_fixtures/beacon-layout';

const COMPOSE = '.sidebar__compose';
const CONTACTS = '.app-spaces [aria-label="Contacts"]';
const MANAGE_FOLDERS = '.folder-tree__manage';

const RECTS = {
  [COMPOSE]: {
    left: 70, top: 60, width: 160, height: 36,
  },
  [CONTACTS]: {
    left: 8, top: 120, width: 40, height: 40,
  },
  [MANAGE_FOLDERS]: {
    left: 200, top: 110, width: 28, height: 28,
  },
};

let layout: BeaconLayoutStub;
let host: HTMLElement;
const wrappers: ReturnType<typeof mount>[] = [];

function mountAnchors(html: string) {
  host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
}

const ALL_ANCHORS = `
  <button class="sidebar__compose">New Message</button>
  <nav class="app-spaces"><button aria-label="Contacts">Contacts</button></nav>
  <button class="folder-tree__manage">Manage</button>
`;

function mountLayer() {
  const wrapper = mount(FeatureBeaconLayer, { attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

async function settle() {
  await flushPromises();
  await nextTick();
  await flushPromises();
}

function dots(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.feature-beacons__dot').map((dot) => dot.attributes('data-beacon'));
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  layout = stubBeaconLayout(RECTS);
  useFeatureBeaconsStore().arm();
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  host?.remove();
  layout.restore();
  vi.useRealTimers();
});

describe('FeatureBeaconLayer', () => {
  it('renders one dot per unseen beacon whose anchor is on screen', async () => {
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    await settle();

    expect(dots(wrapper)).toEqual(['newMessage', 'contacts', 'manageFolders']);
    const dot = wrapper.get('[data-beacon="newMessage"]');
    expect(dot.attributes('aria-label')).toBe('New: A new composer');
    expect(dot.attributes('aria-haspopup')).toBe('dialog');
    expect(dot.attributes('aria-expanded')).toBe('false');
    // Centred on the anchor's top-right corner: (230, 60) minus half of 32.
    expect(dot.attributes('style')).toContain('left: 214px');
    expect(dot.attributes('style')).toContain('top: 44px');
  });

  it('skips anchors that are missing, zero-sized, or covered', async () => {
    mountAnchors(`
      <button class="sidebar__compose">New Message</button>
      <button class="folder-tree__manage">Manage</button>
      <div class="compose-dialog"></div>
    `);
    layout.setRect(MANAGE_FOLDERS, null);
    const wrapper = mountLayer();
    await settle();
    expect(dots(wrapper)).toEqual(['newMessage']);

    layout.cover('.compose-dialog');
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(dots(wrapper)).toEqual([]);

    layout.cover(null);
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(dots(wrapper)).toEqual(['newMessage']);
  });

  it('re-measures when the DOM changes', async () => {
    mountAnchors('<button class="sidebar__compose">New Message</button>');
    const wrapper = mountLayer();
    await settle();
    expect(dots(wrapper)).toEqual(['newMessage']);

    const manage = document.createElement('button');
    manage.className = 'folder-tree__manage';
    host.appendChild(manage);
    await settle();
    expect(dots(wrapper)).toEqual(['newMessage', 'manageFolders']);

    manage.remove();
    await settle();
    expect(dots(wrapper)).toEqual(['newMessage']);
  });

  it('clicking a dot pins the card with focus; Got it removes the dot and persists', async () => {
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();

    await wrapper.get('[data-beacon="manageFolders"]').trigger('click');
    await settle();

    expect(store.openId).toBe('manageFolders');
    const card = wrapper.get('[role="dialog"]');
    expect(card.attributes('data-beacon-card')).toBe('manageFolders');
    expect(card.attributes('data-beacon-card-mode')).toBe('pinned');
    expect(card.text()).toContain('Manage Folders');
    expect(card.text()).toContain('Create folders');
    expect(card.find('.feature-beacons__later').exists()).toBe(false);
    expect(wrapper.get('[data-beacon="manageFolders"]').attributes('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(card.element);

    await card.get('.feature-beacons__got-it').trigger('click');
    await settle();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(dots(wrapper)).toEqual(['newMessage', 'contacts']);
    expect(JSON.parse(window.localStorage.getItem(FEATURE_BEACONS_STORAGE_KEY)!))
      .toEqual({ seen: ['manageFolders'], sessions: 1 });
  });

  it('Escape closes a pinned card, keeps the dot, and returns focus to it', async () => {
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();

    const dot = wrapper.get('[data-beacon="contacts"]');
    await dot.trigger('click');
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    wrapper.get('[role="dialog"]').element.dispatchEvent(escape);
    await settle();
    expect(escape.defaultPrevented).toBe(true);
    expect(store.openId).toBeNull();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(dots(wrapper)).toContain('contacts');
    expect(document.activeElement).toBe(dot.element);
    expect(window.localStorage.getItem(FEATURE_BEACONS_STORAGE_KEY))
      .toBe(JSON.stringify({ seen: [], sessions: 1 }));
  });

  it('returns focus to the control when the dot retired before the card closed', async () => {
    vi.useFakeTimers();
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    await wrapper.get('[data-beacon="manageFolders"]').trigger('click');
    await settle();
    vi.advanceTimersByTime(BEACON_TIMING.seenDwellMs);
    await settle();
    vi.advanceTimersByTime(20);
    await settle();
    expect(dots(wrapper)).not.toContain('manageFolders');

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    wrapper.get('[role="dialog"]').element.dispatchEvent(escape);
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(MANAGE_FOLDERS));
  });

  it('a card pinned from an origin that is no longer on screen returns focus to its dot', async () => {
    vi.useFakeTimers();
    mountAnchors(`${ALL_ANCHORS}<button class="pill">2 new</button>`);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    const pill = document.querySelector('.pill') as HTMLElement;
    pill.focus();
    store.open('composeSchedule');
    // The host mounts after the reveal and takes focus itself.
    layout.setRect('.compose-dialog--expanded .compose-schedule-menu__trigger', {
      left: 400, top: 500, width: 30, height: 30,
    });
    const dialog = document.createElement('div');
    dialog.className = 'compose-dialog compose-dialog--expanded';
    dialog.innerHTML = '<input id="compose-to"><details class="compose-schedule-menu"><summary class="compose-schedule-menu__trigger">Schedule</summary></details>';
    host.appendChild(dialog);
    (dialog.querySelector('#compose-to') as HTMLElement).focus();
    await settle();
    vi.advanceTimersByTime(20);
    await settle();
    expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element);

    // The pill has no box on screen (the composer covers it), so focus goes
    // to the beacon's own dot rather than to the host's input.
    store.close();
    await settle();
    expect(document.activeElement).toBe(wrapper.get('[data-beacon="composeSchedule"]').element);
  });

  it('hovering a dot or its control previews the card and leaving closes it', async () => {
    vi.useFakeTimers();
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    const dot = wrapper.get('[data-beacon="newMessage"]');
    dot.element.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(BEACON_TIMING.previewOpenMs - 1);
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    vi.advanceTimersByTime(1);
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    const card = wrapper.get('[role="dialog"]');
    expect(card.attributes('data-beacon-card')).toBe('newMessage');
    expect(card.attributes('data-beacon-card-mode')).toBe('preview');
    // A preview neither pins nor takes focus.
    expect(store.openId).toBeNull();
    expect(document.activeElement).not.toBe(card.element);

    // Moving onto the card keeps it; moving elsewhere closes it after a grace.
    card.element.dispatchEvent(new Event('pointerover', { bubbles: true }));
    document.body.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(BEACON_TIMING.previewCloseMs - 1);
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    vi.advanceTimersByTime(1);
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(dots(wrapper)).toContain('newMessage');

    // The control itself is a hover target too.
    document.querySelector(MANAGE_FOLDERS)!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(BEACON_TIMING.previewOpenMs);
    await settle();
    vi.advanceTimersByTime(20);
    await settle();
    expect(wrapper.get('[role="dialog"]').attributes('data-beacon-card')).toBe('manageFolders');
  });

  it('focusing a dot previews its card', async () => {
    vi.useFakeTimers();
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    (wrapper.get('[data-beacon="contacts"]').element as HTMLElement).focus();
    await wrapper.get('[data-beacon="contacts"]').trigger('focus');
    vi.advanceTimersByTime(BEACON_TIMING.previewOpenMs);
    await settle();
    vi.advanceTimersByTime(20);
    await settle();
    expect(wrapper.get('[role="dialog"]').attributes('data-beacon-card-mode')).toBe('preview');
  });

  it('reading a card for the dwell time marks the beacon seen but keeps the card', async () => {
    vi.useFakeTimers();
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    await wrapper.get('[data-beacon="contacts"]').trigger('click');
    await settle();
    vi.advanceTimersByTime(BEACON_TIMING.seenDwellMs - 1);
    await settle();
    expect(store.isUnseen('contacts')).toBe(true);

    vi.advanceTimersByTime(1);
    await settle();
    vi.advanceTimersByTime(20);
    await settle();
    expect(store.isUnseen('contacts')).toBe(false);
    expect(dots(wrapper)).not.toContain('contacts');
    expect(wrapper.get('[role="dialog"]').attributes('data-beacon-card')).toBe('contacts');
    expect(store.openId).toBe('contacts');

    await wrapper.get('.feature-beacons__got-it').trigger('click');
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('clicking the control retires its beacon and shows the card alongside without focus', async () => {
    vi.useFakeTimers();
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    const control = document.querySelector(MANAGE_FOLDERS) as HTMLElement;
    control.focus();
    control.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    expect(store.isUnseen('manageFolders')).toBe(false);
    expect(dots(wrapper)).not.toContain('manageFolders');
    const card = wrapper.get('[role="dialog"]');
    expect(card.attributes('data-beacon-card')).toBe('manageFolders');
    expect(card.attributes('data-beacon-card-mode')).toBe('alongside');
    expect(store.openId).toBeNull();
    expect(document.activeElement).toBe(control);

    vi.advanceTimersByTime(BEACON_TIMING.alongsideMs);
    await settle();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('the last card read keeps the layer up until it closes', async () => {
    vi.useFakeTimers();
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    for (const id of ['newMessage', 'composeMinimize', 'composeSchedule', 'manageIdentities', 'manageFolders'] as const) {
      store.markSeen(id);
    }
    await settle();
    vi.advanceTimersByTime(20);
    await settle();
    expect(dots(wrapper)).toEqual(['contacts']);

    await wrapper.get('[data-beacon="contacts"]').trigger('click');
    await settle();
    vi.advanceTimersByTime(BEACON_TIMING.seenDwellMs);
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    expect(store.allSeen).toBe(true);
    expect(store.enabled).toBe(true);
    expect(wrapper.get('[role="dialog"]').attributes('data-beacon-card')).toBe('contacts');

    await wrapper.get('.feature-beacons__got-it').trigger('click');
    await settle();
    expect(store.enabled).toBe(false);
  });

  it('clicking outside the card closes it; clicking the open dot toggles it', async () => {
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();

    const dot = wrapper.get('[data-beacon="newMessage"]');
    await dot.trigger('click');
    await settle();
    expect(store.openId).toBe('newMessage');

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(store.openId).toBeNull();

    await dot.trigger('click');
    await settle();
    expect(store.openId).toBe('newMessage');
    await dot.trigger('click');
    await settle();
    expect(store.openId).toBeNull();
  });

  it('drops an open card whose anchor never appears', async () => {
    vi.useFakeTimers();
    mountAnchors(ALL_ANCHORS);
    mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();

    store.open('composeSchedule');
    await settle();
    expect(store.openId).toBe('composeSchedule');

    vi.advanceTimersByTime(1500);
    await settle();
    expect(store.openId).toBe('composeSchedule');

    vi.advanceTimersByTime(600);
    await settle();
    expect(store.openId).toBeNull();
  });

  it('shows the card once a staged anchor mounts', async () => {
    vi.useFakeTimers();
    mountAnchors(ALL_ANCHORS);
    const wrapper = mountLayer();
    const store = useFeatureBeaconsStore();
    await settle();

    store.open('composeSchedule');
    await settle();
    vi.advanceTimersByTime(500);

    layout.setRect('.compose-dialog--expanded .compose-schedule-menu__trigger', {
      left: 400, top: 500, width: 30, height: 30,
    });
    const dialog = document.createElement('div');
    dialog.className = 'compose-dialog compose-dialog--expanded';
    dialog.innerHTML = '<details class="compose-schedule-menu"><summary class="compose-schedule-menu__trigger">Schedule</summary></details>';
    host.appendChild(dialog);
    // The mutation record arrives on a microtask; fake timers own the
    // animation frame the measurement is coalesced into.
    await settle();
    vi.advanceTimersByTime(20);
    await settle();

    expect(dots(wrapper)).toContain('composeSchedule');
    expect(wrapper.get('[role="dialog"]').attributes('data-beacon-card')).toBe('composeSchedule');

    vi.advanceTimersByTime(3000);
    await settle();
    expect(store.openId).toBe('composeSchedule');
  });
});
