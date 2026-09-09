<script setup lang="ts">
import { computed, ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { Sparkles } from '@lucide/vue';

import type { BeaconId } from '../constants/feature-beacons';
import { useFeatureBeaconsStore } from '../stores/feature-beacons-store';

/**
 * Header pill counting the unseen feature beacons. It discloses a labelled
 * list of them so a user can jump to one whose control is not on screen
 * (the composer's or the Contacts space's) and can dismiss the whole round
 * at once. The list is a plain disclosure, not an ARIA menu: it carries an
 * intro and a footer action, and Tab is its only keyboard navigation.
 */
const store = useFeatureBeaconsStore();
const emit = defineEmits<{
  (event: 'reveal', id: BeaconId): void;
}>();

const detailsEl = ref<HTMLDetailsElement | null>(null);
const pillEl = ref<HTMLElement | null>(null);

const visible = computed(() => store.enabled && store.count > 0);
const label = computed(() => `${store.count} new`);
const ariaLabel = computed(() =>
  `${store.count} new ${store.count === 1 ? 'feature' : 'features'}, open the list`);

onClickOutside(detailsEl, () => {
  if (detailsEl.value?.open) detailsEl.value.open = false;
});

function closeMenu(): void {
  if (detailsEl.value) detailsEl.value.open = false;
}

// The pill takes focus before the card opens so the card can hand focus
// back to it, rather than to an item inside the closed list.
function onReveal(id: BeaconId): void {
  closeMenu();
  pillEl.value?.focus({ preventScroll: true });
  emit('reveal', id);
}

function onDismissAll(): void {
  closeMenu();
  store.dismissAll();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !detailsEl.value?.open) return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  pillEl.value?.focus({ preventScroll: true });
}
</script>

<template>
  <details
    v-if="visible"
    ref="detailsEl"
    class="beacon-menu"
    data-testid="feature-beacon-menu"
    @keydown="onKeydown"
  >
    <summary ref="pillEl" class="beacon-menu__pill" :aria-label="ariaLabel" :title="ariaLabel">
      <Sparkles :size="14" :stroke-width="2" aria-hidden="true" />
      <span class="beacon-menu__count">{{ label }}</span>
    </summary>
    <div class="beacon-menu__popover" role="group" aria-label="New features">
      <p class="beacon-menu__intro">
        New since your last visit. Pick one to see where it lives.
      </p>
      <ul class="beacon-menu__list">
        <li v-for="beacon in store.unseen" :key="beacon.id">
          <button
            class="beacon-menu__item"
            type="button"
            :data-beacon-item="beacon.id"
            @click="onReveal(beacon.id)"
          >
            <span class="beacon-menu__icon" aria-hidden="true">
              <component :is="beacon.icon" :size="16" :stroke-width="1.75" />
            </span>
            <span class="beacon-menu__text">
              <span class="beacon-menu__title">{{ beacon.title }}</span>
              <span class="beacon-menu__body">{{ beacon.body }}</span>
            </span>
          </button>
        </li>
      </ul>
      <div class="beacon-menu__footer">
        <button class="beacon-menu__dismiss" type="button" @click="onDismissAll">
          Dismiss all
        </button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.beacon-menu {
  position: relative;
}
.beacon-menu__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1;
  list-style: none;
  user-select: none;
  white-space: nowrap;
}
.beacon-menu__pill::-webkit-details-marker {
  display: none;
}
.beacon-menu__pill:hover,
.beacon-menu[open] .beacon-menu__pill {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.beacon-menu__pill:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.beacon-menu__popover {
  position: absolute;
  z-index: 30;
  top: calc(100% + 8px);
  right: 0;
  width: min(340px, calc(100vw - 24px));
  padding: 6px;
  border: 1px solid var(--modal-border);
  border-radius: 12px;
  background: var(--modal-surface);
  box-shadow: var(--modal-shadow);
}
.beacon-menu__intro {
  margin: 0;
  padding: 8px 10px 10px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--muted);
}

.beacon-menu__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.beacon-menu__item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.beacon-menu__item:hover,
.beacon-menu__item:focus-visible {
  background: var(--rowHover);
  outline: none;
}
.beacon-menu__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
.beacon-menu__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.beacon-menu__title {
  font-size: 13px;
  font-weight: 600;
}
.beacon-menu__body {
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
}

.beacon-menu__footer {
  display: flex;
  justify-content: flex-end;
  padding: 8px 6px 4px;
  border-top: 1px solid var(--border-soft);
  margin-top: 4px;
}
.beacon-menu__dismiss {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--control-border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
}
.beacon-menu__dismiss:hover,
.beacon-menu__dismiss:focus-visible {
  background: var(--rowHover);
  outline: none;
}
</style>
