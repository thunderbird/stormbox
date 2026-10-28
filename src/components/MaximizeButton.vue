<script setup lang="ts">
import { t } from '../i18n/messages';
import { Expand, Shrink } from '@lucide/vue';
import AppIconButton from './AppIconButton.vue';

defineProps<{
  maximized: boolean;
  surface: string;
}>();

defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <AppIconButton
    :aria-label="`${maximized ? t('maximizeButton.restore') : t('maximizeButton.maximize')} ${surface}`"
    :title="`${maximized ? t('maximizeButton.restore') : t('maximizeButton.maximize')} ${surface}`"
    @mousedown.prevent
    @click="$emit('toggle')"
  >
    <Shrink v-if="maximized" :size="18" :stroke-width="1.65" aria-hidden="true" />
    <Expand v-else :size="18" :stroke-width="1.65" aria-hidden="true" />
  </AppIconButton>
</template>
