<script setup lang="ts">
import { useSessionStorage } from '@vueuse/core';
import { X } from '@lucide/vue';
import { NoticeBar, NoticeBarTypes } from '@thunderbirdops/services-ui';
import { THUNDERMAIL_STATUS_URL, useMaintenanceWindow } from '../composables/useMaintenanceWindow';
import AppIconButton from './AppIconButton.vue';

const emit = defineEmits<{ dismiss: [] }>();
const phase = useMaintenanceWindow({ durationMs: 10 * 60 * 1_000 });
const dismissed = useSessionStorage('stormbox.maintenance-2026-11-20.dismissed', false);

function dismiss() {
  dismissed.value = true;
  emit('dismiss');
}
</script>

<template>
  <div v-if="(phase === 'upcoming' || phase === 'ongoing') && !dismissed">
    <NoticeBar class="maintenance-notice" :type="NoticeBarTypes.Warning">
      Planned maintenance between 01:00 UTC / 5 PM PST and 05:00 UTC / 9 PM PST, see
      <a :href="THUNDERMAIL_STATUS_URL" target="_blank" rel="noopener noreferrer">status page</a>
      for updates.
      <template #cta>
        <AppIconButton aria-label="Dismiss maintenance notice" title="Dismiss maintenance notice" @click="dismiss">
          <X :size="18" aria-hidden="true" />
        </AppIconButton>
      </template>
    </NoticeBar>
  </div>
</template>

<style scoped>
.maintenance-notice {
  margin: 8px 8px 0;
}

@media (max-width: 639px) {
  .maintenance-notice.notice-bar,
  .maintenance-notice :deep(.notice-bar-content) {
    align-items: flex-start;
    flex-wrap: nowrap;
  }
  .maintenance-notice :deep(.cta) {
    flex-shrink: 0;
  }
}
</style>
