<script setup lang="ts">
import { computed, ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { LogOut, RotateCcw, Settings } from 'lucide-vue-next';

import { useAuthStore } from '../stores/auth-store.js';
import { ACCOUNTS_URL } from '../defines.js';
import { senderAvatarStyle, senderInitials } from '../utils/sender-avatar.js';

const authStore = useAuthStore();
const emit = defineEmits<{
  (event: 'show-welcome-modal'): void;
}>();

const detailsEl = ref<HTMLDetailsElement | null>(null);

const identityLabel = computed(
  () => authStore.username || authStore.serverHostname || '',
);

const initials = computed(() => senderInitials(identityLabel.value));
const avatarStyle = computed(() => senderAvatarStyle(identityLabel.value));

onClickOutside(detailsEl, () => {
  if (detailsEl.value?.open) detailsEl.value.open = false;
});

function onLogout() {
  if (detailsEl.value) detailsEl.value.open = false;
  authStore.logout();
}

function onShowWelcomeModal() {
  if (detailsEl.value) detailsEl.value.open = false;
  emit('show-welcome-modal');
}
</script>

<template>
  <details ref="detailsEl" class="account-menu">
    <summary class="account-menu__button" aria-label="Open account menu">
      <span class="account-menu__avatar" :style="avatarStyle" aria-hidden="true">
        {{ initials }}
      </span>
    </summary>
    <div class="account-menu__popover" role="menu">
      <div class="account-menu__identity">
        <span class="account-menu__avatar account-menu__avatar--large" :style="avatarStyle" aria-hidden="true">
          {{ initials }}
        </span>
        <span class="account-menu__email">{{ identityLabel }}</span>
      </div>
      <a class="account-menu__item" :href="ACCOUNTS_URL" role="menuitem">
        <Settings :size="16" :stroke-width="1.75" aria-hidden="true" />
        <span>Account Settings</span>
      </a>
      <button class="account-menu__item" type="button" role="menuitem" @click="onShowWelcomeModal">
        <RotateCcw :size="16" :stroke-width="1.75" aria-hidden="true" />
        <span>Show Welcome Modal</span>
      </button>
      <button class="account-menu__item" type="button" role="menuitem" @click="onLogout">
        <LogOut :size="16" :stroke-width="1.75" aria-hidden="true" />
        <span>Log Out</span>
      </button>
    </div>
  </details>
</template>

<style scoped>
.account-menu {
  position: relative;
}

.account-menu__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.account-menu__button::-webkit-details-marker {
  display: none;
}
.account-menu__button:hover,
.account-menu__button:focus-visible,
.account-menu[open] .account-menu__button {
  background: var(--rowHover);
  border-color: var(--border-soft);
  outline: none;
}

.account-menu__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.account-menu__avatar--large {
  width: 40px;
  height: 40px;
  font-size: 14px;
}

.account-menu__popover {
  position: absolute;
  z-index: 30;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 16px 32px color-mix(in srgb, #000 32%, transparent);
}

.account-menu__identity {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 12px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 4px;
}
.account-menu__email {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 13px;
  color: var(--text);
}

.account-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  font-size: 13px;
  text-align: left;
  text-decoration: none;
}
.account-menu__item:hover,
.account-menu__item:focus-visible {
  background: var(--rowHover);
  outline: none;
}
.account-menu__item svg {
  flex-shrink: 0;
  color: var(--muted);
}
</style>
