<script setup lang="ts">
import {
  Archive,
  CheckCircle2,
  Keyboard,
  MailPlus,
  PanelLeft,
  Search,
  ShieldCheck,
  X,
} from '@lucide/vue';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  type ComponentPublicInstance,
  type Ref,
} from 'vue';

import { isMacPlatform } from '../utils/keyboard.js';
import ThundermailLogo from './ThundermailLogo.vue';

const emit = defineEmits<{
  dismiss: [];
  spotlightQuickFilter: [];
  spotlightResizeLayout: [];
  spotlightComposeActions: [];
}>();

type SpotlightId = 'quickFilter' | 'resizeLayout' | 'composeActions';

const closeButtonEl = ref<HTMLButtonElement | null>(null);
const featureElements: Record<SpotlightId, Ref<HTMLElement | null>> = {
  quickFilter: ref(null),
  resizeLayout: ref(null),
  composeActions: ref(null),
};
const isSpotlighting = ref(false);
const isResettingSpotlight = ref(false);
const activeSpotlight = ref<SpotlightId | null>(null);
const spotlightBaseRect = ref<DOMRect | null>(null);
const spotlightTransform = ref('translateY(-220px)');
const composeToolbarTransform = ref('translate(0, -180px)');
const modifierKey = computed(() => (isMacPlatform() ? 'Cmd' : 'Ctrl'));
const deleteKey = computed(() => (isMacPlatform() ? 'Backspace' : 'Delete'));
const SPOTLIGHT_DURATION_MS = 2600;
const LONG_SPOTLIGHT_DURATION_MS = 4200;
const QUICK_FILTER_CARD_OFFSET = 14;
const RESIZE_CARD_OFFSET = 92;
let spotlightTimer: number | null = null;
let spotlightResetFrame: number | null = null;

const features = [
  {
    icon: Search,
    title: 'Quick Filter',
    description: 'Search the current message list by sender, recipient, or subject without leaving your inbox.',
    spotlight: 'quickFilter',
  },
  {
    icon: PanelLeft,
    title: 'Resizable mail layout',
    description: 'Tune the folder list, message list, and reading pane widths to fit your workflow.',
    spotlight: 'resizeLayout',
  },
  {
    icon: MailPlus,
    title: 'Compose, reply, and forward',
    description: 'Start a new message or respond from the reading pane with Thunderbird-style shortcuts.',
    spotlight: 'composeActions',
  },
  {
    icon: ShieldCheck,
    title: 'Local mail cache',
    description: 'Messages and folders are backed by a browser-local cache for quick, responsive navigation.',
    spotlight: undefined,
  },
  {
    icon: CheckCircle2,
    title: 'Bulk selection',
    description: 'Select loaded conversations, clear selections, and apply actions to many messages at once.',
    spotlight: undefined,
  },
  {
    icon: Archive,
    title: 'Fast message actions',
    description: 'Archive, delete, permanently delete, and mark messages read or unread from the keyboard.',
    spotlight: undefined,
  },
] as const;

const shortcutGroups = computed(() => [
  {
    title: 'Navigate',
    shortcuts: [
      { keys: 'F', action: 'Next message' },
      { keys: 'B', action: 'Previous message' },
      { keys: 'N', action: 'Next unread message' },
      { keys: 'P', action: 'Previous unread message' },
      { keys: 'Home', action: 'First loaded message' },
      { keys: 'End', action: 'Last loaded message' },
    ],
  },
  {
    title: 'Message actions',
    shortcuts: [
      { keys: 'A', action: 'Archive selected messages' },
      { keys: 'M', action: 'Mark selected messages read or unread' },
      { keys: deleteKey.value, action: 'Delete selected messages' },
      { keys: `Shift+${deleteKey.value}`, action: 'Permanently delete selected messages' },
      { keys: `${modifierKey.value}+A`, action: 'Select all loaded messages' },
      { keys: 'Esc', action: 'Clear the current selection' },
    ],
  },
  {
    title: 'Find and compose',
    shortcuts: [
      { keys: `${modifierKey.value}+K`, action: 'Focus Quick Filter' },
      { keys: `${modifierKey.value}+N or ${modifierKey.value}+M`, action: 'New message' },
      { keys: `${modifierKey.value}+R`, action: 'Reply' },
      { keys: `Shift+${modifierKey.value}+R`, action: 'Reply all' },
      { keys: `${modifierKey.value}+L`, action: 'Forward' },
    ],
  },
]);

const featureSpotlightStyle = computed(() => ({
  '--spotlight-transform': spotlightTransform.value,
  '--compose-toolbar-transform': composeToolbarTransform.value,
}));

function setFeatureRef(
  spotlight: SpotlightId | undefined,
  el: Element | ComponentPublicInstance | null,
) {
  if (spotlight) featureElements[spotlight].value = el instanceof HTMLElement ? el : null;
}

function dismiss() {
  if (spotlightTimer != null) {
    window.clearTimeout(spotlightTimer);
    spotlightTimer = null;
  }
  if (spotlightResetFrame != null) {
    window.cancelAnimationFrame(spotlightResetFrame);
    spotlightResetFrame = null;
  }
  spotlightBaseRect.value = null;
  isResettingSpotlight.value = false;
  emit('dismiss');
}

function startFeatureSpotlight(spotlight: SpotlightId | undefined) {
  if (!spotlight) return;
  startSpotlight(spotlight, spotlightActions[spotlight]);
}

type SpotlightAction = {
  computeTransform: () => void;
  notify: () => void;
  initialTransform?: () => void;
};

const spotlightActions: Record<SpotlightId, SpotlightAction> = {
  quickFilter: {
    computeTransform: computeQuickFilterSpotlightTransform,
    notify: () => emit('spotlightQuickFilter'),
  },
  resizeLayout: {
    computeTransform: computeResizeSpotlightTransform,
    initialTransform: computeDefaultSpotlightTransform,
    notify: () => emit('spotlightResizeLayout'),
  },
  composeActions: {
    computeTransform: computeComposeSpotlightTransform,
    notify: () => emit('spotlightComposeActions'),
  },
};

async function startSpotlight(spotlight: SpotlightId, action: SpotlightAction) {
  if (isSpotlighting.value) return;

  spotlightBaseRect.value = spotlightFeatureElement(spotlight)?.getBoundingClientRect() ?? null;
  (action.initialTransform ?? action.computeTransform)();
  activeSpotlight.value = spotlight;
  isSpotlighting.value = true;
  action.notify();
  await nextTick();
  await nextTick();
  action.computeTransform();

  spotlightTimer = window.setTimeout(() => {
    spotlightTimer = null;
    isResettingSpotlight.value = true;
    isSpotlighting.value = false;
    activeSpotlight.value = null;
    spotlightBaseRect.value = null;
    spotlightResetFrame = window.requestAnimationFrame(() => {
      spotlightResetFrame = window.requestAnimationFrame(() => {
        spotlightResetFrame = null;
        isResettingSpotlight.value = false;
      });
    });
  }, spotlightDuration(spotlight));
}

function spotlightFeatureElement(spotlight: SpotlightId) {
  return featureElements[spotlight].value;
}

function spotlightDuration(spotlight: SpotlightId) {
  if (spotlight === 'quickFilter') return SPOTLIGHT_DURATION_MS;
  if (spotlight === 'composeActions') return 3200;
  return LONG_SPOTLIGHT_DURATION_MS;
}

function computeDefaultSpotlightTransform() {
  spotlightTransform.value = 'translateY(-18px)';
}

function computeResizeSpotlightTransform() {
  setSpotlightTransformToAnchor(
    featureElements.resizeLayout.value,
    quickFilterAnchor(RESIZE_CARD_OFFSET),
    'translateY(-160px)',
  );
}

function computeComposeSpotlightTransform() {
  const card = featureElements.composeActions.value;
  if (!card) return;

  const toolbarTarget = composeToolbarTargetRect();
  if (toolbarTarget) {
    composeToolbarTransform.value = transformCardToPoint(card, {
      x: toolbarTarget.left + toolbarTarget.width / 2,
      y: toolbarTarget.bottom + 12,
    });
  }
}

function computeQuickFilterSpotlightTransform() {
  setSpotlightTransformToAnchor(
    featureElements.quickFilter.value,
    quickFilterAnchor(QUICK_FILTER_CARD_OFFSET),
    'translateY(-220px)',
  );
}

function quickFilterAnchor(offsetY: number) {
  const target = document.querySelector<HTMLElement>('.quick-filter__search');
  if (!target) return null;
  const targetRect = target.getBoundingClientRect();
  return {
    x: targetRect.left + targetRect.width / 2,
    y: targetRect.bottom + offsetY,
  };
}

function setSpotlightTransformToAnchor(
  card: HTMLElement | null,
  anchor: { x: number; y: number } | null,
  fallback: string,
) {
  spotlightTransform.value = card && anchor
    ? transformCardToPoint(card, anchor)
    : fallback;
}

function transformCardToPoint(card: HTMLElement, target: { x: number; y: number }) {
  const cardRect = spotlightBaseRect.value ?? card.getBoundingClientRect();
  const margin = 18;
  const halfWidth = cardRect.width / 2;
  const maxX = Math.max(margin + halfWidth, window.innerWidth - margin - halfWidth);
  const maxY = Math.max(margin, window.innerHeight - margin - cardRect.height);
  const targetX = clamp(target.x, margin + halfWidth, maxX);
  const targetY = clamp(target.y, margin, maxY);
  const cardX = cardRect.left + cardRect.width / 2;
  const cardY = cardRect.top;
  return `translate(${Math.round(targetX - cardX)}px, ${Math.round(targetY - cardY)}px)`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function composeToolbarTargetRect() {
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>('.message-view__action--compose-spotlight'),
  );
  if (!buttons.length) return null;

  return buttons.reduce((rect, button) => {
    const next = button.getBoundingClientRect();
    return {
      left: Math.min(rect.left, next.left),
      top: Math.min(rect.top, next.top),
      right: Math.max(rect.right, next.right),
      bottom: Math.max(rect.bottom, next.bottom),
      width: Math.max(rect.right, next.right) - Math.min(rect.left, next.left),
      height: Math.max(rect.bottom, next.bottom) - Math.min(rect.top, next.top),
    };
  }, buttons[0].getBoundingClientRect());
}

onMounted(() => {
  closeButtonEl.value?.focus();
});

onBeforeUnmount(() => {
  if (spotlightTimer != null) {
    window.clearTimeout(spotlightTimer);
    spotlightTimer = null;
  }
  if (spotlightResetFrame != null) {
    window.cancelAnimationFrame(spotlightResetFrame);
    spotlightResetFrame = null;
  }
  spotlightBaseRect.value = null;
});
</script>

<template>
  <div
    class="welcome"
    :class="{
      'welcome--spotlighting': isSpotlighting,
      'welcome--spotlight-resetting': isResettingSpotlight,
      'welcome--spotlight-resize-layout': activeSpotlight === 'resizeLayout',
      'welcome--spotlight-compose-actions': activeSpotlight === 'composeActions',
    }"
    role="presentation"
  >
    <section
      class="welcome__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      aria-describedby="welcome-summary"
    >
      <button
        ref="closeButtonEl"
        class="welcome__close"
        type="button"
        aria-label="Close welcome"
        @click="dismiss"
      >
        <X :size="18" :stroke-width="2" aria-hidden="true" />
      </button>

      <header class="welcome__hero">
        <div class="welcome__hero-main">
          <div class="welcome__hero-copy">
            <div class="welcome__hero-lockup">
              <div class="welcome__logo-wrap">
                <ThundermailLogo :size="90" class="welcome__logo" />
              </div>
              <div class="welcome__hero-text">
                <h1 id="welcome-title">Welcome to Thundermail</h1>
                <p id="welcome-summary" class="welcome__summary">
                  A fast, keyboard-friendly mail experience with the Thunderbird actions you expect
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div class="welcome__body">
        <section class="welcome__section-block" aria-labelledby="welcome-features">
          <h2 id="welcome-features">Features</h2>
          <div class="welcome__features">
            <article
              v-for="feature in features"
              :key="feature.title"
              class="welcome__feature"
              :class="{
                'welcome__feature--quick-filter': feature.title === 'Quick Filter',
                'welcome__feature--spotlightable': Boolean(feature.spotlight),
                'welcome__feature--active': feature.spotlight === activeSpotlight,
              }"
              :ref="(el) => setFeatureRef(feature.spotlight, el)"
              :role="feature.spotlight ? 'button' : undefined"
              :tabindex="feature.spotlight ? 0 : undefined"
              :style="feature.spotlight ? featureSpotlightStyle : undefined"
              @click="startFeatureSpotlight(feature.spotlight)"
              @keydown.enter.prevent="startFeatureSpotlight(feature.spotlight)"
              @keydown.space.prevent="startFeatureSpotlight(feature.spotlight)"
            >
              <component :is="feature.icon" :size="18" :stroke-width="2" aria-hidden="true" />
              <div>
                <h3>{{ feature.title }}</h3>
                <p>{{ feature.description }}</p>
              </div>
            </article>
          </div>
        </section>

        <section class="welcome__section-block" aria-labelledby="welcome-shortcuts">
          <div class="welcome__section-heading">
            <Keyboard :size="18" :stroke-width="2" aria-hidden="true" />
            <h2 id="welcome-shortcuts">Keyboard Shortcuts</h2>
          </div>

          <div class="welcome__shortcut-groups">
            <section
              v-for="group in shortcutGroups"
              :key="group.title"
              class="welcome__shortcut-group"
            >
              <h3>{{ group.title }}</h3>
              <dl>
                <template
                  v-for="shortcut in group.shortcuts"
                  :key="shortcut.keys"
                >
                  <dt><kbd>{{ shortcut.keys }}</kbd></dt>
                  <dd>{{ shortcut.action }}</dd>
                </template>
              </dl>
            </section>
          </div>
        </section>
      </div>

      <footer class="welcome__footer">
        <button class="welcome__primary" type="button" @click="dismiss">
          Get Started
        </button>
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
    color-mix(in srgb, #000 64%, transparent);
  color: var(--text);
  font-family: var(--font-sans);
  backdrop-filter: blur(12px);
  transition: background 0.38s ease, backdrop-filter 0.38s ease;
}

.welcome--spotlighting {
  background: color-mix(in srgb, #000 22%, transparent);
  backdrop-filter: blur(2px);
}

.welcome--spotlight-resize-layout,
.welcome--spotlight-compose-actions {
  background: color-mix(in srgb, #000 10%, transparent);
  backdrop-filter: none;
}

.welcome--spotlight-compose-actions {
  z-index: 160;
}

.welcome__panel {
  position: relative;
  width: min(1040px, 100%);
  max-height: min(94vh, 860px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 78%, #fff);
  border-radius: 24px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--panel) 95%, #fff), var(--panel) 220px),
    var(--panel);
  box-shadow:
    0 28px 80px color-mix(in srgb, #000 46%, transparent),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  transition: background 0.36s ease, border-color 0.36s ease, box-shadow 0.36s ease;
}

.welcome--spotlighting .welcome__panel {
  overflow: visible;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  pointer-events: none;
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
  transition: opacity 0.24s ease, transform 0.24s ease;
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
  transition: opacity 0.26s ease, transform 0.26s ease;
}

.welcome__hero-main {
  max-width: 760px;
  margin: 0 auto;
}

.welcome__hero-copy {
  min-width: 0;
  text-align: center;
}

.welcome__hero-lockup {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 22px;
  max-width: 820px;
  margin: 0 auto;
}

.welcome__hero-text {
  min-width: 0;
  text-align: center;
}

.welcome__logo-wrap {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  transition: opacity 0.24s ease, transform 0.24s ease;
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
  font-size: 15px;
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

.welcome--spotlighting .welcome__body {
  overflow: visible;
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
  transition: opacity 0.24s ease, transform 0.24s ease;
}

.welcome__section-heading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 8px;
  transition: opacity 0.24s ease, transform 0.24s ease;
}

.welcome__section-heading h2 {
  margin: 0;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0;
}

.welcome__features {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.welcome__feature {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 72%, transparent);
  transition:
    opacity 0.26s ease,
    transform 0.72s cubic-bezier(0.18, 0.86, 0.28, 1),
    border-color 0.36s ease,
    background 0.36s ease,
    box-shadow 0.36s ease;
}

.welcome__feature--spotlightable {
  cursor: pointer;
}

.welcome__feature--spotlightable:hover,
.welcome__feature--spotlightable:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 64%, var(--border));
  background: color-mix(in srgb, var(--panel) 88%, #fff);
  outline: none;
}

.welcome__feature > svg,
.welcome__section-heading > svg {
  color: var(--accent);
}

.welcome__feature h3,
.welcome__shortcut-group h3 {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
}

.welcome__feature p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.3;
  letter-spacing: 0;
}

.welcome__shortcut-groups {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 12px;
  transition: opacity 0.24s ease, transform 0.24s ease;
}

.welcome__shortcut-group {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--panel2) 70%, transparent);
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
  transition: opacity 0.24s ease, transform 0.24s ease;
}

.welcome--spotlighting :is(
  .welcome__hero,
  .welcome__close,
  .welcome__logo-wrap,
  .welcome__section-block > h2,
  .welcome__section-heading,
  .welcome__shortcut-groups,
  .welcome__footer
) {
  opacity: 0;
  transform: translateY(-6px);
}

.welcome--spotlighting .welcome__feature:not(.welcome__feature--active) {
  opacity: 0;
}

.welcome--spotlight-resetting :is(
  .welcome__hero,
  .welcome__close,
  .welcome__logo-wrap,
  .welcome__section-block > h2,
  .welcome__section-heading,
  .welcome__feature,
  .welcome__shortcut-groups,
  .welcome__footer
) {
  transition: none;
}

.welcome--spotlighting .welcome__feature--active {
  z-index: 2;
  border-color: color-mix(in srgb, var(--accent) 78%, #fff);
  background: color-mix(in srgb, var(--panel) 94%, #fff);
  box-shadow:
    0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent),
    0 24px 54px color-mix(in srgb, #000 34%, transparent);
  transform: var(--spotlight-transform);
}

.welcome--spotlight-compose-actions .welcome__feature--active {
  animation: compose-feature-tour 3.2s ease-in-out forwards;
}

.welcome--spotlight-resize-layout .welcome__feature--active {
  transition:
    opacity 0.26s ease,
    transform 1.15s cubic-bezier(0.18, 0.86, 0.28, 1),
    border-color 0.36s ease,
    background 0.36s ease,
    box-shadow 0.36s ease;
}

@keyframes compose-feature-tour {
  0% {
    transform: translateY(-18px);
  }
  18%, 100% {
    transform: var(--compose-toolbar-transform);
  }
}

.welcome__primary {
  appearance: none;
  min-height: 44px;
  padding: 0 32px;
  border: 1px solid color-mix(in srgb, var(--accent) 78%, #000);
  border-radius: 14px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0;
  box-shadow: 0 12px 26px color-mix(in srgb, var(--accent) 28%, transparent);
}

.welcome__primary:hover,
.welcome__primary:focus-visible {
  filter: brightness(1.05);
  outline: none;
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
    grid-template-columns: 1fr;
    padding: 0 16px 18px;
  }

  .welcome__features {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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

  .welcome__section,
  .welcome__shortcut-group {
    padding: 10px;
  }

  .welcome__feature {
    padding: 8px;
  }

  .welcome__footer {
    padding-top: 10px;
    padding-bottom: 10px;
  }
}

@media (max-width: 560px) {
  .welcome__features {
    grid-template-columns: 1fr;
  }

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

  .welcome__hero-text {
    text-align: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .welcome {
    backdrop-filter: none;
  }
}
</style>
