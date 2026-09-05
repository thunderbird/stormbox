<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useTitle } from '@vueuse/core';
import { Bug, Lightbulb, Moon, Plus, Sun, X } from '@lucide/vue';
import AppButton from './components/AppButton.vue';
import mailGlyph from './assets/icons/tb-mail-glyph.svg?raw';

import { useColumnResize } from './composables/useColumnResize';
import {
  DIRECTORY_COLUMN_MIN_WIDTHS,
  DIRECTORY_RESIZER_WIDTH,
} from './composables/useDirectoryColumnResize';
import { useThunderbirdShortcuts } from './composables/useThunderbirdShortcuts';
import { APP_TITLE } from './app-config';
import { BUG_REPORT_URL, FEEDBACK_URL } from './defines';

import { useAuthStore } from './stores/auth-store';
import { useMailStore } from './stores/mail-store';
import { useContactsStore } from './stores/contacts-store';
import { useComposeStore } from './stores/compose-store';
import { useSettingsStore } from './stores/settings-store';
import { AUTH_STATE } from './constants/states';
import type { Palette, Theme } from './constants/settings';
import { shortcutModifierAria, shortcutModifierLabel } from './utils/keyboard';

import AppSpaces from './components/AppSpaces.vue';
import LoginGate from './components/LoginGate.vue';
import FolderTree from './components/FolderTree.vue';
import MessageList from './components/MessageList.vue';
import MessageView from './components/MessageView.vue';
import ComposeManager from './components/ComposeManager.vue';
import ContactsView from './components/ContactsView.vue';
import StorageUsageBar from './components/StorageUsageBar.vue';
import StoreErrorToast from './components/StoreErrorToast.vue';
import BulkOperationOverlay from './components/BulkOperationOverlay.vue';
import AppDrawer from './components/AppDrawer.vue';
import TopNavMenu from './components/TopNavMenu.vue';
import AccountAvatarMenu from './components/AccountAvatarMenu.vue';
import WelcomeModal from './components/WelcomeModal.vue';
// Staff-only Kanban feature (src/features/kanban): the gear button gates
// the flag; the board replaces MessageList only while the flag is on.
// Both are async so a non-staff session never downloads the feature
// (the gear chunk carries the dialog, fireworks and audio clip).
import { useKanbanStore } from './features/kanban/kanban-store';

const StaffGearButton = defineAsyncComponent(() => import('./features/kanban/StaffGearButton.vue'));
const KanbanBoard = defineAsyncComponent(() => import('./features/kanban/KanbanBoard.vue'));

const authStore = useAuthStore();
const mailStore = useMailStore();
const contactsStore = useContactsStore();
const composeStore = useComposeStore();
const settingsStore = useSettingsStore();
const kanbanStore = useKanbanStore();

type AppSpace = 'contacts' | 'mail';

interface ContactsViewHandle {
  requestFilterChange: (next: string) => Promise<boolean>;
  requestLeave: () => Promise<boolean>;
}

const space = ref<AppSpace>('mail');
const contactsViewEl = ref<ContactsViewHandle | null>(null);
// ContactsView teleports its address-book rail into this shell element so the
// rail shares the folder list's slot, width, toggle, and drawer (CT-1.3).
const CONTACTS_SIDEBAR_ID = 'contacts-sidebar';
const contactsDetailVisible = ref(false);
const sidebarLabel = computed(() =>
  space.value === 'contacts' ? 'address book list' : 'folder list');
const quickFilterQuery = ref('');
const quickFilterSpotlight = ref(false);
const resizeLayoutSpotlight = ref(false);
const composeActionSpotlight = ref(false);
const quickFilterPlaceholder = computed(() =>
  space.value === 'contacts' ? 'Filter contacts or identities' : 'Filter messages',
);
const quickFilterAriaLabel = computed(() =>
  space.value === 'contacts'
    ? 'Filter contacts or identities by name or email address'
    : 'Quick Filter messages by from, to, or subject',
);
const quickFilterShortcutLabel = `${shortcutModifierLabel()}+K`;
const quickFilterAriaShortcut = `${shortcutModifierAria()}+K`;

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
const WELCOME_MODAL_STORAGE_KEY = 'stormbox.welcomeModalDismissed.v1';
const SPACE_RAIL_WIDTH = 56;
const RESIZER_WIDTH = 6;
const COMPACT_READING_WIDTH = 1024;
const SINGLE_COLUMN_WIDTH = 640;
const FOLDER_LIST_TRANSITION_MS = 360;
const MESSAGE_VIEW_PRELOAD_MS = 50;
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
const theme = computed<Theme>(() => settingsStore.get('theme'));
const appliedTheme = ref<'dark' | 'light'>(resolveTheme(theme.value));
applyTheme(theme.value);
watch(theme, (value) => applyTheme(value));
const palette = computed<Palette>(() => settingsStore.get('palette'));
applyPalette(palette.value);
watch(palette, (value) => applyPalette(value));
const themeToggleLabel = computed(() =>
  appliedTheme.value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
const folderListWidth = ref(DEFAULT_COLUMN_WIDTHS.folderList);
const messageListWidth = ref(DEFAULT_COLUMN_WIDTHS.messageList);
const folderListHidden = ref(false);
const showWelcomeModal = ref(false);
const shortcutsEnabled = computed(() =>
  authStore.status === AUTH_STATE.CONNECTED && !showWelcomeModal.value,
);
const windowWidth = ref(typeof window === 'undefined' ? COMPACT_READING_WIDTH : window.innerWidth);
const wantsMessageDetailView = computed(() =>
  mailStore.selectedMessageId != null
  || resizeLayoutSpotlight.value
  || composeActionSpotlight.value,
);
// Multi-select never opens the message view: the bulk actions live in
// the message list header, so a checkbox selection hides the reading
// pane entirely (and works the same in single-column layouts). The
// kanban board's column selection follows the same rule.
const showMessageView = computed(() =>
  wantsMessageDetailView.value
  && mailStore.selectedIds.size === 0
  && !(kanbanStore.enabled && kanbanStore.hasSelection),
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
// The board beside an open message sizes its own track and carries its
// own handle, so the shell's list width and list resizer step aside.
const kanbanCompact = computed(() =>
  space.value === 'mail'
  && kanbanStore.enabled
  && displayedMessageList.value
  && displayedMessageView.value);
let messageViewTimer: number | null = null;
let quickFilterSpotlightTimer: number | null = null;
let resizeLayoutSpotlightTimer: number | null = null;
let composeActionSpotlightTimer: number | null = null;
let resizeLayoutDemoStart: { folderList: number; messageList: number } | null = null;
let resizeLayoutDemoTimers: number[] = [];
let responsiveFolderListHidden = false;

const shellStyle = computed(() => ({
  '--folder-list-width': `${folderListWidth.value}px`,
  '--message-list-width': `${messageListWidth.value}px`,
  '--message-list-min-width': `${MIN_COLUMN_WIDTHS.messageList}px`,
  '--message-view-min-width': `${MIN_COLUMN_WIDTHS.messageView}px`,
  '--column-resizer-width': `${RESIZER_WIDTH}px`,
  '--folder-list-transition-ms': `${FOLDER_LIST_TRANSITION_MS}ms`,
}));

const {
  activeResizePane,
  clampPane,
  onResizeHandleKeydown,
  startColumnResize,
} = useColumnResize<ResizePane>({
  panes: {
    folderList: {
      get: () => folderListWidth.value,
      max: (widths) => maxFolderListWidth(widths.messageList),
      min: () => MIN_COLUMN_WIDTHS.folderList,
      set: (width) => {
        folderListWidth.value = width;
      },
      storageKey: 'folderList',
    },
    messageList: {
      get: () => messageListWidth.value,
      max: (widths) => maxMessageListWidth(widths.folderList),
      min: () => MIN_COLUMN_WIDTHS.messageList,
      set: (width) => {
        messageListWidth.value = width;
      },
      storageKey: 'messageList',
    },
  },
  storageKey: RESIZE_STORAGE_KEY,
});

useThunderbirdShortcuts({
  space,
  enabled: shortcutsEnabled,
  focusQuickFilter: focusQuickFilterInput,
});

let appMounted = false;

onMounted(async () => {
  appMounted = true;
  applyTheme(theme.value);
  applyPalette(palette.value);
  watchSystemTheme();
  applyResponsiveLayout();
  clampColumnWidths();
  window.addEventListener('resize', onWindowResize);

  void settingsStore.attach().catch((error) => {
    console.warn('[app] settings attach failed', error);
  });
  await authStore.initialize();
  if (!appMounted) return;
  await mailStore.attach();
  if (!appMounted) return;
  await contactsStore.attach();
  if (!appMounted) return;
  await composeStore.attach();
});

onBeforeUnmount(() => {
  appMounted = false;
  clearMessageViewTimer();
  clearQuickFilterSpotlightTimer();
  clearResizeLayoutSpotlightTimer();
  clearComposeActionSpotlightTimer();
  window.removeEventListener('resize', onWindowResize);
  unwatchSystemTheme();
  settingsStore.detach();
});

watch(showMessageView, () => {
  applyResponsiveLayout();
  clampColumnWidths();
});

let contactFilterGeneration = 0;
let contactFilterTransition: Promise<boolean> | null = null;

watch(space, () => {
  contactFilterGeneration += 1;
  quickFilterQuery.value = '';
  if (space.value !== 'contacts') contactsDetailVisible.value = false;
  applyResponsiveLayout();
  clampColumnWidths();
});

watch(contactsDetailVisible, () => {
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
  void updateQuickFilterQuery(next);
}

function clearQuickFilterQuery() {
  void updateQuickFilterQuery('');
}

function focusQuickFilterInput() {
  quickFilterInputEl.value?.focus();
  quickFilterInputEl.value?.select();
}

async function updateQuickFilterQuery(next: string) {
  if (space.value === 'contacts' && contactsViewEl.value) {
    if (next === quickFilterQuery.value && !contactFilterTransition) return;
    const generation = ++contactFilterGeneration;
    const transition = contactFilterTransition
      ?? contactsViewEl.value.requestFilterChange(next);
    contactFilterTransition = transition;
    let allowed: boolean;
    try {
      allowed = await transition;
    } finally {
      if (contactFilterTransition === transition) {
        contactFilterTransition = null;
      }
    }
    if (generation !== contactFilterGeneration || space.value !== 'contacts') {
      return;
    }
    if (!allowed) {
      await nextTick();
      if (quickFilterInputEl.value) {
        quickFilterInputEl.value.value = quickFilterQuery.value;
      }
      return;
    }
    quickFilterQuery.value = next;
    return;
  }
  if (next === quickFilterQuery.value) return;
  if (space.value === 'mail' && mailStore.selectedMessageId != null) {
    mailStore.selectMessage(null);
  }
  quickFilterQuery.value = next;
}

async function requestSpaceChange(next: string) {
  if (next !== 'mail' && next !== 'contacts') return;
  if (next === space.value) return;
  if (
    space.value === 'contacts'
    && contactsViewEl.value
    && !await contactsViewEl.value.requestLeave()
  ) return;
  space.value = next;
}

function toggleFolderList() {
  folderListHidden.value = !folderListHidden.value;
  responsiveFolderListHidden = false;
}

function toggleTheme() {
  const nextTheme = appliedTheme.value === 'dark' ? 'light' : 'dark';
  void settingsStore.update({ theme: nextTheme }).catch((error) => {
    console.warn('[app] theme update failed', error);
  });
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

function onWindowResize() {
  windowWidth.value = window.innerWidth;
  applyResponsiveLayout();
  clampColumnWidths();
}

// The active space's detail pane: the message view in Mail, the contact,
// identity, or address-book pane in Contacts. Both collapse the sidebar in
// the compact layout (R-10.2, CT-1.3).
function detailPaneVisible() {
  return space.value === 'contacts' ? contactsDetailVisible.value : showMessageView.value;
}

function applyResponsiveLayout() {
  const compactLayout = windowWidth.value < COMPACT_READING_WIDTH;
  const singleColumnLayout = windowWidth.value < SINGLE_COLUMN_WIDTH;
  const shouldHideFolderList = singleColumnLayout || (compactLayout && detailPaneVisible());
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

  syncDisplayedMessageView({
    delayForFolderSlide: space.value === 'mail' && willHideFolderList && !shouldShowSingleColumn,
  });
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

function availablePaneWidth() {
  const shellWidth = shellEl.value?.clientWidth || window.innerWidth || 0;
  const messageViewResizer = space.value === 'mail' && displayedMessageView.value && !kanbanCompact.value ? 1 : 0;
  const resizerCount = (folderListHidden.value ? 0 : 1) + messageViewResizer;
  return Math.max(0, shellWidth - SPACE_RAIL_WIDTH - resizerCount * RESIZER_WIDTH);
}

// Width the columns beside the sidebar need so it can never push them into
// horizontal overflow (R-10.1): the Contacts columns at their minimums, and in
// Mail the message list at its current width plus the message view minimum.
function sidebarNeighbourReserve(messageList: number) {
  if (space.value === 'contacts') {
    return contactsDetailVisible.value
      ? DIRECTORY_COLUMN_MIN_WIDTHS.list + DIRECTORY_RESIZER_WIDTH + DIRECTORY_COLUMN_MIN_WIDTHS.detail
      : DIRECTORY_COLUMN_MIN_WIDTHS.list;
  }
  if (kanbanCompact.value) {
    return kanbanStore.compactBoardWidth + MIN_COLUMN_WIDTHS.messageView;
  }
  return displayedMessageView.value
    ? messageList + MIN_COLUMN_WIDTHS.messageView
    : MIN_COLUMN_WIDTHS.messageList;
}

function maxFolderListWidth(messageList: number) {
  return Math.min(
    MAX_COLUMN_WIDTHS.folderList,
    availablePaneWidth() - sidebarNeighbourReserve(messageList),
  );
}

function maxMessageListWidth(folderList: number) {
  const reserve = displayedMessageView.value ? MIN_COLUMN_WIDTHS.messageView : 0;
  const folderReserve = folderListHidden.value ? 0 : folderList;
  return Math.min(MAX_COLUMN_WIDTHS.messageList, availablePaneWidth() - folderReserve - reserve);
}

function clampColumnWidths() {
  if (!folderListHidden.value) {
    clampPane('folderList');
  }
  if (space.value === 'mail') {
    clampPane('messageList');
  }
}

function resolveTheme(value: Theme): 'dark' | 'light' {
  if (value !== 'system') return value;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

function applyTheme(value: Theme) {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(value);
  appliedTheme.value = resolved;
  // services-ui drives theming off a `dark` class on <html>; we add an
  // explicit `light` class too so an explicit light choice can override
  // a dark system preference. Our own tokens key off the same classes.
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
  root.style.colorScheme = resolved;
}

// The stylesheets default to the classic palette; `palette-bolt` on <html>
// activates every Bolt override in assets/bolt-theme.css.
function applyPalette(value: Palette) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('palette-bolt', value === 'bolt');
}

let systemThemeMedia: MediaQueryList | null = null;

function onSystemThemeChange() {
  if (theme.value === 'system') applyTheme('system');
}

function watchSystemTheme() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: light)');
  systemThemeMedia.addEventListener?.('change', onSystemThemeChange);
}

function unwatchSystemTheme() {
  systemThemeMedia?.removeEventListener?.('change', onSystemThemeChange);
  systemThemeMedia = null;
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
      'shell--kanban-compact': kanbanCompact,
      'shell--folder-list-hidden': folderListHidden,
      'shell--contacts': space === 'contacts',
      'shell--column-resizing': activeResizePane !== null,
      'shell--resize-spotlight': resizeLayoutSpotlight,
      'shell--compose-spotlight': composeActionSpotlight,
    }"
    :style="shellStyle"
  >
    <header class="quick-filter">
      <div class="quick-filter__brand">
        <span class="quick-filter__glyph" aria-hidden="true" v-html="mailGlyph" />
        <span class="quick-filter__wordmark">Mail</span>
      </div>

      <TopNavMenu
        class="quick-filter__menu"
        :theme="appliedTheme"
        :theme-toggle-label="themeToggleLabel"
        @toggle-theme="toggleTheme"
      />

      <div
        class="quick-filter__search"
        :class="{ 'quick-filter__search--spotlight': quickFilterSpotlight }"
        role="search"
      >
        <input
          ref="quickFilterInputEl"
          class="quick-filter__input"
          :class="{ 'quick-filter__input--empty': quickFilterQuery.length === 0 }"
          type="search"
          :value="quickFilterQuery"
          :aria-label="quickFilterAriaLabel"
          :aria-keyshortcuts="quickFilterAriaShortcut"
          :placeholder="quickFilterSpotlight ? '' : quickFilterPlaceholder"
          autocomplete="off"
          spellcheck="false"
          @input="setQuickFilterQuery"
        />
        <kbd
          v-if="quickFilterQuery.length === 0"
          class="quick-filter__shortcut"
          aria-hidden="true"
        >{{ quickFilterShortcutLabel }}</kbd>
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
        <StaffGearButton v-if="authStore.isStaff" />
        <button
          class="quick-filter__action theme-toggle"
          type="button"
          :aria-label="themeToggleLabel"
          :title="themeToggleLabel"
          @click="toggleTheme"
        >
          <Sun v-if="appliedTheme === 'dark'" :size="18" :stroke-width="1.75" aria-hidden="true" />
          <Moon v-else :size="18" :stroke-width="1.75" aria-hidden="true" />
        </button>
        <AppDrawer />
        <AccountAvatarMenu @show-welcome-modal="showWelcomeModalAgain" />
      </div>
    </header>

    <AppSpaces
      :active="space"
      :unread-count="inboxUnread"
      :folder-list-hidden="folderListHidden"
      :sidebar-label="sidebarLabel"
      @change="requestSpaceChange"
      @toggle-folder-list="toggleFolderList"
    />

    <div
      class="sidebar-slot"
      :class="{ 'sidebar-slot--hidden': folderListHidden }"
      :aria-hidden="folderListHidden"
      :inert="folderListHidden"
    >
      <aside v-if="space === 'mail'" class="sidebar">
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

        <FolderTree />

        <footer class="sidebar__footer">
          <StorageUsageBar />
        </footer>
      </aside>
      <div
        v-else
        :id="CONTACTS_SIDEBAR_ID"
        class="sidebar sidebar--contacts"
      />
    </div>

    <div
      class="column-resizer column-resizer--folder-list"
      :class="{
        'is-active': activeResizePane === 'folderList',
        'column-resizer--hidden': folderListHidden,
        'column-resizer--spotlight': resizeLayoutSpotlight,
      }"
      role="separator"
      :aria-label="`Resize ${sidebarLabel}`"
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
      <KanbanBoard
        v-if="displayedMessageList && kanbanStore.enabled"
        :compact="displayedMessageView"
        :quick-filter-query="quickFilterQuery"
      />
      <MessageList v-else-if="displayedMessageList" :quick-filter-query="quickFilterQuery" />
      <div
        v-if="displayedMessageView && displayedMessageList && !kanbanCompact"
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
    <ContactsView
      v-else-if="space === 'contacts'"
      ref="contactsViewEl"
      :filter-query="quickFilterQuery"
      :rail-target="`#${CONTACTS_SIDEBAR_ID}`"
      @detail-visible-change="contactsDetailVisible = $event"
    />

    <ComposeManager />
    <StoreErrorToast />
    <BulkOperationOverlay
      :active="mailStore.bulkOperation.active"
      item-label="messages"
      :label="mailStore.bulkOperation.label"
      singular-item-label="message"
      :total="mailStore.bulkOperation.total"
    />
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
  /* Top nav: same 56px band as before, sharing the rail's surface. The
     Bolt palette (assets/bolt-theme.css) re-points these tokens. */
  --top-nav-height: 56px;
  --top-nav-bg: var(--space-rail-bg);
  --top-nav-border: var(--border);
  --top-nav-shadow: transparent;
  --top-nav-wordmark: #fff;
  --top-nav-input-bg: var(--surface);
  --top-nav-popover-bg: color-mix(in srgb, var(--panel) 92%, #fff);
}

html.light,
.light {
  --space-rail-bg: color-mix(in srgb, var(--panel2) 96%, #000);
  --folder-list-bg: color-mix(in srgb, var(--panel) 97%, #000);
  --top-nav-wordmark: var(--accent);
  --top-nav-popover-bg: var(--panel2);
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
/* Kanban board beside an open message: the board sets its own width
 * (two columns plus their handles) and its last handle replaces the
 * shell's list resizer. */
.shell--kanban-compact {
  grid-template-columns:
    56px
    auto
    var(--folder-resizer-width)
    auto
    0px
    minmax(var(--message-view-min-width, 320px), 1fr);
}
.shell--contacts {
  grid-template-columns:
    56px
    auto
    var(--folder-resizer-width)
    minmax(0, 1fr);
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
.shell > .kanban-board {
  grid-column: 4;
}
.shell > .message-view {
  grid-column: 6;
}
.shell--message-list-hidden > .message-view {
  grid-column: 4 / -1;
}
.shell > .contacts { grid-column: 4 / -1; }

.quick-filter {
  grid-column: 1 / -1;
  position: relative;
  display: flex;
  align-items: center;
  column-gap: 16px;
  height: var(--top-nav-height);
  padding: 0 16px 0 14px;
  background: var(--top-nav-bg);
  /* Hairline as an inset shadow, not a border: keeps the content box the
   * full 56px so even-height items centre on whole pixels. */
  box-shadow: inset 0 -1px 0 var(--top-nav-border);
}
/* Drop shadow onto the panes below. The bar itself carries no z-index so
 * the welcome tour can still lift .quick-filter__search above its backdrop. */
.quick-filter::after {
  content: "";
  position: absolute;
  z-index: 1;
  top: 100%;
  left: 0;
  right: 0;
  height: 8px;
  background: linear-gradient(to bottom, var(--top-nav-shadow), transparent);
  pointer-events: none;
}
.quick-filter__brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  flex-shrink: 0;
  user-select: none;
}
.quick-filter__glyph {
  display: inline-flex;
  width: 24px;
  height: 24px;
  color: var(--accent);
}
.quick-filter__glyph svg {
  display: block;
  width: 100%;
  height: 100%;
}
.quick-filter__wordmark {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.01em;
  color: var(--top-nav-wordmark);
}
/* Compact layouts only; see the 639px media query. */
.quick-filter__menu {
  display: none;
}
.quick-filter__actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.quick-filter__actions > .account-menu {
  margin-left: 2px;
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
.quick-filter__search {
  position: relative;
  flex: 0 1 360px;
  min-width: 160px;
  margin: 0 auto;
}
.quick-filter__search--spotlight {
  z-index: 130;
}
.quick-filter__search--spotlight::before {
  content: "";
  position: absolute;
  inset: -7px;
  border: 1px solid color-mix(in srgb, var(--accent) 78%, #fff);
  border-radius: 15px;
  box-shadow:
    0 0 0 7px color-mix(in srgb, var(--accent) 18%, transparent),
    0 18px 46px color-mix(in srgb, #000 32%, transparent);
  pointer-events: none;
  animation: quick-filter-spotlight-pulse 1.4s ease-in-out infinite;
}
.quick-filter__input {
  width: 100%;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--top-nav-input-bg);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  padding: 0 40px 0 14px;
  outline: none;
}
.quick-filter__input--empty {
  padding-right: 70px;
}
.quick-filter__search--spotlight .quick-filter__input {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
/* .quick-filter__clear occupies the padding gutter, so the WebKit search
   affordances would sit beside it as a second clear button. */
.quick-filter__input::-webkit-search-cancel-button,
.quick-filter__input::-webkit-search-decoration {
  -webkit-appearance: none;
  appearance: none;
}
.quick-filter__input::placeholder {
  color: var(--muted);
}
.quick-filter__input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.quick-filter__shortcut {
  position: absolute;
  top: 50%;
  right: 12px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface) 88%, var(--rowHover));
  color: var(--muted);
  font-family: inherit;
  font-size: 11px;
  line-height: 1.2;
  pointer-events: none;
  transform: translateY(-50%);
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
    /* Under `.compose-dialog` (50), which is a modal and has to be reachable
       from the one control that opens it here — the New Message button inside
       this drawer. At 70 the drawer covered the dialog it had just opened, and
       took its taps with it, which is what made compose unusable on a phone
       (CS-2.9). Nothing else occupies the band between the mail columns and
       the dialog, so this only reorders those two. */
    z-index: 40;
    top: var(--top-nav-height);
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
  .shell--message-list-hidden > .message-view {
    grid-column: 2 / -1;
  }
  /* Same 56px band: glyph, full-width filter, menu and avatar in one row.
     The wordmark and the desktop-only actions give the filter their room. */
  .quick-filter {
    column-gap: 8px;
    padding: 0 8px;
  }
  .quick-filter__wordmark {
    display: none;
  }
  .quick-filter__search {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
  }
  .quick-filter__menu {
    display: block;
  }
  .quick-filter__actions > :not(.account-menu) {
    display: none;
  }
  .quick-filter__actions > .account-menu {
    margin-left: 0;
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
    top: var(--top-nav-height);
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
  .shell--message-list-hidden > .message-view {
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
.sidebar--contacts {
  grid-template-rows: minmax(0, 1fr);
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
