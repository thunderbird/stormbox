<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onClickOutside, useTitle } from '@vueuse/core';
import { Bug, ChevronDown, Lightbulb, Moon, Plus, Sun, X } from '@lucide/vue';
import AppButton from './components/AppButton.vue';

import { useThunderbirdShortcuts } from './composables/useThunderbirdShortcuts';
import { APP_TITLE } from './app-config';
import { APPOINTMENT_URL, BUG_REPORT_URL, FEEDBACK_URL, SEND_URL } from './defines';

import { useAuthStore } from './stores/auth-store';
import { useMailStore } from './stores/mail-store';
import { useContactsStore } from './stores/contacts-store';
import { useComposeStore } from './stores/compose-store';
import { AUTH_STATE } from './constants/states';

import AppSpaces from './components/AppSpaces.vue';
import LoginGate from './components/LoginGate.vue';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import MessageView from './components/MessageView.vue';
import ComposeDialog from './components/ComposeDialog.vue';
import ContactsView from './components/ContactsView.vue';
import StorageUsageBar from './components/StorageUsageBar.vue';
import StoreErrorToast from './components/StoreErrorToast.vue';
import BulkOperationOverlay from './components/BulkOperationOverlay.vue';
import ThundermailLogo from './components/ThundermailLogo.vue';
import AccountAvatarMenu from './components/AccountAvatarMenu.vue';
import WelcomeModal from './components/WelcomeModal.vue';

const authStore = useAuthStore();
const mailStore = useMailStore();
const contactsStore = useContactsStore();
const composeStore = useComposeStore();

const space = ref('mail');
const quickFilterQuery = ref('');
const quickFilterSpotlight = ref(false);
const resizeLayoutSpotlight = ref(false);
const composeActionSpotlight = ref(false);

const showLogin = computed(() => authStore.status !== AUTH_STATE.CONNECTED);

const inboxUnread = computed(() => {
  const inbox = mailStore.folders.find((folder) => folder.role === 'inbox');
  return Number(inbox?.unread_emails) || 0;
});

const accountLabel = computed(() =>
  authStore.username || authStore.serverHostname,
);
const documentTitle = computed(() => {
  const username = authStore.username?.trim();
  return username ? `${APP_TITLE} - ${username}` : APP_TITLE;
});
useTitle(documentTitle, { restoreOnUnmount: false });

type ResizePane = 'folderList' | 'messageList';

const RESIZE_STORAGE_KEY = 'stormbox.mailColumnWidths.v1';
const THEME_STORAGE_KEY = 'stormbox.theme.v1';
const WELCOME_MODAL_STORAGE_KEY = 'stormbox.welcomeModalDismissed.v1';
const SPACE_RAIL_WIDTH = 56;
const RESIZER_WIDTH = 6;
const COMPACT_READING_WIDTH = 1024;
const SINGLE_COLUMN_WIDTH = 640;
const FOLDER_LIST_TRANSITION_MS = 360;
const MESSAGE_VIEW_PRELOAD_MS = 50;
type Theme = 'dark' | 'light';
const DEFAULT_COLUMN_WIDTHS = {
  folderList: 240,
  messageList: 360,
};
const MIN_COLUMN_WIDTHS = {
  folderList: 180,
  messageList: 280,
  messageView: 240,
};
const MAX_COLUMN_WIDTHS = {
  folderList: 420,
  messageList: 720,
};
const shellEl = ref<HTMLElement | null>(null);
const quickFilterInputEl = ref<HTMLInputElement | null>(null);
const appMenuEl = ref<HTMLDetailsElement | null>(null);
const theme = ref<Theme>(getInitialTheme());
applyTheme(theme.value);
const themeToggleLabel = computed(() =>
  theme.value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
);
const folderListWidth = ref(DEFAULT_COLUMN_WIDTHS.folderList);
const messageListWidth = ref(DEFAULT_COLUMN_WIDTHS.messageList);
const folderListHidden = ref(false);
const showWelcomeModal = ref(false);
const shortcutsEnabled = computed(() =>
  authStore.status === AUTH_STATE.CONNECTED && !showWelcomeModal.value,
);
const windowWidth = ref(typeof window === 'undefined' ? COMPACT_READING_WIDTH : window.innerWidth);
const isSingleColumnMailWidth = computed(() =>
  space.value === 'mail' && windowWidth.value < SINGLE_COLUMN_WIDTH,
);
const wantsMessageDetailView = computed(() =>
  mailStore.selectedMessageId != null
  || resizeLayoutSpotlight.value
  || composeActionSpotlight.value,
);
const showMessageView = computed(() =>
  wantsMessageDetailView.value
  || (mailStore.selectedIds.size > 0 && !isSingleColumnMailWidth.value),
);
const displayedMessageView = ref(
  showMessageView.value && !(space.value === 'mail' && windowWidth.value < COMPACT_READING_WIDTH),
);
const shouldUseSingleMailColumn = computed(() =>
  space.value === 'mail'
  && showMessageView.value
  && windowWidth.value < SINGLE_COLUMN_WIDTH,
);
const displayedMessageList = computed(() =>
  !(space.value === 'mail' && shouldUseSingleMailColumn.value),
);
const activeResizePane = ref<ResizePane | null>(null);
let messageViewTimer: number | null = null;
let quickFilterSpotlightTimer: number | null = null;
let resizeLayoutSpotlightTimer: number | null = null;
let composeActionSpotlightTimer: number | null = null;
let resizeLayoutDemoStart: { folderList: number; messageList: number } | null = null;
let resizeLayoutDemoTimers: number[] = [];
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

useThunderbirdShortcuts({
  space,
  enabled: shortcutsEnabled,
  focusQuickFilter: focusQuickFilterInput,
});

onClickOutside(appMenuEl, () => {
  if (appMenuEl.value?.open) appMenuEl.value.open = false;
});

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
  clearQuickFilterSpotlightTimer();
  clearResizeLayoutSpotlightTimer();
  clearComposeActionSpotlightTimer();
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

watch(() => authStore.status, (status) => {
  if (status === AUTH_STATE.CONNECTED) {
    maybeShowWelcomeModal();
    return;
  }
  showWelcomeModal.value = false;
}, { immediate: true });

function startCompose() {
  composeStore.open();
}

function setQuickFilterQuery(event: Event) {
  const next = (event.target as HTMLInputElement | null)?.value ?? '';
  updateQuickFilterQuery(next);
}

function clearQuickFilterQuery() {
  updateQuickFilterQuery('');
}

function focusQuickFilterInput() {
  quickFilterInputEl.value?.focus();
  quickFilterInputEl.value?.select();
}

function updateQuickFilterQuery(next: string) {
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

function maybeShowWelcomeModal() {
  try {
    if (window.localStorage?.getItem(WELCOME_MODAL_STORAGE_KEY) === '1') {
      showWelcomeModal.value = false;
      return;
    }
  } catch {
    // If storage is blocked, keep the welcome as a session-only affordance.
  }
  showWelcomeModal.value = true;
}

function dismissWelcomeModal() {
  showWelcomeModal.value = false;
  quickFilterSpotlight.value = false;
  resizeLayoutSpotlight.value = false;
  composeActionSpotlight.value = false;
  clearQuickFilterSpotlightTimer();
  clearResizeLayoutSpotlightTimer();
  clearComposeActionSpotlightTimer();
  try {
    window.localStorage?.setItem(WELCOME_MODAL_STORAGE_KEY, '1');
  } catch {
    // Dismissal still applies for this session when storage is unavailable.
  }
}

function showWelcomeModalAgain() {
  if (authStore.status === AUTH_STATE.CONNECTED) {
    showWelcomeModal.value = true;
  }
}

function spotlightQuickFilter() {
  quickFilterSpotlight.value = true;
  clearQuickFilterSpotlightTimer();
  quickFilterSpotlightTimer = window.setTimeout(() => {
    quickFilterSpotlightTimer = null;
    quickFilterSpotlight.value = false;
  }, 3000);
}

function spotlightResizeLayout() {
  resizeLayoutSpotlight.value = true;
  clearResizeLayoutSpotlightTimer();
  startResizeLayoutDemo();
  resizeLayoutSpotlightTimer = window.setTimeout(() => {
    resizeLayoutSpotlightTimer = null;
    restoreResizeLayoutDemo();
    resizeLayoutSpotlight.value = false;
  }, 4600);
}

function spotlightComposeActions() {
  composeActionSpotlight.value = true;
  clearComposeActionSpotlightTimer();
  composeActionSpotlightTimer = window.setTimeout(() => {
    composeActionSpotlightTimer = null;
    composeActionSpotlight.value = false;
  }, 3400);
}

function clearQuickFilterSpotlightTimer() {
  if (quickFilterSpotlightTimer == null) return;
  window.clearTimeout(quickFilterSpotlightTimer);
  quickFilterSpotlightTimer = null;
}

function clearResizeLayoutSpotlightTimer() {
  if (resizeLayoutSpotlightTimer == null) return;
  window.clearTimeout(resizeLayoutSpotlightTimer);
  resizeLayoutSpotlightTimer = null;
  restoreResizeLayoutDemo();
}

function clearComposeActionSpotlightTimer() {
  if (composeActionSpotlightTimer == null) return;
  window.clearTimeout(composeActionSpotlightTimer);
  composeActionSpotlightTimer = null;
}

function startResizeLayoutDemo() {
  restoreResizeLayoutDemo();
  resizeLayoutDemoStart = {
    folderList: folderListWidth.value,
    messageList: messageListWidth.value,
  };

  const applyDemoStep = (delay: number, folderDelta: number, messageDelta: number) => {
    const timer = window.setTimeout(() => {
      if (!resizeLayoutDemoStart) return;
      folderListWidth.value = clamp(
        resizeLayoutDemoStart.folderList + folderDelta,
        MIN_COLUMN_WIDTHS.folderList,
        maxFolderListWidth(messageListWidth.value),
      );
      messageListWidth.value = clamp(
        resizeLayoutDemoStart.messageList + messageDelta,
        MIN_COLUMN_WIDTHS.messageList,
        maxMessageListWidth(folderListWidth.value),
      );
    }, delay);
    resizeLayoutDemoTimers.push(timer);
  };

  applyDemoStep(1200, 40, -30);
  applyDemoStep(2600, -24, 36);
  applyDemoStep(3900, 0, 0);
}

function restoreResizeLayoutDemo() {
  for (const timer of resizeLayoutDemoTimers) {
    window.clearTimeout(timer);
  }
  resizeLayoutDemoTimers = [];
  if (resizeLayoutDemoStart) {
    folderListWidth.value = resizeLayoutDemoStart.folderList;
    messageListWidth.value = resizeLayoutDemoStart.messageList;
    resizeLayoutDemoStart = null;
  }
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
  const compactMailLayout = space.value === 'mail' && windowWidth.value < COMPACT_READING_WIDTH;
  const singleColumnMailLayout = space.value === 'mail' && windowWidth.value < SINGLE_COLUMN_WIDTH;
  const shouldHideFolderList = singleColumnMailLayout || (compactMailLayout && showMessageView.value);
  const shouldShowSingleColumn = shouldUseSingleMailColumn.value;
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

  syncDisplayedMessageView({ delayForFolderSlide: willHideFolderList && !shouldShowSingleColumn });
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
  // services-ui drives theming off a `dark` class on <html>; we add an
  // explicit `light` class too so an explicit light choice can override
  // a dark system preference. Our own tokens key off the same classes.
  const root = document.documentElement;
  root.classList.toggle('dark', nextTheme === 'dark');
  root.classList.toggle('light', nextTheme === 'light');
  root.style.colorScheme = nextTheme;
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
      'shell--message-list-hidden': space === 'mail' && !displayedMessageList,
      'shell--folder-list-hidden': folderListHidden,
      'shell--contacts': space === 'contacts',
      'shell--column-resizing': activeResizePane !== null,
      'shell--resize-spotlight': resizeLayoutSpotlight,
      'shell--compose-spotlight': composeActionSpotlight,
    }"
    :style="shellStyle"
  >
    <div class="quick-filter">
      <details ref="appMenuEl" class="app-menu">
        <summary class="app-menu__button" aria-label="Open Thundermail menu">
          <ThundermailLogo :size="26" class="app-menu__logo" aria-hidden="true" />
          <span>Thundermail</span>
          <ChevronDown class="app-menu__chevron" :size="14" :stroke-width="2" aria-hidden="true" />
        </summary>
        <div class="app-menu__popover" role="menu">
          <a
            class="app-menu__item"
            :href="APPOINTMENT_URL"
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
          >
            <img src="/icons/icon-appointment.svg" class="app-menu__item-icon" alt="" aria-hidden="true" />
            <span>Appointment</span>
          </a>
          <a
            class="app-menu__item"
            :href="SEND_URL"
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
          >
            <img src="/icons/icon-send.svg" class="app-menu__item-icon" alt="" aria-hidden="true" />
            <span>Send</span>
          </a>
        </div>
      </details>

      <div
        class="quick-filter__search"
        :class="{ 'quick-filter__search--spotlight': quickFilterSpotlight }"
        role="search"
      >
        <input
          ref="quickFilterInputEl"
          class="quick-filter__input"
          type="search"
          :value="quickFilterQuery"
          aria-label="Quick Filter messages by from, to, or subject"
          :placeholder="quickFilterSpotlight ? '' : 'Quick Filter'"
          autocomplete="off"
          spellcheck="false"
          @input="setQuickFilterQuery"
        />
        <button
          v-if="quickFilterQuery.length > 0"
          class="quick-filter__clear"
          type="button"
          aria-label="Clear Quick Filter"
          title="Clear Quick Filter"
          @click="clearQuickFilterQuery"
        >
          <X :size="17" :stroke-width="2.25" aria-hidden="true" />
        </button>
      </div>

      <div class="quick-filter__actions">
        <a
          class="quick-filter__action"
          :href="BUG_REPORT_URL"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Report a bug"
          title="Report a bug"
        >
          <Bug :size="18" :stroke-width="1.75" aria-hidden="true" />
        </a>
        <a
          class="quick-filter__action"
          :href="FEEDBACK_URL"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Give feedback"
          title="Give feedback"
        >
          <Lightbulb :size="18" :stroke-width="1.75" aria-hidden="true" />
        </a>
        <button
          class="quick-filter__action theme-toggle"
          type="button"
          :aria-label="themeToggleLabel"
          :title="themeToggleLabel"
          @click="toggleTheme"
        >
          <Sun v-if="theme === 'dark'" :size="18" :stroke-width="1.75" aria-hidden="true" />
          <Moon v-else :size="18" :stroke-width="1.75" aria-hidden="true" />
        </button>
        <AccountAvatarMenu @show-welcome-modal="showWelcomeModalAgain" />
      </div>
    </div>

    <AppSpaces
      :active="space"
      :unread-count="inboxUnread"
      :folder-list-hidden="folderListHidden"
      :show-folder-list-toggle="space === 'mail'"
      @change="space = $event"
      @toggle-folder-list="toggleFolderList"
    />

    <div
      v-if="space === 'mail'"
      class="sidebar-slot"
      :class="{ 'sidebar-slot--hidden': folderListHidden }"
      :aria-hidden="folderListHidden"
      :inert="folderListHidden"
    >
      <aside class="sidebar">
        <header class="sidebar__header">
          <AppButton
            class="sidebar__compose"
            :class="{ 'sidebar__compose--spotlight': composeActionSpotlight }"
            @click="startCompose"
          >
            <template #iconLeft>
              <Plus :size="16" :stroke-width="2" />
            </template>
            New Message
          </AppButton>
        </header>

        <div class="sidebar__account">
          <span class="sidebar__account-name">{{ accountLabel }}</span>
        </div>

        <FolderTree v-if="space === 'mail'" />
        <p v-else class="sidebar__hint">Switch to Mail to navigate folders.</p>

        <footer class="sidebar__footer">
          <StorageUsageBar />
        </footer>
      </aside>
    </div>

    <div
      v-if="space === 'mail'"
      class="column-resizer column-resizer--folder-list"
      :class="{
        'is-active': activeResizePane === 'folderList',
        'column-resizer--hidden': folderListHidden,
        'column-resizer--spotlight': resizeLayoutSpotlight,
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
      <MessageList v-if="displayedMessageList" :quick-filter-query="quickFilterQuery" />
      <div
        v-if="displayedMessageView && displayedMessageList"
        class="column-resizer column-resizer--message-list"
        :class="{
          'is-active': activeResizePane === 'messageList',
          'column-resizer--spotlight': resizeLayoutSpotlight,
        }"
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
      <MessageView
        v-if="displayedMessageView"
        :spotlight-actions="composeActionSpotlight"
      />
    </template>
    <ContactsView v-else-if="space === 'contacts'" />

    <ComposeDialog />
    <StoreErrorToast />
    <BulkOperationOverlay />
    <WelcomeModal
      v-if="showWelcomeModal"
      @dismiss="dismissWelcomeModal"
      @spotlight-quick-filter="spotlightQuickFilter"
      @spotlight-resize-layout="spotlightResizeLayout"
      @spotlight-compose-actions="spotlightComposeActions"
    />
  </div>
</template>

<style>
:root {
  --surface: var(--panel);
  --fg: var(--text);
  --spaces-bar-height: calc(56px + env(safe-area-inset-bottom));
  --border-soft: color-mix(in srgb, var(--border) 55%, transparent);
  --accent-bg: color-mix(in srgb, var(--accent) 22%, var(--panel2));
  --accent-fg: var(--accent);
  --space-rail-bg: color-mix(in srgb, var(--panel) 88%, #fff);
  --space-rail-fg: var(--muted);
  --folder-list-bg: color-mix(in srgb, var(--panel) 96%, #fff);
  --app-menu-popover-bg: color-mix(in srgb, var(--panel) 92%, #fff);
}

html.light,
.light {
  --space-rail-bg: color-mix(in srgb, var(--panel2) 96%, #000);
  --folder-list-bg: color-mix(in srgb, var(--panel) 97%, #000);
  --app-menu-popover-bg: var(--panel2);
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
  height: var(--app-viewport-height);
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
.shell--message-list-hidden {
  grid-template-columns:
    56px
    auto
    var(--folder-resizer-width)
    0px
    0px
    minmax(0, 1fr);
}
.shell--folder-list-hidden {
  --folder-resizer-width: 0px;
}
.shell--contacts {
  grid-template-columns: 56px minmax(0, 1fr);
}
.shell--resize-spotlight {
  transition: grid-template-columns 0.55s ease;
}
.shell--compose-spotlight .sidebar-slot,
.shell--compose-spotlight .message-view {
  position: relative;
  z-index: 130;
}
/* Grid items default to min-height: auto, which makes inner
 * overflow:auto containers grow to their content instead of scrolling.
 * Force every shell column to be allowed to shrink so its children can
 * own the vertical scroll. */
.shell > * { min-height: 0; min-width: 0; }
.shell > .msg-list {
  grid-column: 4;
  border-right: 0;
}
.shell > .message-view {
  grid-column: 6;
}
.shell--message-list-hidden > .message-view {
  grid-column: 4 / -1;
}
.shell > .contacts { grid-column: 4 / -1; }
.shell--contacts > .contacts { grid-column: 2 / -1; }
.shell--folder-list-hidden > .contacts { grid-column: 2 / -1; }

.quick-filter {
  grid-column: 1 / -1;
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  column-gap: 12px;
  min-height: 56px;
  padding: 10px 16px;
  background: var(--space-rail-bg);
  border-bottom: 1px solid var(--border);
}
.quick-filter > .app-menu {
  justify-self: start;
  position: relative;
  z-index: 30;
  margin-left: -7px;
}
.quick-filter > .quick-filter__search {
  justify-self: center;
}
.quick-filter__actions {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.quick-filter__action,
.quick-filter__action.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-decoration: none;
}
.quick-filter__action:hover,
.quick-filter__action:focus-visible,
.quick-filter__action.theme-toggle:hover,
.quick-filter__action.theme-toggle:focus-visible {
  background: var(--rowHover);
  border-color: var(--border-soft);
  outline: none;
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
.app-menu[open] .app-menu__button {
  position: relative;
  z-index: 31;
  background: var(--app-menu-popover-bg);
  border-color: var(--border);
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
  z-index: 30;
  top: calc(100% - 1px);
  left: 0;
  min-width: 240px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--app-menu-popover-bg);
  box-shadow: 0 16px 32px color-mix(in srgb, #000 32%, transparent);
}
.app-menu[open] .app-menu__popover {
  margin-top: 4px;
}
.app-menu__item-icon {
  filter: drop-shadow(0 2px 3px color-mix(in srgb, #000 20%, transparent));
}
.app-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 8px 10px 8px 0;
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
  position: relative;
  width: clamp(160px, 40vw, 520px);
}
.quick-filter__search--spotlight {
  z-index: 130;
}
.quick-filter__search--spotlight::before {
  content: "";
  position: absolute;
  inset: -7px;
  border: 1px solid color-mix(in srgb, var(--accent) 78%, #fff);
  border-radius: 999px;
  box-shadow:
    0 0 0 7px color-mix(in srgb, var(--accent) 18%, transparent),
    0 18px 46px color-mix(in srgb, #000 32%, transparent);
  pointer-events: none;
  animation: quick-filter-spotlight-pulse 1.4s ease-in-out infinite;
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
  padding: 0 40px 0 16px;
  outline: none;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 8%, transparent);
}
.quick-filter__search--spotlight .quick-filter__input {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.quick-filter__input::placeholder {
  color: var(--muted);
}
.quick-filter__input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.quick-filter__clear {
  position: absolute;
  top: 50%;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  line-height: 1;
  transform: translateY(-50%);
}
.quick-filter__clear svg {
  display: block;
}
.quick-filter__clear:hover,
.quick-filter__clear:focus-visible {
  background: var(--rowHover);
  border-color: var(--border-soft);
  color: var(--text);
  outline: none;
}

@keyframes quick-filter-spotlight-pulse {
  0%, 100% {
    opacity: 0.82;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.025);
  }
}

@keyframes control-spotlight-pulse {
  0%, 100% {
    filter: brightness(1);
  }
  50% {
    filter: brightness(1.16);
  }
}

@media (max-width: 639px) {
  .shell {
    --folder-resizer-width: 0px;
  }
  .shell .sidebar-slot {
    position: absolute;
    z-index: 70;
    top: 56px;
    bottom: 0;
    left: 56px;
    width: min(var(--folder-list-width, 240px), calc(100vw - 56px));
    max-width: calc(100vw - 56px);
    height: auto;
    transform: translateX(0);
    transition: transform var(--folder-list-transition-ms, 360ms) ease,
      box-shadow var(--folder-list-transition-ms, 360ms) ease;
    box-shadow: 18px 0 34px color-mix(in srgb, #000 28%, transparent);
  }
  .shell .sidebar-slot--hidden {
    width: min(var(--folder-list-width, 240px), calc(100vw - 56px));
    transform: translateX(-100%);
    box-shadow: none;
    pointer-events: none;
  }
  .shell .sidebar {
    width: 100%;
    transform: none;
  }
  .shell .column-resizer--folder-list {
    display: none;
  }
  .shell--message-view-hidden > .msg-list,
  .shell--message-list-hidden > .message-view,
  .shell > .contacts {
    grid-column: 2 / -1;
  }
  .quick-filter {
    grid-template-columns: auto 1fr auto;
    column-gap: 8px;
    padding-left: 8px;
    padding-right: 8px;
  }
  .app-menu__button span {
    display: none;
  }
  .quick-filter > .quick-filter__search {
    justify-self: stretch;
  }
  .quick-filter__search {
    width: 100%;
  }
}

@media (max-width: 639px) {
  .shell,
  .shell--message-view-hidden,
  .shell--message-list-hidden {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) var(--spaces-bar-height);
  }
  .quick-filter {
    grid-column: 1;
    grid-row: 1;
  }
  .shell > .app-spaces {
    grid-column: 1;
    grid-row: 3;
  }
  .shell .sidebar-slot {
    top: 56px;
    bottom: var(--spaces-bar-height);
    left: 0;
    width: min(var(--folder-list-width, 240px), 100vw);
    max-width: 100vw;
  }
  .shell .sidebar-slot--hidden {
    width: min(var(--folder-list-width, 240px), 100vw);
  }
  .shell > .msg-list,
  .shell > .message-view,
  .shell > .contacts,
  .shell--message-view-hidden > .msg-list,
  .shell--message-list-hidden > .message-view,
  .shell--folder-list-hidden > .contacts {
    grid-column: 1;
    grid-row: 2;
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
.shell--column-resizing .sidebar-slot,
.shell--column-resizing .sidebar {
  transition: none;
}
.sidebar-slot--hidden {
  width: 0;
}
.sidebar {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  background: var(--folder-list-bg);
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
.sidebar > * {
  min-width: 0;
}
.sidebar > :nth-child(3) { min-height: 0; overflow-y: auto; }
.sidebar__header {
  min-width: 0;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--border-soft);
}
/* New Message is our AppButton (services-ui PrimaryButton wrapper, which
   owns the 34px height and bold label). Here we only stretch it to the
   sidebar width; colour/hover stay owned by services-ui. */
.sidebar__compose {
  width: 100%;
  max-width: 100%;
}
.sidebar__compose--spotlight {
  position: relative;
  z-index: 130;
  box-shadow:
    0 0 0 5px color-mix(in srgb, var(--accent) 18%, transparent),
    0 0 0 1px color-mix(in srgb, var(--accent) 60%, #fff),
    0 12px 28px color-mix(in srgb, #000 20%, transparent);
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
.column-resizer {
  position: relative;
  background: var(--folder-list-bg);
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
.column-resizer--spotlight {
  z-index: 90;
}
.column-resizer--spotlight::before {
  background: var(--accent);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--accent) 24%, transparent),
    0 0 22px color-mix(in srgb, var(--accent) 64%, transparent);
  animation: control-spotlight-pulse 1.4s ease-in-out infinite;
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
