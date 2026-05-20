<script setup lang="ts">
defineProps({
  size: { type: Number, default: 56 },
});
</script>

<template>
  <img
    src="/logo.png"
    :width="size"
    :height="size"
    alt="Thundermail"
    class="thunderbird-logo"
    draggable="false"
  />
</template>

<style scoped>
.thunderbird-logo {
  display: block;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}
</style>
