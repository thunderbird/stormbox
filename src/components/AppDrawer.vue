<script setup lang="ts">
import { ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { Grip } from '@lucide/vue';

import { MAIL_APP_ICON, OTHER_PRO_APPS } from '../constants/apps';

const detailsEl = ref<HTMLDetailsElement | null>(null);

onClickOutside(detailsEl, close);

function close() {
  if (detailsEl.value?.open) detailsEl.value.open = false;
}
</script>

<template>
  <details ref="detailsEl" class="app-drawer" @keydown.escape="close">
    <summary class="quick-filter__action app-drawer__button" aria-label="Open app drawer" title="Apps">
      <Grip :size="18" :stroke-width="1.75" aria-hidden="true" />
    </summary>
    <div class="app-drawer__popover" role="menu" aria-label="Thunderbird Pro apps">
      <button
        class="app-drawer__tile app-drawer__tile--current"
        type="button"
        role="menuitem"
        aria-current="page"
        @click="close"
      >
        <img :src="MAIL_APP_ICON" class="app-drawer__icon" alt="" aria-hidden="true" />
        <span>Mail</span>
      </button>
      <a
        v-for="app in OTHER_PRO_APPS"
        :key="app.id"
        class="app-drawer__tile"
        :href="app.href"
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        @click="close"
      >
        <img :src="app.icon" class="app-drawer__icon" alt="" aria-hidden="true" />
        <span>{{ app.name }}</span>
      </a>
    </div>
  </details>
</template>

<style scoped>
.app-drawer {
  position: relative;
}
.app-drawer__button {
  list-style: none;
  user-select: none;
}
.app-drawer__button::-webkit-details-marker {
  display: none;
}
.app-drawer[open] .app-drawer__button {
  background: var(--rowHover);
  border-color: var(--border-soft);
}

.app-drawer__popover {
  position: absolute;
  z-index: 30;
  top: calc(100% + 8px);
  right: 0;
  display: grid;
  grid-template-columns: repeat(3, 84px);
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--top-nav-popover-bg, var(--panel));
  box-shadow: 0 16px 32px color-mix(in srgb, #000 32%, transparent);
}

.app-drawer__tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 6px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
.app-drawer__tile:hover,
.app-drawer__tile:focus-visible {
  background: var(--rowHover);
  outline: none;
}
.app-drawer__tile--current {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.app-drawer__tile--current:hover,
.app-drawer__tile--current:focus-visible {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

.app-drawer__icon {
  display: block;
  width: 40px;
  height: 40px;
  border-radius: 9px;
  filter: drop-shadow(0 2px 3px color-mix(in srgb, #000 20%, transparent));
}
</style>
