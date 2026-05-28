<script setup lang="ts">
import { computed } from 'vue';

import { useAuthStore } from '../stores/auth-store.js';
import { formatBytes } from '../utils/format-bytes.js';

const authStore = useAuthStore();

const label = computed(() => {
  if (!authStore.hasStorageQuota) {
    return null;
  }
  const used = formatBytes(authStore.quotaUsedBytes);
  const total = formatBytes(authStore.quotaHardLimitBytes);
  if (!used || !total) {
    return null;
  }
  return `${authStore.storagePercentUsed}% of ${total}`;
});
</script>

<template>
  <div v-if="authStore.hasStorageQuota && label" class="storage-usage" role="status" :aria-label="label">
    <div class="storage-usage__track" aria-hidden="true">
      <div class="storage-usage__fill" :style="{ width: authStore.storageProgressWidth }" />
    </div>
    <p class="storage-usage__label">{{ label }}</p>
  </div>
</template>

<style scoped>
.storage-usage {
  padding: 0 6px 4px;
}

.storage-usage__track {
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 28%, transparent);
  overflow: hidden;
}

.storage-usage__fill {
  height: 100%;
  border-radius: inherit;
  background: color-mix(in srgb, var(--text) 72%, var(--muted));
  transition: width 0.2s ease;
}

.storage-usage__label {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted);
}
</style>
