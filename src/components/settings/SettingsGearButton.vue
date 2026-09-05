<script setup lang="ts">
/**
 * Gear in the top bar, present for every signed-in user. The shell owns
 * the dialog so the compact menu can open the same one.
 */
import { Settings } from '@lucide/vue';

const emit = defineEmits<{
  open: [];
}>();
</script>

<template>
  <button
    class="quick-filter__action settings-gear"
    type="button"
    aria-label="Settings"
    title="Settings"
    data-settings-gear
    @click="emit('open')"
  >
    <Settings :size="18" :stroke-width="1.75" aria-hidden="true" />
  </button>
</template>
