<script setup lang="ts">
import { NoticeBar, NoticeBarTypes } from '@thunderbirdops/services-ui';
import { useDowntimeBanner, type Banner } from '../composables/useDowntimeBanner';

const props = defineProps<{ url: string }>();

const NOTICE_BAR_TYPES: Record<Banner['type'], NoticeBarTypes> = {
  info: NoticeBarTypes.Info,
  warning: NoticeBarTypes.Warning,
  critical: NoticeBarTypes.Critical,
};

const { banner } = useDowntimeBanner(props.url);
</script>

<template>
  <NoticeBar v-if="banner" :type="NOTICE_BAR_TYPES[banner.type]" role="status" class="downtime-banner">
    {{ banner.message }}
    <a v-if="banner.link" :href="banner.link.href" target="_blank" rel="noopener">{{ banner.link.text }}</a>
  </NoticeBar>
</template>

<style scoped>
.downtime-banner {
  /* A pasted status URL must wrap instead of widening its container past a phone screen. */
  overflow-wrap: anywhere;
}
</style>
