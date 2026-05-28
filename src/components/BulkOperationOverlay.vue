<script setup lang="ts">
import { computed } from 'vue';

import { useMailStore } from '../stores/mail-store.js';

/**
 * Modal progress overlay for bulk move/destroy. Shown by the mail
 * store's `runChunkedMutation` whenever the number of messages
 * exceeds BULK_OPERATION_BATCH_SIZE: in that case the dispatch is
 * split into multiple Email/set chunks and the overlay ticks a
 * progress bar between chunks. The backdrop intentionally blocks
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
const percent = computed(() => {
  const total = state.value.total || 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((state.value.completed / total) * 100));
});
const subText = computed(() => {
  const { completed, total } = state.value;
  if (total <= 0) return '';
  return `${completed.toLocaleString()} of ${total.toLocaleString()} messages`;
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
          :aria-valuenow="percent"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuetext="subText"
        >
          <div class="bulk-overlay__progress-fill" :style="{ width: `${percent}%` }" />
        </div>
        <div class="bulk-overlay__sub">
          <span>{{ subText }}</span>
          <span>{{ percent }}%</span>
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
  height: 100%;
  background: var(--accent);
  border-radius: inherit;
  transition: width 120ms ease-out;
}

.bulk-overlay__sub {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
