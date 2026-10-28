<script setup lang="ts">
import { t } from '../i18n/messages';
defineProps({
  size: { type: Number, default: 56 },
});
</script>

<template>
  <img
    src="/logo.png"
    :width="size"
    :height="size"
    :alt="t('thundermailLogo.thundermail')"
    class="thundermail-logo"
    draggable="false"
  />
</template>

<style scoped>
.thundermail-logo {
  display: block;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}
</style>
