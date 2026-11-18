<script setup lang="ts">
import { NoticeBar, NoticeBarTypes } from '@thunderbirdops/services-ui';
import type { Banner } from '../composables/useDowntimeBanner';

defineProps<{ banner: Banner | null }>();

const NOTICE_BAR_TYPES: Record<Banner['type'], NoticeBarTypes> = {
  info: NoticeBarTypes.Info,
  warning: NoticeBarTypes.Warning,
  critical: NoticeBarTypes.Critical,
};
</script>

<template>
  <NoticeBar v-if="banner" :type="NOTICE_BAR_TYPES[banner.type]" role="status" class="downtime-banner">
    {{ banner.message }}
  </NoticeBar>
</template>

<style scoped>
.downtime-banner {
  /* A pasted status URL must wrap instead of widening its container past a phone screen. */
  overflow-wrap: anywhere;
}
</style>
