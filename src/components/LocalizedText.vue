<script setup lang="ts">
import { Translation } from 'vue-i18n';
import { i18n } from '../i18n';

defineProps<{ keypath: string; plural?: number; tag?: string }>();
</script>

<template>
  <Translation :i18n="i18n.global" :keypath="keypath" :plural="plural" :tag="tag">
    <template v-for="(_, name) in $slots" #[name]>
      <slot :name="name" />
    </template>
  </Translation>
</template>
