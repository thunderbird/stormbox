<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { FEATURE_CARDS, type FeatureCard, type SpotlightId } from '../constants/feature-tour';
import type { SpotlightProgress } from '../composables/useFeatureSpotlight';

/**
 * Feature cards with a "Show me" button each, shared by the Welcome and
 * What's New modals. While a spotlight runs the grid's parent hides its
 * panel; this component keeps only a fixed caption visible that narrates the
 * current step (falling back to the card description) and lets the user end it.
 */
const props = withDefaults(defineProps<{
  cards?: readonly FeatureCard[];
  activeSpotlight: SpotlightId | null;
  progress?: SpotlightProgress | null;
  reducedMotion?: boolean;
}>(), {
  cards: () => FEATURE_CARDS,
  progress: null,
  reducedMotion: false,
});

const emit = defineEmits<{
  spotlight: [id: SpotlightId];
  cancel: [];
}>();

const showButtons = ref<Record<string, HTMLButtonElement>>({});
const doneButtonEl = ref<HTMLButtonElement | null>(null);

const activeCard = computed(() =>
  props.cards.find((card) => card.spotlight === props.activeSpotlight) ?? null);
const captionText = computed(() =>
  props.progress?.caption || activeCard.value?.description || '');
const stepIndex = computed(() => props.progress?.index ?? 0);
const stepCount = computed(() => props.progress?.count ?? 0);

function setShowButton(id: SpotlightId, el: unknown) {
  if (el instanceof HTMLButtonElement) {
    showButtons.value[id] = el;
  } else {
    delete showButtons.value[id];
  }
}

// Focus follows the spotlight: onto Done while it runs, back to the Show me
// button that started it when it ends, so keyboard users never lose their place.
watch(() => props.activeSpotlight, async (next, previous) => {
  await nextTick();
  if (next) {
    doneButtonEl.value?.focus();
  } else if (previous) {
    showButtons.value[previous]?.focus();
  }
});
</script>

<template>
  <div
    class="feature-tour"
    :class="{
      'feature-tour--spotlighting': activeSpotlight != null,
      'feature-tour--reduced-motion': reducedMotion,
    }"
  >
    <div class="feature-tour__grid">
      <article
        v-for="card in cards"
        :key="card.spotlight"
        class="feature-card"
        :class="{ 'feature-card--active': card.spotlight === activeSpotlight }"
        :data-spotlight="card.spotlight"
      >
        <component :is="card.icon" :size="18" :stroke-width="2" aria-hidden="true" />
        <div class="feature-card__text">
          <h3>{{ card.title }}</h3>
          <p>{{ card.description }}</p>
        </div>
        <button
          :ref="(el) => setShowButton(card.spotlight, el)"
          type="button"
          class="feature-card__show"
          :aria-label="`Show me: ${card.title}`"
          :disabled="activeSpotlight != null"
          @click="emit('spotlight', card.spotlight)"
        >
          Show me
        </button>
      </article>
    </div>

    <div
      v-if="activeCard"
      class="feature-caption"
      role="group"
      :aria-label="`Showing: ${activeCard.title}`"
      data-testid="feature-caption"
    >
      <component :is="activeCard.icon" :size="20" :stroke-width="2" aria-hidden="true" />
      <div class="feature-caption__text">
        <div class="feature-caption__heading">
          <h3>{{ activeCard.title }}</h3>
          <ol
            v-if="stepCount > 1"
            class="feature-caption__steps"
            :aria-label="`Step ${stepIndex + 1} of ${stepCount}`"
          >
            <li
              v-for="index in stepCount"
              :key="index"
              :class="{ 'is-current': index - 1 === stepIndex, 'is-done': index - 1 < stepIndex }"
            />
          </ol>
        </div>
        <Transition :name="reducedMotion ? undefined : 'feature-caption-swap'" mode="out-in">
          <p :key="stepIndex" class="feature-caption__body" aria-live="polite">{{ captionText }}</p>
        </Transition>
      </div>
      <button
        ref="doneButtonEl"
        type="button"
        class="feature-caption__done"
        @click="emit('cancel')"
      >
        Done
      </button>
    </div>
  </div>
</template>

<style scoped>
.feature-tour__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.feature-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  gap: 6px 8px;
  min-width: 0;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 72%, transparent);
  transition: border-color 0.36s ease, background 0.36s ease, box-shadow 0.36s ease;
}
.feature-card > svg {
  color: var(--accent);
}
.feature-card__text {
  min-width: 0;
}
.feature-card h3,
.feature-caption h3 {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
}
.feature-card p,
.feature-caption p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.3;
  letter-spacing: 0;
}
.feature-card__show {
  grid-column: 1 / -1;
  justify-self: center;
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 48%, var(--border));
  border-radius: 999px;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  cursor: pointer;
}
.feature-card__show:hover,
.feature-card__show:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: var(--accent);
  outline: none;
}
.feature-card__show:disabled {
  cursor: default;
  opacity: 0.5;
}
.feature-card--active {
  border-color: color-mix(in srgb, var(--accent) 78%, #fff);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent);
}

/* Fixed caption: the only part of the modal left visible and interactive
   while the panel is hidden for a spotlight. Sits along the top edge; the
   shell pushes the composer down so the two do not overlap (App.vue). */
.feature-caption {
  position: fixed;
  top: 10px;
  left: 50%;
  z-index: 2;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  width: min(640px, calc(100vw - 24px));
  padding: 12px 12px 12px 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 70%, #fff);
  border-radius: 14px;
  background: var(--panel);
  color: var(--text);
  box-shadow:
    0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent),
    0 18px 48px color-mix(in srgb, #000 36%, transparent);
  transform: translateX(-50%);
  visibility: visible;
  pointer-events: auto;
  animation: feature-caption-in 0.32s ease both;
}
.feature-tour--reduced-motion .feature-caption {
  animation: none;
}
.feature-caption > svg {
  color: var(--accent);
}
.feature-caption__text {
  min-width: 0;
}
.feature-caption__heading {
  display: flex;
  align-items: center;
  gap: 10px;
}
.feature-caption__heading h3 {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.feature-caption__steps {
  display: flex;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.feature-caption__steps li {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--muted) 45%, transparent);
  transition: background 0.3s ease, transform 0.3s ease;
}
.feature-caption__steps li.is-done {
  background: color-mix(in srgb, var(--accent) 60%, transparent);
}
.feature-caption__steps li.is-current {
  background: var(--accent);
  transform: scale(1.25);
}
.feature-caption .feature-caption__body {
  margin-top: 3px;
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.4;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}
.feature-caption-swap-enter-active,
.feature-caption-swap-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.feature-caption-swap-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.feature-caption-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.feature-caption__done {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--panel) 88%, #fff);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.feature-caption__done:hover,
.feature-caption__done:focus-visible {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  outline: none;
}

@keyframes feature-caption-in {
  from {
    opacity: 0;
    transform: translate(-50%, -8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@media (max-width: 820px) {
  .feature-tour__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .feature-tour__grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .feature-card {
    transition: none;
  }
  .feature-caption {
    animation: none;
  }
  .feature-caption__steps li,
  .feature-caption-swap-enter-active,
  .feature-caption-swap-leave-active {
    transition: none;
  }
}
</style>
