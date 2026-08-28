<script setup lang="ts">
import { computed } from 'vue';

import {
  COMPOSE_PRESENTATION,
  useComposeStore,
  type ComposeSession,
} from '../stores/compose-store';
import ComposeDialog from './ComposeDialog.vue';

const composeStore = useComposeStore();

const minimizedSessions = computed(() =>
  composeStore.sessions.filter(
    (session) => session.presentation === COMPOSE_PRESENTATION.MINIMIZED,
  ));

function dockLabel(session: ComposeSession): string {
  const subject = session.draft.subject.trim();
  if (subject) return subject;
  const recipient = session.draft.to[0] ?? session.draft.cc[0] ?? session.draft.bcc[0];
  return recipient?.name?.trim() || recipient?.email || 'New message';
}
</script>

<template>
  <ComposeDialog
    v-for="session in composeStore.sessions"
    :key="session.id"
    :session-id="session.id"
  />

  <div
    v-if="minimizedSessions.length"
    class="compose-dock"
    aria-label="Minimized compose windows"
  >
    <div
      v-for="session in minimizedSessions"
      :key="session.id"
      class="compose-dock__item"
    >
      <button
        type="button"
        class="compose-dock__restore"
        :aria-label="`Restore ${dockLabel(session)}`"
        @click="composeStore.restore(session.id)"
      >
        <span class="compose-dock__title">{{ dockLabel(session) }}</span>
        <span v-if="session.saveError" class="compose-dock__error" aria-label="Draft save failed">!</span>
      </button>
      <button
        type="button"
        class="compose-dock__close"
        :aria-label="`Close ${dockLabel(session)}`"
        :disabled="session.isSaving || session.isDiscarding"
        @click="composeStore.requestClose(session.id)"
      >×</button>
    </div>
  </div>
</template>

<style scoped>
.compose-dock {
  position: fixed;
  right: 16px;
  bottom: 0;
  z-index: 51;
  display: flex;
  flex-direction: row-reverse;
  align-items: flex-end;
  gap: 8px;
  max-width: calc(100vw - 32px);
  overflow-x: auto;
}

.compose-dock__item {
  display: flex;
  align-items: center;
  width: min(260px, calc(100vw - 32px));
  min-height: 40px;
  border: 1px solid var(--border, #d6d9e2);
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: var(--surface, #fff);
  box-shadow: 0 -4px 18px rgba(0, 0, 0, 0.18);
}

.compose-dock__restore,
.compose-dock__close {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.compose-dock__restore {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  text-align: left;
}

.compose-dock__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compose-dock__error {
  color: var(--colour-ti-critical, #b3261e);
  font-weight: 700;
}

.compose-dock__close {
  align-self: stretch;
  padding: 0 12px;
  font-size: 20px;
}

.compose-dock__restore:hover,
.compose-dock__close:hover {
  background: rgba(127, 127, 127, 0.14);
}

.compose-dock__close:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
</style>
