<script setup lang="ts">
import { computed } from 'vue';
import { X } from '@lucide/vue';

import { COMPOSE_STATE } from '../constants/states';
import { useMailStore } from '../stores/mail-store';
import {
  COMPOSE_PRESENTATION,
  sessionLabel,
  useComposeStore,
} from '../stores/compose-store';
import { useContactsStore } from '../stores/contacts-store';

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastEntry {
  key: string;
  message: string;
  kind: 'error' | 'success' | 'progress';
  /** Set on the entries that stand in for a compose session while it is off screen (CS-1.16). */
  sessionId?: string;
  action?: ToastAction;
  /** Null for an entry that resolves on its own and offers no dismiss. */
  dismiss: (() => void) | null;
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
    out.push({
      key: 'mail',
      message: mailStore.error,
      kind: 'error',
      dismiss: () => { mailStore.error = null; },
    });
  }
  if (mailStore.notice) {
    out.push({
      key: 'mail-notice',
      message: mailStore.notice,
      kind: 'success',
      dismiss: () => { mailStore.notice = null; },
    });
  }
  // One entry per session whose send has taken it off screen: progress
  // while the send is in flight, then — when the session had to dock
  // because another composer was expanded — the failure with Open. The
  // entry keeps its key across the two so the same toast changes state.
  for (const session of composeStore.sessions) {
    if (session.presentation === COMPOSE_PRESENTATION.HIDDEN
        && session.status === COMPOSE_STATE.SENDING) {
      out.push({
        key: `compose-send:${session.id}`,
        sessionId: session.id,
        kind: 'progress',
        message: `${session.sendingScheduledAt ? 'Scheduling' : 'Sending'} “${sessionLabel(session)}”…`,
        dismiss: null,
      });
    } else if (session.dockedSendFailure) {
      out.push({
        key: `compose-send:${session.id}`,
        sessionId: session.id,
        kind: 'error',
        message: `Couldn’t send “${sessionLabel(session)}”.`,
        action: { label: 'Open', run: () => { composeStore.restore(session.id); } },
        dismiss: () => { composeStore.dismissSendFailureNotice(session.id); },
      });
    }
  }
  if (!composeStore.isOpen && composeStore.error) {
    out.push({
      key: 'compose',
      message: composeStore.error,
      kind: 'error',
      dismiss: () => { composeStore.error = null; },
    });
  }
  if (composeStore.notice) {
    out.push({
      key: 'compose-notice',
      message: composeStore.notice,
      kind: 'success',
      dismiss: () => { composeStore.clearNotice(); },
    });
  }
  if (contactsStore.error) {
    out.push({
      key: 'contacts',
      message: contactsStore.error,
      kind: 'error',
      dismiss: () => { contactsStore.error = null; },
    });
  }
  return out;
});
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
      :key="entry.key"
      class="store-error-toast__item"
      :class="{
        'store-error-toast__item--success': entry.kind === 'success',
        'store-error-toast__item--progress': entry.kind === 'progress',
      }"
      :data-session-id="entry.sessionId"
      :aria-busy="entry.kind === 'progress' ? 'true' : undefined"
    >
      <span class="store-error-toast__message">{{ entry.message }}</span>
      <button
        v-if="entry.action"
        class="store-error-toast__action"
        type="button"
        @click="entry.action.run()"
      >{{ entry.action.label }}</button>
      <button
        v-if="entry.dismiss"
        class="store-error-toast__dismiss"
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        @click="entry.dismiss()"
      >
        <X :size="14" :stroke-width="2" aria-hidden="true" />
      </button>
      <span
        v-if="entry.kind === 'progress'"
        class="store-error-toast__progress"
        aria-hidden="true"
      />
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
  position: relative;
  overflow: hidden;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  max-width: 560px;
  padding: 10px 12px 10px 14px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--toast-bg, #c93838);
  color: #fff;
  box-shadow: 0 12px 28px color-mix(in srgb, #000 35%, transparent);
  font-size: 13px;
  line-height: 1.4;
  transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.store-error-toast__item--success {
  background: var(--toast-success-bg, #2e9e63);
}

/* In flight: the app's own surface with the accent hairline sweeping along
   the top, so the outcome colour (success or error) is the change the eye
   catches when the send settles. */
.store-error-toast__item--progress {
  background: var(--panel, #fff);
  color: var(--text, #111827);
  border-color: var(--border, #d9d9de);
}

.store-error-toast__message {
  flex: 1;
  white-space: pre-wrap;
}

.store-error-toast__action {
  flex: 0 0 auto;
  padding: 2px 10px;
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  font: inherit;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
}
.store-error-toast__action:hover,
.store-error-toast__action:focus-visible {
  background: rgba(255, 255, 255, 0.24);
  outline: none;
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

.store-error-toast__progress {
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: color-mix(in srgb, var(--accent, #1373d9) 25%, transparent);
}
.store-error-toast__progress::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 38%;
  background: var(--accent, #1373d9);
  animation: store-error-toast-sweep 1.4s ease-in-out infinite;
}

@keyframes store-error-toast-sweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(270%); }
}

@media (prefers-reduced-motion: reduce) {
  .store-error-toast__item {
    transition: none;
  }
  .store-error-toast__progress::after {
    width: 100%;
    animation: none;
  }
}
</style>
