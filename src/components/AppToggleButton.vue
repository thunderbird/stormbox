<script setup lang="ts">
// House icon-toggle button: transparent at rest, filled with --accent when
// active so it matches AppButton/PrimaryButton's resting surface (the Bolt
// palette swaps both for its gradient in assets/bolt-theme.css). Used for
// the spaces rail; reach for this whenever a
// square icon button needs a selected state. aria-label/title/click fall
// through via attrs; aria-pressed tracks `active` automatically.
withDefaults(
  defineProps<{
    active?: boolean;
  }>(),
  { active: false },
);
</script>

<template>
  <button
    type="button"
    class="app-toggle-button"
    :class="{ 'is-active': active }"
    :aria-pressed="active"
  >
    <slot />
  </button>
</template>

<style scoped>
.app-toggle-button {
  position: relative;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.app-toggle-button:hover {
  background: var(--rowHover);
  color: var(--text);
}
.app-toggle-button.is-active {
  background: var(--accent);
  color: #fff;
}
</style>
