<script setup lang="ts">
import { ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { Grip } from '@lucide/vue';

import { MAIL_APP_GLYPH, OTHER_PRO_APPS } from '../constants/apps';

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
        <span class="app-drawer__icon" aria-hidden="true" v-html="MAIL_APP_GLYPH" />
        <span class="app-drawer__label">Mail</span>
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
        <span class="app-drawer__icon" aria-hidden="true" v-html="app.glyph" />
        <span class="app-drawer__label">{{ app.name }}</span>
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

/* Tile states (Figma tMail_web nav-IA, app-drawer/*): the squircle is a
   44px gradient with a 1px border; a resting app has a grey glyph and
   label; hover and focus turn the glyph accent and, in light mode, tint the
   gradient's foot, focus adding a 2px ring 2px out; the current app keeps
   that with an accent border and a bold accent label. The gradient runs
   light-to-dark in both themes, so its stops are picked per scheme rather
   than from the surface ladder, which flips. */
.app-drawer__tile {
  --tile-top: light-dark(var(--colour-neutral-raised), var(--colour-neutral-deep));
  --tile-foot: light-dark(var(--colour-neutral-subtle), var(--colour-neutral-lower));
  --tile-foot-lit: light-dark(
    color-mix(in srgb, var(--accent) 14%, var(--colour-neutral-raised)),
    var(--colour-neutral-lower)
  );
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 6px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
.app-drawer__tile:focus-visible {
  outline: none;
}

.app-drawer__icon {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 44px;
  height: 44px;
  padding: 7.5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: linear-gradient(to bottom, var(--tile-top), var(--tile-foot));
  box-shadow: 0 3px 6px -2px color-mix(in srgb, #000 15%, transparent);
  color: var(--muted);
  transition: border-color 120ms ease, color 120ms ease;
}
.app-drawer__icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.app-drawer__tile:hover .app-drawer__icon,
.app-drawer__tile:focus-visible .app-drawer__icon,
.app-drawer__tile--current .app-drawer__icon {
  background: linear-gradient(to bottom, var(--tile-top), var(--tile-foot-lit));
  color: var(--accent);
}
.app-drawer__tile:focus-visible .app-drawer__icon {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.app-drawer__tile--current .app-drawer__icon {
  border-color: var(--accent);
}
.app-drawer__tile--current {
  color: var(--accent);
  font-weight: 700;
}
</style>
