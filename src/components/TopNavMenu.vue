<script setup lang="ts">
import { ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import {
  Bug, Lightbulb, Menu, Moon, Settings, Sun,
} from '@lucide/vue';

import { BUG_REPORT_URL, FEEDBACK_URL } from '../defines';
import { OTHER_PRO_APPS } from '../constants/apps';

// Compact-layout replacement for the top bar's action cluster and app
// drawer: below 640px those collapse into this single menu.
defineProps<{
  theme: 'dark' | 'light';
  themeToggleLabel: string;
  /** False while the theme follows the OS; the toggle item is dropped. */
  showThemeToggle: boolean;
}>();
const emit = defineEmits<{
  (event: 'toggle-theme'): void;
  (event: 'open-settings'): void;
}>();

const detailsEl = ref<HTMLDetailsElement | null>(null);

onClickOutside(detailsEl, close);

function close() {
  if (detailsEl.value?.open) detailsEl.value.open = false;
}

function onToggleTheme() {
  close();
  emit('toggle-theme');
}

function onOpenSettings() {
  close();
  emit('open-settings');
}
</script>

<template>
  <details ref="detailsEl" class="top-nav-menu" @keydown.escape="close">
    <summary class="quick-filter__action top-nav-menu__button" aria-label="Open menu" title="Menu">
      <Menu :size="18" :stroke-width="1.75" aria-hidden="true" />
    </summary>
    <div class="top-nav-menu__popover" role="menu">
      <a
        class="top-nav-menu__item"
        :href="BUG_REPORT_URL"
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        @click="close"
      >
        <Bug :size="18" :stroke-width="1.75" aria-hidden="true" />
        <span>Report a bug</span>
      </a>
      <a
        class="top-nav-menu__item"
        :href="FEEDBACK_URL"
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        @click="close"
      >
        <Lightbulb :size="18" :stroke-width="1.75" aria-hidden="true" />
        <span>Give feedback</span>
      </a>
      <button
        class="top-nav-menu__item"
        type="button"
        role="menuitem"
        data-settings-menuitem
        @click="onOpenSettings"
      >
        <Settings :size="18" :stroke-width="1.75" aria-hidden="true" />
        <span>Settings</span>
      </button>
      <button
        v-if="showThemeToggle"
        class="top-nav-menu__item"
        type="button"
        role="menuitem"
        @click="onToggleTheme"
      >
        <Sun v-if="theme === 'dark'" :size="18" :stroke-width="1.75" aria-hidden="true" />
        <Moon v-else :size="18" :stroke-width="1.75" aria-hidden="true" />
        <span>{{ themeToggleLabel }}</span>
      </button>
      <div class="top-nav-menu__divider" role="separator" />
      <a
        v-for="app in OTHER_PRO_APPS"
        :key="app.id"
        class="top-nav-menu__item"
        :href="app.href"
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        @click="close"
      >
        <img :src="app.icon" class="top-nav-menu__app-icon" alt="" aria-hidden="true" />
        <span>{{ app.name }}</span>
      </a>
    </div>
  </details>
</template>

<style scoped>
.top-nav-menu {
  position: relative;
}
.top-nav-menu__button {
  list-style: none;
  user-select: none;
}
.top-nav-menu__button::-webkit-details-marker {
  display: none;
}
.top-nav-menu[open] .top-nav-menu__button {
  background: var(--rowHover);
  border-color: var(--border-soft);
}

.top-nav-menu__popover {
  position: absolute;
  z-index: 30;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--top-nav-popover-bg, var(--panel));
  box-shadow: 0 16px 32px color-mix(in srgb, #000 32%, transparent);
}

.top-nav-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  text-decoration: none;
}
.top-nav-menu__item:hover,
.top-nav-menu__item:focus-visible {
  background: var(--rowHover);
  outline: none;
}
.top-nav-menu__item svg {
  flex-shrink: 0;
  color: var(--muted);
}
.top-nav-menu__app-icon {
  display: block;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  flex-shrink: 0;
}
.top-nav-menu__divider {
  height: 1px;
  margin: 6px 4px;
  background: var(--border-soft);
}
</style>
