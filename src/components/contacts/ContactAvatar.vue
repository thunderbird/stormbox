<script setup lang="ts">
import {
  computed,
  ref,
  watch,
} from 'vue';

import type { ContactPhoto } from '../../types';
import { renderableContactPhotoUri } from '../../utils/contact-photo';
import {
  senderAvatarStyle,
  senderInitials,
} from '../../utils/sender-avatar';

const props = withDefaults(defineProps<{
  email?: string | null;
  name?: string | null;
  photo?: ContactPhoto | null;
  size?: 'compact' | 'large';
}>(), {
  email: null,
  name: null,
  photo: null,
  size: 'compact',
});

const failed = ref(false);
const imageUri = computed(() =>
  failed.value ? '' : renderableContactPhotoUri(props.photo));
const label = computed(() =>
  props.name?.trim() || props.email?.trim() || '');
const initials = computed(() => senderInitials(label.value));
const fallbackStyle = computed(() =>
  senderAvatarStyle(props.email?.trim() || label.value));

watch(
  () => props.photo?.uri,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <span
    class="contact-avatar"
    :class="`contact-avatar--${size}`"
    :style="fallbackStyle"
    aria-hidden="true"
  >
    {{ initials }}
    <img
      v-if="imageUri"
      :src="imageUri"
      alt=""
      decoding="async"
      @error="failed = true"
    />
  </span>
</template>

<style scoped>
.contact-avatar {
  position: relative;
  display: grid;
  flex: none;
  overflow: hidden;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 22%, transparent);
}

.contact-avatar--compact {
  width: 34px;
  height: 34px;
  font-size: 12px;
}

.contact-avatar--large {
  width: 96px;
  height: 96px;
  font-size: 30px;
}

.contact-avatar img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
