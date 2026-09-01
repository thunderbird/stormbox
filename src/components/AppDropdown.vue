<script setup lang="ts">
import { onUnmounted, ref } from 'vue';

/**
 * A <details> dropdown that closes its peers when it opens, closes
 * itself when the pointer goes down anywhere outside it or when Escape
 * is pressed, and can be disabled.
 *
 * <details> gives the open/close mechanics, keyboard activation, and a
 * summary button for free, but nothing stops two of them being open at
 * once, and nothing dismisses one when the user moves on — a toolbar
 * can end up wearing several menus (constitution IX wants one widget
 * doing one job one way). All of that lives here, in the widget, so
 * every dropdown in the app gets it by construction.
 *
 * Exclusivity is enforced in JS rather than the native `name`
 * attribute so the behavior is identical in every browser and in the
 * test DOM.
 *
 * The consumer supplies the summary and panel as slot content and may
 * style them itself (slotted markup keeps the parent's style scope);
 * the widget also ships unscoped `app-dropdown__*` classes so a menu
 * looks like every other menu without each consumer re-deriving the
 * panel.
 */
const props = withDefaults(defineProps<{
  /**
   * Dropdowns sharing a group close each other. The default groups the
   * whole app, which is the wanted UX: at most one dropdown open
   * anywhere. Name a group only to let two dropdowns stay open
   * side by side deliberately.
   */
  group?: string;
  /** A disabled dropdown ignores its summary and cannot open. */
  disabled?: boolean;
}>(), { group: 'app', disabled: false });

const detailsEl = ref<HTMLDetailsElement | null>(null);

/**
 * Capture-phase, so a click whose propagation something else swallows
 * still dismisses the menu. A pointer down inside the panel is not
 * "moving on" and leaves it open; items close it themselves if that is
 * what activating them means.
 */
function onOutsidePointerDown(event: Event): void {
  const el = detailsEl.value;
  if (!el?.open) return;
  if (event.target instanceof Node && el.contains(event.target)) return;
  el.open = false;
}

/**
 * Escape closes the menu and goes no further: whatever is listening
 * above — a dialog that closes on Escape, say — must not also act on
 * the press that dismissed a menu. Capture-phase on the document,
 * because a summary opened with `mousedown.prevent` leaves focus
 * wherever it was, so the key never travels through the dropdown.
 */
function onEscape(event: KeyboardEvent): void {
  const el = detailsEl.value;
  if (!el?.open || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  el.open = false;
  // Focus on a menu item just went into a hidden subtree; the summary
  // is where a keyboard user resumes. Focus elsewhere is left alone.
  if (el.contains(document.activeElement)) {
    el.querySelector('summary')?.focus();
  }
}

function unlisten(): void {
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('keydown', onEscape, true);
}

function onToggle(): void {
  const el = detailsEl.value;
  if (!el) return;
  if (!el.open) {
    unlisten();
    return;
  }
  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  document.addEventListener('keydown', onEscape, true);
  document
    .querySelectorAll<HTMLDetailsElement>(`details[data-dropdown-group="${props.group}"]`)
    .forEach((other) => {
      if (other !== el && other.open) other.open = false;
    });
}

/**
 * Summary activation toggles a <details> unconditionally, so disabling
 * means cancelling the activation before it does.
 */
function onClickCapture(event: Event): void {
  if (!props.disabled) return;
  event.preventDefault();
  event.stopPropagation();
}

onUnmounted(unlisten);
</script>

<template>
  <details
    ref="detailsEl"
    class="app-dropdown"
    :class="{ 'app-dropdown--disabled': disabled }"
    :data-dropdown-group="group"
    @toggle="onToggle"
    @click.capture="onClickCapture"
  >
    <slot />
  </details>
</template>

<!-- Unscoped on purpose: the widget's look is defined once and every
     consumer's slotted markup can reach it. Values mirror the compose
     toolbar's menus so all dropdown panels read as one system. -->
<style>
.app-dropdown {
  position: relative;
}
.app-dropdown--disabled > summary {
  cursor: default;
  opacity: 0.55;
}
.app-dropdown__summary {
  list-style: none;
  cursor: pointer;
}
.app-dropdown__summary::-webkit-details-marker {
  display: none;
}
.app-dropdown__summary::after {
  content: '▾';
  margin-left: 6px;
  font-size: 10px;
  opacity: 0.7;
}
.app-dropdown__summary--control {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  padding: 6px 9px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 13px;
}
.app-dropdown__summary--control:focus-visible {
  border-color: var(--accent);
  outline: none;
}
.app-dropdown__menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 3;
  display: grid;
  gap: 2px;
  min-width: 190px;
  max-height: min(46vh, 340px);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  background: var(--surface, #fff);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.22);
}
.app-dropdown__item {
  display: grid;
  grid-template-columns: 24px 1fr;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.app-dropdown__item:hover {
  background: rgba(127, 127, 127, 0.18);
}
.app-dropdown__item[aria-checked='true'] {
  font-weight: 600;
}
.app-dropdown__heading {
  padding: 4px 8px 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted, #6b7388);
}
</style>
