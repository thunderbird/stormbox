<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';

import {
  COMPOSE_PRESENTATION,
  useComposeStore,
  type ComposeSession,
} from '../stores/compose-store';
import ComposeDialog from './ComposeDialog.vue';

/** Duration of the outline that flies from the composer card to its dock item on minimize. */
const MINIMIZE_FLIGHT_MS = 380;

interface FlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const composeStore = useComposeStore();

const minimizedSessions = computed(() =>
  composeStore.sessions.filter(
    (session) => session.presentation === COMPOSE_PRESENTATION.MINIMIZED,
  ));

// Minimizing hides a large card and reveals a small dock item elsewhere on
// screen. A translucent outline travels between the two so the eye can
// follow where the draft went. Presentation changes are watched with sync
// flush so the card can be measured before Vue hides it.
const flightRect = shallowRef<FlightRect | null>(null);
const flightLanding = ref(false);
let flightTimer: ReturnType<typeof setTimeout> | null = null;

function rectOf(element: Element | null): FlightRect | null {
  if (!element) return null;
  const { top, left, width, height } = element.getBoundingClientRect();
  return { top, left, width, height };
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clearFlight(): void {
  if (flightTimer) clearTimeout(flightTimer);
  flightTimer = null;
  flightRect.value = null;
  flightLanding.value = false;
}

async function flyToDock(sessionId: string, from: FlightRect): Promise<void> {
  // Called from a sync watcher, before Vue has queued the re-render; yield a
  // microtask so the following tick waits for the dock item to mount.
  await Promise.resolve();
  await nextTick();
  const to = rectOf(document.querySelector(`.compose-dock__item[data-session-id="${sessionId}"]`));
  if (!to) return;
  clearFlight();
  flightRect.value = from;
  flightLanding.value = false;
  await nextTick();
  // The outline must paint at the card first; the landing frame then transitions.
  await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
  if (flightRect.value !== from) return;
  flightRect.value = to;
  flightLanding.value = true;
  flightTimer = setTimeout(clearFlight, MINIMIZE_FLIGHT_MS);
}

watch(
  () => composeStore.sessions.map((session) => `${session.id}:${session.presentation}`),
  (next, previous) => {
    if (typeof document === 'undefined' || reducedMotion()) return;
    const wasExpanded = new Set(
      (previous ?? [])
        .filter((entry) => entry.endsWith(`:${COMPOSE_PRESENTATION.EXPANDED}`))
        .map((entry) => entry.slice(0, entry.lastIndexOf(':'))),
    );
    for (const entry of next) {
      if (!entry.endsWith(`:${COMPOSE_PRESENTATION.MINIMIZED}`)) continue;
      const id = entry.slice(0, entry.lastIndexOf(':'));
      if (!wasExpanded.has(id)) continue;
      const from = rectOf(document.querySelector('.compose-dialog--expanded .compose-dialog__card'));
      if (from) void flyToDock(id, from);
    }
  },
  { flush: 'sync' },
);

onBeforeUnmount(clearFlight);

const flightStyle = computed(() => {
  const rect = flightRect.value;
  if (!rect) return undefined;
  return {
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    transitionDuration: `${MINIMIZE_FLIGHT_MS}ms`,
  };
});

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
      :data-session-id="session.id"
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

  <div
    v-if="flightRect"
    class="compose-dock-flight"
    :class="{ 'compose-dock-flight--landing': flightLanding }"
    :style="flightStyle"
    aria-hidden="true"
    data-testid="compose-dock-flight"
  />
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
  /* The hairline --border token vanishes against the message list in both
     themes, so the dock outline is accent-tinted. */
  border: 2px solid var(--compose-dock-outline);
  border-bottom: 0;
  border-radius: 10px 10px 0 0;
  background: var(--surface, #fff);
  box-shadow: 0 -6px 22px rgba(0, 0, 0, 0.28);
  --compose-dock-outline: color-mix(in srgb, var(--accent, #1373d9) 75%, var(--surface, #fff));
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

.compose-dock-flight {
  position: fixed;
  z-index: 52;
  box-sizing: border-box;
  border: 2px solid color-mix(in srgb, var(--accent, #1373d9) 75%, var(--surface, #fff));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent, #1373d9) 12%, transparent);
  opacity: 0.9;
  pointer-events: none;
  transition-property: top, left, width, height, opacity;
  transition-timing-function: cubic-bezier(0.2, 0.7, 0.2, 1);
}
.compose-dock-flight--landing {
  opacity: 0;
}
</style>
