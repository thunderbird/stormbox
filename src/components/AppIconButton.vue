<script setup lang="ts">
withDefaults(
  defineProps<{
    danger?: boolean;
    disabled?: boolean;
  }>(),
  { danger: false, disabled: false },
);
</script>

<template>
  <button
    class="app-icon-button"
    :class="{ 'app-icon-button--danger': danger }"
    type="button"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.app-icon-button {
  display: inline-grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
}

.app-icon-button:hover:where(:not(:disabled)) {
  background: var(--control-hover-bg);
  color: var(--text);
}

.app-icon-button--danger:hover:where(:not(:disabled)) {
  background: var(--error-bg);
  color: var(--error-fg);
}

.app-icon-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.app-icon-button:disabled,
.app-icon-button:disabled:hover {
  background: transparent;
  color: var(--muted);
  opacity: 0.35;
  cursor: default;
}

.app-icon-button :deep(svg) {
  display: block;
}
</style>
