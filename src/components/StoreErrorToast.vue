<script setup lang="ts">
import { computed } from 'vue';
import { X } from '@lucide/vue';

import { useMailStore } from '../stores/mail-store';
import { useComposeStore } from '../stores/compose-store';
import { useContactsStore } from '../stores/contacts-store';

interface ToastEntry {
  source: 'mail' | 'compose' | 'contacts';
  message: string;
}

const mailStore = useMailStore();
const composeStore = useComposeStore();
const contactsStore = useContactsStore();

// Compose errors are already surfaced inline in the dialog while it
// is open; they only need a global toast when compose has closed
// without the user reading the inline message.
const entries = computed<ToastEntry[]>(() => {
  const out: ToastEntry[] = [];
  if (mailStore.error) {
    out.push({ source: 'mail', message: mailStore.error });
  }
  if (!composeStore.isOpen && composeStore.error) {
    out.push({ source: 'compose', message: composeStore.error });
  }
  if (contactsStore.error) {
    out.push({ source: 'contacts', message: contactsStore.error });
  }
  return out;
});

function dismiss(entry: ToastEntry) {
  if (entry.source === 'mail') {
    mailStore.error = null;
    return;
  }
  if (entry.source === 'compose') {
    composeStore.error = null;
    return;
  }
  if (entry.source === 'contacts') {
    contactsStore.error = null;
  }
}
</script>

<template>
  <div
    v-if="entries.length > 0"
    class="store-error-toast"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <div
      v-for="entry in entries"
      :key="entry.source"
      class="store-error-toast__item"
    >
      <span class="store-error-toast__message">{{ entry.message }}</span>
      <button
        class="store-error-toast__dismiss"
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        @click="dismiss(entry)"
      >
        <X :size="14" :stroke-width="2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.store-error-toast {
  position: fixed;
  z-index: 80;
  inset-inline: 0;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.store-error-toast__item {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  max-width: 560px;
  padding: 10px 12px 10px 14px;
  border-radius: 10px;
  background: var(--toast-bg, #c93838);
  color: #fff;
  box-shadow: 0 12px 28px color-mix(in srgb, #000 35%, transparent);
  font-size: 13px;
  line-height: 1.4;
}

.store-error-toast__message {
  flex: 1;
  white-space: pre-wrap;
}

.store-error-toast__dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.store-error-toast__dismiss:hover,
.store-error-toast__dismiss:focus-visible {
  background: rgba(255, 255, 255, 0.15);
  outline: none;
}
</style>
