<script setup lang="ts">
import { Sparkles, X } from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { useModalFocus } from '../composables/useModalFocus';
import { FEATURE_CARDS, type SpotlightId } from '../constants/feature-tour';
import type { SpotlightProgress } from '../composables/useFeatureSpotlight';
import AppButton from './AppButton.vue';
import FeatureCardGrid from './FeatureCardGrid.vue';

/**
 * One-time announcement for users who dismissed Welcome before the current
 * feature round. Same cards and spotlights as Welcome, without the hero and
 * shortcut sections.
 */
const props = withDefaults(defineProps<{
  activeSpotlight?: SpotlightId | null;
  progress?: SpotlightProgress | null;
  reducedMotion?: boolean;
}>(), {
  activeSpotlight: null,
  progress: null,
  reducedMotion: false,
});

const emit = defineEmits<{
  dismiss: [];
  spotlight: [id: SpotlightId];
  cancelSpotlight: [];
}>();

const panelEl = ref<HTMLElement | null>(null);
useModalFocus(panelEl, { containTab: true, onDefault: dismiss });

function dismiss() {
  emit('dismiss');
}

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
    class="whats-new"
    :class="{
      'whats-new--spotlighting': activeSpotlight != null,
      'whats-new--reduced-motion': reducedMotion,
    }"
    role="presentation"
  >
    <section
      ref="panelEl"
      class="whats-new__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
      aria-describedby="whats-new-summary"
      tabindex="-1"
    >
      <button
        class="whats-new__close"
        type="button"
        aria-label="Close what's new"
        @click="dismiss"
      >
        <X :size="18" :stroke-width="2" aria-hidden="true" />
      </button>

      <header class="whats-new__header">
        <Sparkles :size="22" :stroke-width="2" aria-hidden="true" />
        <div>
          <h1 id="whats-new-title">What's new in Thundermail</h1>
          <p id="whats-new-summary" class="whats-new__summary">
            Compose has grown up, and Contacts and folder management are here. Pick a card to see it in action.
          </p>
        </div>
      </header>

      <div class="whats-new__body">
        <FeatureCardGrid
          :cards="FEATURE_CARDS"
          :active-spotlight="activeSpotlight"
          :progress="progress"
          :reduced-motion="reducedMotion"
          @spotlight="emit('spotlight', $event)"
          @cancel="emit('cancelSpotlight')"
        />
      </div>

      <footer class="whats-new__footer">
        <AppButton size="default" class="whats-new__primary" @click="dismiss">
          Got it
        </AppButton>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.whats-new {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--modal-scrim);
  color: var(--text);
  font-family: var(--font-sans);
  backdrop-filter: var(--modal-scrim-blur);
  transition: background 0.3s ease, backdrop-filter 0.3s ease;
}

/* See WelcomeModal: a spotlight hides the panel and leaves the caption. */
.whats-new--spotlighting {
  z-index: 130;
  background: transparent;
  backdrop-filter: none;
  pointer-events: none;
}
.whats-new--spotlighting .whats-new__panel {
  visibility: hidden;
  overflow: visible;
}

.whats-new__panel {
  position: relative;
  width: min(720px, 100%);
  max-height: min(92vh, 720px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--modal-border);
  border-radius: 20px;
  background: var(--modal-surface);
  box-shadow: var(--modal-shadow);
}

.whats-new__close {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.whats-new__close:hover,
.whats-new__close:focus-visible {
  border-color: var(--border);
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}

.whats-new__header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 22px 56px 12px 22px;
}
.whats-new__header > svg {
  flex: 0 0 auto;
  margin-top: 3px;
  color: var(--accent);
}
.whats-new__header h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 500;
  line-height: 1.15;
  letter-spacing: 0;
}
.whats-new__summary {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.4;
}

.whats-new__body {
  min-height: 0;
  padding: 0 22px 14px;
  overflow: auto;
}

.whats-new__footer {
  display: flex;
  justify-content: flex-end;
  padding: 12px 22px 16px;
  border-top: 1px solid var(--border-soft);
  background: color-mix(in srgb, var(--panel) 86%, transparent);
}
.base.whats-new__primary {
  padding: 0 28px;
}

.whats-new--reduced-motion {
  backdrop-filter: none;
  transition: none;
}

@media (max-width: 560px) {
  .whats-new {
    padding: 10px;
  }
  .whats-new__header {
    padding: 18px 50px 10px 16px;
  }
  .whats-new__body {
    padding: 0 16px 12px;
  }
  .whats-new__footer {
    justify-content: stretch;
    padding: 10px 16px 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .whats-new {
    backdrop-filter: none;
    transition: none;
  }
}
</style>
