<script setup lang="ts">
import { computed } from 'vue';

import { useMailStore } from '../stores/mail-store';

/**
 * Modal progress overlay for large semantic move/destroy operations.
 * Protocol backends own wire-level chunking; this UI reports target
 * progress. The backdrop intentionally blocks
 * pointer events so the user does not stack a second triage action
 * (or a folder switch that would invalidate the mid-flight cache
 * apply) on top of the in-flight bulk operation.
 *
 * No close affordance: the constitution and the user-facing UX
 * agreed that a long-running bulk action runs to completion or
 * fails as a whole, and the overlay disappears on either outcome.
 * Cancellation would require teaching the outbox to abort an
 * in-flight Email/set without leaving the cache half-applied; that
 * is out of MVP scope.
 */
const mailStore = useMailStore();

const state = computed(() => mailStore.bulkOperation);
const subText = computed(() => {
  const { total } = state.value;
  if (total <= 0) return '';
  return `${total.toLocaleString()} messages`;
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.active"
      class="bulk-overlay"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      :aria-label="state.label"
    >
      <div class="bulk-overlay__card">
        <div class="bulk-overlay__title">{{ state.label }}…</div>
        <div
          class="bulk-overlay__progress"
          role="progressbar"
          :aria-valuetext="subText"
        >
          <div class="bulk-overlay__progress-fill" />
        </div>
        <div class="bulk-overlay__sub">
          <span>{{ subText }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.bulk-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, #000 45%, transparent);
  backdrop-filter: blur(2px);
}

.bulk-overlay__card {
  min-width: 320px;
  max-width: min(480px, calc(100vw - 32px));
  padding: 20px 24px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: 0 24px 48px color-mix(in srgb, #000 45%, transparent);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bulk-overlay__title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
}

.bulk-overlay__progress {
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 12%, transparent);
  overflow: hidden;
}

.bulk-overlay__progress-fill {
  width: 40%;
  height: 100%;
  background: var(--accent);
  border-radius: inherit;
  animation: bulk-progress-indeterminate 1.1s ease-in-out infinite;
}

@keyframes bulk-progress-indeterminate {
  from { transform: translateX(-110%); }
  to { transform: translateX(260%); }
}

@media (prefers-reduced-motion: reduce) {
  .bulk-overlay__progress-fill {
    width: 100%;
    animation: none;
    opacity: 0.65;
  }
}

.bulk-overlay__sub {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
