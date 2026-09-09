<script setup lang="ts">
import { Keyboard, X } from '@lucide/vue';
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
} from 'vue';

import { useModalFocus } from '../composables/useModalFocus';
import { FEATURE_CARDS, type SpotlightId } from '../constants/feature-tour';
import type { SpotlightProgress } from '../composables/useFeatureSpotlight';
import type { ShortcutScheme } from '../constants/settings';
import { shortcutHint, type ShortcutAction } from '../constants/shortcuts';
import { useSettingsStore } from '../stores/settings-store';
import AppButton from './AppButton.vue';
import FeatureCardGrid from './FeatureCardGrid.vue';
import ShortcutSchemePicker from './settings/ShortcutSchemePicker.vue';
import ThundermailLogo from './ThundermailLogo.vue';

const props = withDefaults(defineProps<{
  activeSpotlight?: SpotlightId | null;
  progress?: SpotlightProgress | null;
  reducedMotion?: boolean;
  /** The phone layout has no keyboard, so the shortcuts section is dropped (OB-1.4). */
  singleColumn?: boolean;
}>(), {
  activeSpotlight: null,
  progress: null,
  reducedMotion: false,
  singleColumn: false,
});

const emit = defineEmits<{
  dismiss: [];
  spotlight: [id: SpotlightId];
  cancelSpotlight: [];
}>();

const panelEl = ref<HTMLElement | null>(null);
useModalFocus(panelEl, { containTab: true, onDefault: dismiss });
const settingsStore = useSettingsStore();
const shortcutScheme = computed(() => settingsStore.get('shortcutScheme'));

const SCHEME_HINTS: Record<ShortcutScheme, string> = {
  web: 'Web shortcuts avoid conflicting with the browser. You can change shortcut style later in Settings.',
  thunderbird: 'Thunderbird shortcuts are the same as desktop, but may conflict with the browser in some cases.',
};
const schemeHint = computed(() => SCHEME_HINTS[shortcutScheme.value]);

const SHORTCUT_GROUPS: ReadonlyArray<{
  title: string;
  shortcuts: ReadonlyArray<{ action: ShortcutAction; label: string }>;
}> = [
  {
    title: 'Find and compose',
    shortcuts: [
      { action: 'compose', label: 'New message' },
      { action: 'reply', label: 'Reply' },
      { action: 'replyAll', label: 'Reply all' },
      { action: 'forward', label: 'Forward' },
      { action: 'quickFilter', label: 'Focus Quick Filter' },
    ],
  },
  {
    title: 'Navigate',
    shortcuts: [
      { action: 'next', label: 'Next message' },
      { action: 'previous', label: 'Previous message' },
      { action: 'nextUnread', label: 'Next unread' },
      { action: 'previousUnread', label: 'Previous unread' },
      { action: 'first', label: 'First message' },
      { action: 'last', label: 'Last message' },
    ],
  },
  {
    title: 'Message actions',
    shortcuts: [
      { action: 'archive', label: 'Archive' },
      { action: 'delete', label: 'Delete' },
      { action: 'deleteForever', label: 'Delete permanently' },
      { action: 'toggleRead', label: 'Mark read or unread' },
      { action: 'selectAll', label: 'Select all' },
      { action: 'clearSelection', label: 'Clear selection' },
    ],
  },
];

// Actions without a binding in the active scheme are left out of their group.
const shortcutGroups = computed(() => SHORTCUT_GROUPS.map((group) => ({
  title: group.title,
  shortcuts: group.shortcuts.flatMap(({ action, label }) => {
    const keys = shortcutHint(action, shortcutScheme.value);
    return keys ? [{ keys, label }] : [];
  }),
})));

function dismiss() {
  emit('dismiss');
}

// Escape ends a running spotlight first (handled by the spotlight controller)
// and only closes the modal when none is running.
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || props.activeSpotlight != null) return;
  event.preventDefault();
  dismiss();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    class="welcome"
    :class="{
      'welcome--spotlighting': activeSpotlight != null,
      'welcome--reduced-motion': reducedMotion,
    }"
    role="presentation"
  >
    <section
      ref="panelEl"
      class="welcome__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      aria-describedby="welcome-summary"
      tabindex="-1"
    >
      <button
        class="welcome__close"
        type="button"
        aria-label="Close welcome"
        @click="dismiss"
      >
        <X :size="18" :stroke-width="2" aria-hidden="true" />
      </button>

      <header class="welcome__hero">
        <div class="welcome__hero-main">
          <div class="welcome__hero-lockup">
            <div class="welcome__logo-wrap">
              <ThundermailLogo :size="90" class="welcome__logo" />
            </div>
            <div class="welcome__hero-text">
              <h1 id="welcome-title">Welcome to Thundermail</h1>
              <p id="welcome-summary" class="welcome__summary">
                Compose with confidence, keep your contacts close and organize mail the Thunderbird way.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div class="welcome__body">
        <section class="welcome__section-block" aria-labelledby="welcome-features">
          <h2 id="welcome-features">Features</h2>
          <FeatureCardGrid
            :cards="FEATURE_CARDS"
            :active-spotlight="activeSpotlight"
            :progress="progress"
            :reduced-motion="reducedMotion"
            @spotlight="emit('spotlight', $event)"
            @cancel="emit('cancelSpotlight')"
          />
        </section>

        <section
          v-if="!singleColumn"
          class="welcome__section-block"
          aria-labelledby="welcome-shortcuts"
        >
          <div class="welcome__section-heading welcome__section-heading--shortcuts">
            <Keyboard :size="18" :stroke-width="2" aria-hidden="true" />
            <h2 id="welcome-shortcuts">Keyboard Shortcuts</h2>
            <div class="welcome__scheme">
              <span id="welcome-scheme-label" class="welcome__scheme-label">Style</span>
              <ShortcutSchemePicker labelled-by="welcome-scheme-label" />
            </div>
          </div>
          <p class="welcome__scheme-hint">{{ schemeHint }}</p>

          <div class="welcome__shortcut-groups">
            <section
              v-for="group in shortcutGroups"
              :key="group.title"
              class="welcome__shortcut-group"
            >
              <h3>{{ group.title }}</h3>
              <dl>
                <template v-for="shortcut in group.shortcuts" :key="shortcut.label">
                  <dt><kbd>{{ shortcut.keys }}</kbd></dt>
                  <dd>{{ shortcut.label }}</dd>
                </template>
              </dl>
            </section>
          </div>
        </section>
      </div>

      <footer class="welcome__footer">
        <AppButton size="default" class="welcome__primary" @click="dismiss">
          Get Started
        </AppButton>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.welcome {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 16px;
  background:
    radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 34rem),
    var(--modal-scrim);
  color: var(--text);
  font-family: var(--font-sans);
  backdrop-filter: var(--modal-scrim-blur);
  transition: background 0.38s ease, backdrop-filter 0.38s ease;
}

/* A spotlight hides the panel and lets the live UI (composer, folder tree,
   Contacts) show through; only the FeatureCardGrid caption stays visible
   and clickable. Dimming comes from SpotlightOverlay's scrim, which sits
   below this layer, so the root goes fully transparent. */
.welcome--spotlighting {
  /* Above dialogs the tour opens (folder manager at 120) so the caption stays on top. */
  z-index: 130;
  background: transparent;
  backdrop-filter: none;
  pointer-events: none;
}
.welcome--spotlighting .welcome__panel {
  visibility: hidden;
  overflow: visible;
}

.welcome__panel {
  position: relative;
  width: min(1040px, 100%);
  max-height: min(94vh, 860px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--modal-border);
  border-radius: 24px;
  background: var(--modal-surface);
  box-shadow: var(--modal-shadow);
}

.welcome__close {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.welcome__close:hover,
.welcome__close:focus-visible {
  border-color: var(--border);
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}

.welcome__hero {
  padding: 32px 52px 14px;
}

.welcome__hero-main {
  max-width: 760px;
  margin: 0 auto;
}

/* Logo and text are centred together as one unit; the lockup shrinks to its
   content so the unit, not the available width, is what gets centred. */
.welcome__hero-lockup {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 22px;
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
}

.welcome__hero-text {
  min-width: 0;
  text-align: center;
}

.welcome__hero-text h1 {
  text-wrap: balance;
}

.welcome__logo-wrap {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}

.welcome__logo {
  filter: drop-shadow(0 8px 12px color-mix(in srgb, #000 22%, transparent));
}

.welcome__hero h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(36px, 4.6vw, 54px);
  font-weight: 300;
  line-height: 1;
  letter-spacing: 0;
}

.welcome__summary {
  max-width: 660px;
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.4;
  letter-spacing: 0;
}

.welcome__body {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  min-height: 0;
  padding: 0 22px 16px;
  overflow: auto;
}

.welcome__section-block {
  min-width: 0;
}

.welcome__section-block > h2 {
  margin: 0 0 8px;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0;
}

.welcome__section-heading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 8px;
}

.welcome__section-heading > svg {
  color: var(--accent);
}

.welcome__section-heading h2 {
  margin: 0;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0;
}

/* Heading and style picker share one centered row; the picker sits a step
   to the right of the title and wraps beneath it when the row is too narrow. */
.welcome__section-heading--shortcuts {
  flex-wrap: wrap;
}

.welcome__scheme {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 12px;
}

.welcome__scheme-label {
  font-size: 12px;
  font-weight: 600;
}

.welcome__scheme-hint {
  margin: 0 0 10px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.3;
}

.welcome__shortcut-groups {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 12px;
}

.welcome__shortcut-group {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--card-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--panel2) 70%, transparent);
}

.welcome__shortcut-group h3 {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
}

.welcome__shortcut-group dl {
  display: grid;
  grid-template-columns: minmax(104px, auto) minmax(0, 1fr);
  gap: 5px 8px;
  margin: 6px 0 0;
  align-items: center;
}

.welcome__shortcut-group dt,
.welcome__shortcut-group dd {
  min-width: 0;
  margin: 0;
}

.welcome__shortcut-group dd {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.25;
  letter-spacing: 0;
}

kbd {
  display: inline-flex;
  max-width: 100%;
  min-height: 22px;
  align-items: center;
  justify-content: center;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, #fff);
  border-bottom-color: color-mix(in srgb, var(--border) 72%, #000);
  border-radius: 7px;
  background: color-mix(in srgb, var(--panel) 88%, #fff);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0;
  box-shadow: 0 1px 0 color-mix(in srgb, #000 24%, transparent);
  white-space: nowrap;
}

.welcome__footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 16px 22px 18px;
  background: color-mix(in srgb, var(--panel) 86%, transparent);
}

/* Get Started is an AppButton (services-ui default size); we only keep the
   wide padding and CTA drop shadow here. Doubled up with .base to outrank
   services-ui's own .base[data-v] padding rule regardless of CSS order. */
.base.welcome__primary {
  padding: 0 32px;
  box-shadow: 0 12px 26px color-mix(in srgb, var(--accent) 28%, transparent);
}

@media (max-width: 820px) {
  .welcome {
    padding: 12px;
  }

  .welcome__panel {
    max-height: 94vh;
    border-radius: 20px;
  }

  .welcome__hero {
    padding: 24px 22px 18px;
  }

  .welcome__logo-wrap {
    width: 72px;
    height: 72px;
    border-radius: 20px;
  }

  .welcome__logo {
    width: 64px;
    height: 64px;
  }

  .welcome__body {
    padding: 0 16px 18px;
  }

  .welcome__shortcut-groups {
    grid-template-columns: 1fr;
  }

  .welcome__footer {
    align-items: stretch;
    flex-direction: column;
    padding: 14px 16px 16px;
  }
}

@media (min-width: 821px) and (max-height: 760px) {
  .welcome {
    padding: 10px;
  }

  .welcome__panel {
    max-height: calc(100vh - 20px);
  }

  .welcome__hero {
    padding-top: 14px;
    padding-bottom: 10px;
  }

  .welcome__summary {
    font-size: 14px;
  }

  .welcome__body {
    gap: 10px;
    padding-bottom: 12px;
  }

  .welcome__shortcut-group {
    padding: 10px;
  }

  .welcome__footer {
    padding-top: 10px;
    padding-bottom: 10px;
  }
}

@media (max-width: 560px) {
  .welcome__shortcut-group dl {
    grid-template-columns: 1fr;
    gap: 4px;
  }

  .welcome__shortcut-group dd {
    margin-bottom: 4px;
  }
}

@media (max-width: 460px) {
  .welcome__hero-lockup {
    flex-direction: column;
    gap: 10px;
    text-align: center;
  }
}

.welcome--reduced-motion {
  backdrop-filter: none;
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .welcome {
    backdrop-filter: none;
    transition: none;
  }
}
</style>
