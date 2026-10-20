<script setup lang="ts">
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
    :aria-label="`${maximized ? 'Restore' : 'Maximize'} ${surface}`"
    :title="`${maximized ? 'Restore' : 'Maximize'} ${surface}`"
    @mousedown.prevent
    @click="$emit('toggle')"
  >
    <Shrink v-if="maximized" :size="18" :stroke-width="1.65" aria-hidden="true" />
    <Expand v-else :size="18" :stroke-width="1.65" aria-hidden="true" />
  </AppIconButton>
</template>
