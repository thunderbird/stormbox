<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronDown, LogOut, Plus } from 'lucide-vue-next';

import { useThunderbirdShortcuts } from './composables/use-thunderbird-shortcuts.js';
import { ACCOUNTS_URL } from './defines.js';

import { useAuthStore } from './stores/auth-store.js';
import { useMailStore } from './stores/mail-store.js';
import { useContactsStore } from './stores/contacts-store.js';
import { useComposeStore } from './stores/compose-store.js';
import { AUTH_STATE } from './constants/states.js';

import AppSpaces from './components/AppSpaces.vue';
import LoginGate from './components/LoginGate.vue';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import MessageView from './components/MessageView.vue';
import ComposeDialog from './components/ComposeDialog.vue';
import ContactsView from './components/ContactsView.vue';
import StorageUsageBar from './components/StorageUsageBar.vue';
import ThunderbirdLogo from './components/ThunderbirdLogo.vue';

const authStore = useAuthStore();
const mailStore = useMailStore();
const contactsStore = useContactsStore();
const composeStore = useComposeStore();

const space = ref('mail');
const quickFilterQuery = ref('');

const showLogin = computed(() => authStore.status !== AUTH_STATE.CONNECTED);

const totalUnread = computed(() =>
  mailStore.folders.reduce((sum, f) => sum + (Number(f.unread_emails) || 0), 0),
);

const accountLabel = computed(() =>
  authStore.username || authStore.serverHostname,
);

const showMessageView = computed(() =>
  mailStore.selectedMessageId != null || mailStore.selectedIds.size > 0,
);

const shortcutsEnabled = computed(() => authStore.status === AUTH_STATE.CONNECTED);

type ResizePane = 'folderList' | 'messageList';

const RESIZE_STORAGE_KEY = 'stormbox.mailColumnWidths.v1';
const THEME_STORAGE_KEY = 'stormbox.theme.v1';
const SPACE_RAIL_WIDTH = 56;
const RESIZER_WIDTH = 6;
const COMPACT_READING_WIDTH = 1024;
const FOLDER_LIST_TRANSITION_MS = 360;
const MESSAGE_VIEW_PRELOAD_MS = 50;
const THEMES = ['dark', 'light'] as const;
type Theme = typeof THEMES[number];
const DEFAULT_COLUMN_WIDTHS = {
  folderList: 240,
  messageList: 360,
};
const MIN_COLUMN_WIDTHS = {
  folderList: 180,
  messageList: 280,
  messageView: 320,
};
const MAX_COLUMN_WIDTHS = {
  folderList: 420,
  messageList: 720,
};

const shellEl = ref<HTMLElement | null>(null);
const theme = ref<Theme>(getInitialTheme());
applyTheme(theme.value);
const folderListWidth = ref(DEFAULT_COLUMN_WIDTHS.folderList);
const messageListWidth = ref(DEFAULT_COLUMN_WIDTHS.messageList);
const folderListHidden = ref(false);
const windowWidth = ref(typeof window === 'undefined' ? COMPACT_READING_WIDTH : window.innerWidth);
const displayedMessageView = ref(
  showMessageView.value && !(space.value === 'mail' && windowWidth.value <= COMPACT_READING_WIDTH),
);
const activeResizePane = ref<ResizePane | null>(null);
let messageViewTimer: number | null = null;
let responsiveFolderListHidden = false;

let resizeState: {
  pane: ResizePane;
  startX: number;
  startFolderListWidth: number;
  startMessageListWidth: number;
} | null = null;

const shellStyle = computed(() => ({
  '--folder-list-width': `${folderListWidth.value}px`,
  '--message-list-width': `${messageListWidth.value}px`,
  '--message-list-min-width': `${MIN_COLUMN_WIDTHS.messageList}px`,
  '--message-view-min-width': `${MIN_COLUMN_WIDTHS.messageView}px`,
  '--column-resizer-width': `${RESIZER_WIDTH}px`,
  '--folder-list-transition-ms': `${FOLDER_LIST_TRANSITION_MS}ms`,
}));

useThunderbirdShortcuts({ space, enabled: shortcutsEnabled });

onMounted(async () => {
  applyTheme(theme.value);
  loadColumnWidths();
  applyResponsiveLayout();
  clampColumnWidths();
  window.addEventListener('resize', onWindowResize);

  await authStore.initialize();
  await mailStore.attach();
  await contactsStore.attach();
  await composeStore.attach();
});

onBeforeUnmount(() => {
  stopColumnResize();
  clearMessageViewTimer();
  window.removeEventListener('resize', onWindowResize);
});

watch(showMessageView, () => {
  applyResponsiveLayout();
  clampColumnWidths();
});

watch(space, () => {
  applyResponsiveLayout();
  clampColumnWidths();
});

watch(folderListHidden, () => {
  clampColumnWidths();
});

function startCompose() {
  composeStore.open();
}

function setQuickFilterQuery(event: Event) {
  const next = (event.target as HTMLInputElement | null)?.value ?? '';
  if (next === quickFilterQuery.value) return;
  if (mailStore.selectedMessageId != null) {
    mailStore.selectMessage(null);
  }
  quickFilterQuery.value = next;
}

function toggleFolderList() {
  folderListHidden.value = !folderListHidden.value;
  responsiveFolderListHidden = false;
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  applyTheme(theme.value);
  saveTheme(theme.value);
}

function startColumnResize(pane: ResizePane, event: PointerEvent) {
  if (event.button !== 0) return;

  event.preventDefault();
  resizeState = {
    pane,
    startX: event.clientX,
    startFolderListWidth: folderListWidth.value,
    startMessageListWidth: messageListWidth.value,
  };
  activeResizePane.value = pane;
  document.body.classList.add('is-column-resizing');
  window.addEventListener('pointermove', onColumnResizeMove);
  window.addEventListener('pointerup', stopColumnResize, { once: true });
  window.addEventListener('pointercancel', stopColumnResize, { once: true });
}

function onColumnResizeMove(event: PointerEvent) {
  if (!resizeState) return;

  const delta = event.clientX - resizeState.startX;
  if (resizeState.pane === 'folderList') {
    const nextWidth = resizeState.startFolderListWidth + delta;
    folderListWidth.value = clamp(
      nextWidth,
      MIN_COLUMN_WIDTHS.folderList,
      maxFolderListWidth(resizeState.startMessageListWidth),
    );
  } else {
    const nextWidth = resizeState.startMessageListWidth + delta;
    messageListWidth.value = clamp(
      nextWidth,
      MIN_COLUMN_WIDTHS.messageList,
      maxMessageListWidth(folderListWidth.value),
    );
  }
}

function stopColumnResize() {
  if (!resizeState && activeResizePane.value == null) return;

  resizeState = null;
  activeResizePane.value = null;
  document.body.classList.remove('is-column-resizing');
  window.removeEventListener('pointermove', onColumnResizeMove);
  window.removeEventListener('pointerup', stopColumnResize);
  window.removeEventListener('pointercancel', stopColumnResize);
  saveColumnWidths();
}

function onWindowResize() {
  windowWidth.value = window.innerWidth;
  applyResponsiveLayout();
  clampColumnWidths();
}

function applyResponsiveLayout() {
  const compactMailLayout = space.value === 'mail' && windowWidth.value <= COMPACT_READING_WIDTH;
  const shouldHideFolderList = compactMailLayout && showMessageView.value;
  const willHideFolderList = shouldHideFolderList && !folderListHidden.value;

  if (shouldHideFolderList) {
    if (!folderListHidden.value) {
      responsiveFolderListHidden = true;
    }
    folderListHidden.value = true;
  } else if (responsiveFolderListHidden) {
    folderListHidden.value = false;
    responsiveFolderListHidden = false;
  }

  syncDisplayedMessageView({ delayForFolderSlide: willHideFolderList });
}

function syncDisplayedMessageView({ delayForFolderSlide = false } = {}) {
  clearMessageViewTimer();
  if (!showMessageView.value) {
    displayedMessageView.value = false;
    return;
  }

  if (!delayForFolderSlide) {
    displayedMessageView.value = true;
    return;
  }

  displayedMessageView.value = false;
  messageViewTimer = window.setTimeout(() => {
    messageViewTimer = null;
    if (showMessageView.value) {
      displayedMessageView.value = true;
    }
  }, Math.max(0, FOLDER_LIST_TRANSITION_MS - MESSAGE_VIEW_PRELOAD_MS));
}

function clearMessageViewTimer() {
  if (messageViewTimer == null) return;
  window.clearTimeout(messageViewTimer);
  messageViewTimer = null;
}

function onResizeHandleKeydown(pane: ResizePane, event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const step = event.shiftKey ? 40 : 10;
  if (pane === 'folderList') {
    folderListWidth.value = clamp(
      folderListWidth.value + direction * step,
      MIN_COLUMN_WIDTHS.folderList,
      maxFolderListWidth(messageListWidth.value),
    );
  } else {
    messageListWidth.value = clamp(
      messageListWidth.value + direction * step,
      MIN_COLUMN_WIDTHS.messageList,
      maxMessageListWidth(folderListWidth.value),
    );
  }
  saveColumnWidths();
}

function availablePaneWidth() {
  const shellWidth = shellEl.value?.clientWidth || window.innerWidth || 0;
  const resizerCount = (folderListHidden.value ? 0 : 1) + (displayedMessageView.value ? 1 : 0);
  return Math.max(0, shellWidth - SPACE_RAIL_WIDTH - resizerCount * RESIZER_WIDTH);
}

function maxFolderListWidth(messageList: number) {
  const reserve = displayedMessageView.value
    ? messageList + MIN_COLUMN_WIDTHS.messageView
    : MIN_COLUMN_WIDTHS.messageList;
  return Math.min(MAX_COLUMN_WIDTHS.folderList, availablePaneWidth() - reserve);
}

function maxMessageListWidth(folderList: number) {
  const reserve = displayedMessageView.value ? MIN_COLUMN_WIDTHS.messageView : 0;
  const folderReserve = folderListHidden.value ? 0 : folderList;
  return Math.min(MAX_COLUMN_WIDTHS.messageList, availablePaneWidth() - folderReserve - reserve);
}

function clampColumnWidths() {
  if (!folderListHidden.value) {
    folderListWidth.value = clamp(
      folderListWidth.value,
      MIN_COLUMN_WIDTHS.folderList,
      maxFolderListWidth(messageListWidth.value),
    );
  }
  messageListWidth.value = clamp(
    messageListWidth.value,
    MIN_COLUMN_WIDTHS.messageList,
    maxMessageListWidth(folderListWidth.value),
  );
}

function loadColumnWidths() {
  try {
    const raw = window.localStorage?.getItem(RESIZE_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed?.folderList)) {
      folderListWidth.value = parsed.folderList;
    }
    if (Number.isFinite(parsed?.messageList)) {
      messageListWidth.value = parsed.messageList;
    }
  } catch {
    // Layout preferences are best-effort; blocked storage should not affect mail.
  }
}

function saveColumnWidths() {
  try {
    window.localStorage?.setItem(RESIZE_STORAGE_KEY, JSON.stringify({
      folderList: folderListWidth.value,
      messageList: messageListWidth.value,
    }));
  } catch {
    // Ignore storage failures; the current drag still applies for this session.
  }
}

function getInitialTheme(): Theme {
  try {
    const stored = window.localStorage?.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Theme falls back to the system preference when storage is unavailable.
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  return 'dark';
}

function applyTheme(nextTheme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;
}

function saveTheme(nextTheme: Theme) {
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {
    // Ignore storage failures; the selected theme still applies this session.
  }
}

function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light';
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}
</script>

<template>
  <LoginGate v-if="showLogin" />
  <div
    v-else
    ref="shellEl"
    class="shell"
    :class="{
      'shell--message-view-hidden': space === 'mail' && !displayedMessageView,
      'shell--folder-list-hidden': folderListHidden,
    }"
    :style="shellStyle"
  >
    <div class="quick-filter">
      <details class="app-menu">
        <summary class="app-menu__button" aria-label="Open Thundermail menu">
          <ThunderbirdLogo :size="26" class="app-menu__logo" aria-hidden="true" />
          <span>Thundermail</span>
          <ChevronDown class="app-menu__chevron" :size="14" :stroke-width="2" aria-hidden="true" />
        </summary>
        <div class="app-menu__popover" role="menu">
          <a class="app-menu__item" :href="ACCOUNTS_URL" role="menuitem">
            <ThunderbirdLogo :size="26" class="app-menu__item-icon" aria-hidden="true" />
            <span>Thunderbird Accounts</span>
          </a>
        </div>
      </details>

      <div class="quick-filter__search" role="search">
        <input
          class="quick-filter__input"
          type="search"
          :value="quickFilterQuery"
          aria-label="Quick Filter messages by from, to, or subject"
          placeholder="Quick Filter"
          autocomplete="off"
          spellcheck="false"
          @input="setQuickFilterQuery"
        />
      </div>
    </div>

    <AppSpaces
      :active="space"
      :unread-count="totalUnread"
      :folder-list-hidden="folderListHidden"
      :theme="theme"
      @change="space = $event"
      @toggle-folder-list="toggleFolderList"
      @toggle-theme="toggleTheme"
    />

    <div
      class="sidebar-slot"
      :class="{ 'sidebar-slot--hidden': folderListHidden }"
      :aria-hidden="folderListHidden"
      :inert="folderListHidden"
    >
      <aside class="sidebar">
        <header class="sidebar__header">
          <button class="sidebar__compose" type="button" @click="startCompose">
            <Plus :size="16" :stroke-width="2" />
            <span>New Message</span>
          </button>
        </header>

        <div class="sidebar__account">
          <span class="sidebar__account-name">{{ accountLabel }}</span>
        </div>

        <FolderTree v-if="space === 'mail'" />
        <p v-else class="sidebar__hint">Switch to Mail to navigate folders.</p>

        <footer class="sidebar__footer">
          <StorageUsageBar />
          <button class="sidebar__signout" type="button" @click="authStore.logout()" :title="`Sign out of ${accountLabel}`">
            <LogOut :size="14" :stroke-width="1.75" />
            <span>Sign out</span>
          </button>
        </footer>
      </aside>
    </div>

    <div
      class="column-resizer column-resizer--folder-list"
      :class="{
        'is-active': activeResizePane === 'folderList',
        'column-resizer--hidden': folderListHidden,
      }"
      role="separator"
      aria-label="Resize folder list"
      aria-orientation="vertical"
      :aria-valuemin="MIN_COLUMN_WIDTHS.folderList"
      :aria-valuemax="maxFolderListWidth(messageListWidth)"
      :aria-valuenow="folderListWidth"
      :aria-hidden="folderListHidden"
      :tabindex="folderListHidden ? -1 : 0"
      @pointerdown="startColumnResize('folderList', $event)"
      @keydown="onResizeHandleKeydown('folderList', $event)"
    />

    <template v-if="space === 'mail'">
      <MessageList :quick-filter-query="quickFilterQuery" />
      <div
        v-if="displayedMessageView"
        class="column-resizer column-resizer--message-list"
        :class="{ 'is-active': activeResizePane === 'messageList' }"
        role="separator"
        aria-label="Resize message list"
        aria-orientation="vertical"
        :aria-valuemin="MIN_COLUMN_WIDTHS.messageList"
        :aria-valuemax="maxMessageListWidth(folderListWidth)"
        :aria-valuenow="messageListWidth"
        tabindex="0"
        @pointerdown="startColumnResize('messageList', $event)"
        @keydown="onResizeHandleKeydown('messageList', $event)"
      />
      <MessageView v-if="displayedMessageView" />
    </template>
    <ContactsView v-else-if="space === 'contacts'" />

    <ComposeDialog />
  </div>
</template>

<style>
:root {
  --surface: var(--panel);
  --fg: var(--text);
  --border-soft: color-mix(in srgb, var(--border) 55%, transparent);
  --accent-bg: color-mix(in srgb, var(--accent) 22%, var(--panel2));
  --accent-fg: var(--accent);
  --space-rail-bg: var(--panel2);
  --space-rail-fg: var(--muted);
}

.shell {
  position: relative;
  --folder-resizer-width: var(--column-resizer-width, 6px);
  display: grid;
  grid-template-columns:
    56px
    auto
    var(--folder-resizer-width)
    minmax(var(--message-list-min-width, 280px), var(--message-list-width, 360px))
    var(--column-resizer-width, 6px)
    minmax(var(--message-view-min-width, 320px), 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  height: 100vh;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
.shell--message-view-hidden {
  grid-template-columns:
    56px
    auto
    var(--folder-resizer-width)
    minmax(var(--message-list-min-width, 280px), 1fr)
    0px
    0px;
}
.shell--folder-list-hidden {
  --folder-resizer-width: 0px;
}
/* Grid items default to min-height: auto, which makes inner
 * overflow:auto containers grow to their content instead of scrolling.
 * Force every shell column to be allowed to shrink so its children can
 * own the vertical scroll. */
.shell > * { min-height: 0; min-width: 0; }
.shell > .msg-list { border-right: 0; }
.shell > .contacts { grid-column: 4 / -1; }
.shell--folder-list-hidden > .contacts { grid-column: 2 / -1; }

.quick-filter {
  grid-column: 1 / -1;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  padding: 10px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.app-menu {
  position: absolute;
  z-index: 20;
  top: 50%;
  left: 12px;
  transform: translateY(-50%);
}
.app-menu__button {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 6px;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  list-style: none;
  user-select: none;
}
.app-menu__button::-webkit-details-marker {
  display: none;
}
.app-menu__button:hover,
.app-menu__button:focus-visible,
.app-menu[open] .app-menu__button {
  background: var(--rowHover);
  border-color: var(--border-soft);
  outline: none;
}
.app-menu__logo,
.app-menu__item-icon {
  display: block;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  flex-shrink: 0;
}
.app-menu__chevron {
  color: var(--muted);
  transition: transform 0.12s ease;
}
.app-menu[open] .app-menu__chevron {
  transform: rotate(180deg);
}
.app-menu__popover {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  min-width: 240px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 16px 32px color-mix(in srgb, #000 32%, transparent);
}
.app-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--text);
  font-weight: 600;
  text-decoration: none;
}
.app-menu__item:hover,
.app-menu__item:focus-visible {
  background: var(--rowHover);
  outline: none;
}
.quick-filter__search {
  width: min(520px, max(160px, calc(100% - 220px)));
}
.quick-filter__input {
  width: 100%;
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  padding: 0 16px;
  outline: none;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 8%, transparent);
}
.quick-filter__input::placeholder {
  color: var(--muted);
}
.quick-filter__input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

@media (max-width: 640px) {
  .quick-filter {
    justify-content: flex-start;
    gap: 10px;
    padding-left: 8px;
  }
  .app-menu {
    position: relative;
    top: auto;
    left: auto;
    transform: none;
    flex-shrink: 0;
  }
  .app-menu__button span {
    display: none;
  }
  .quick-filter__search {
    flex: 1;
    width: auto;
  }
}

.sidebar-slot {
  width: var(--folder-list-width, 240px);
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  transition: width var(--folder-list-transition-ms, 360ms) ease;
}
.sidebar-slot--hidden {
  width: 0;
}
.sidebar {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  background: var(--panel);
  width: var(--folder-list-width, 240px);
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  transform: translateX(0);
  transition: transform var(--folder-list-transition-ms, 360ms) ease;
}
.sidebar-slot--hidden .sidebar {
  transform: translateX(-100%);
}
.sidebar > :nth-child(3) { min-height: 0; overflow-y: auto; }
.sidebar__header {
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--border-soft);
}
.sidebar__compose {
  width: 100%;
  min-width: 0;
  margin: 0 auto;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--accent);
  color: #fff;
  border: 1px solid color-mix(in srgb, var(--accent) 80%, #000);
  border-radius: 6px;
  padding: 0 10px;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 16%, transparent);
  transition: filter 0.12s ease, box-shadow 0.12s ease;
}
.sidebar__compose svg {
  display: block;
  flex-shrink: 0;
  transform: translateY(1px);
}
.sidebar__compose span {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar__compose:hover {
  filter: brightness(1.04);
  box-shadow: 0 2px 5px color-mix(in srgb, #000 18%, transparent);
}

.sidebar__account {
  padding: 10px 14px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.sidebar__account-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: none;
  letter-spacing: normal;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.sidebar__hint {
  padding: 16px;
  color: var(--muted);
  font-size: 13px;
}

.sidebar__footer {
  margin-top: auto;
  padding: 8px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sidebar__signout {
  width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.sidebar__signout:hover {
  background: var(--rowHover);
  color: var(--text);
}

.column-resizer {
  position: relative;
  background: var(--panel);
  cursor: col-resize;
  outline: none;
  touch-action: none;
}
.column-resizer--hidden {
  cursor: default;
  pointer-events: none;
}
.column-resizer::before {
  content: "";
  position: absolute;
  inset-block: 0;
  left: calc(50% - 0.5px);
  width: 1px;
  background: var(--border);
  transition: background-color 0.12s ease, box-shadow 0.12s ease;
}
.column-resizer:hover::before,
.column-resizer:focus-visible::before,
.column-resizer.is-active::before {
  background: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent);
}
body.is-column-resizing {
  cursor: col-resize;
  user-select: none;
}
body.is-column-resizing iframe {
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-slot,
  .sidebar {
    transition: none;
  }
}
</style>
