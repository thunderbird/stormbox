<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { onClickOutside } from '@vueuse/core';

import { useModalFocus } from '../composables/useModalFocus';
import {
  BEACON_TIMING,
  FEATURE_BEACONS,
  beaconById,
  type BeaconId,
  type FeatureBeacon,
} from '../constants/feature-beacons';
import { useFeatureBeaconsStore } from '../stores/feature-beacons-store';

/**
 * Pulsing dots on the controls that still have an unseen beacon, plus one
 * card. Anchors are measured from the live DOM: one that is missing,
 * zero-sized, off screen, or covered (the composer backdrop over the
 * sidebar, a row scrolled out of its container) gets no dot.
 *
 * The card opens three ways:
 * - hovering or focusing a dot, or hovering its control, previews it and
 *   it closes when the pointer leaves (unless it moves onto the card);
 * - clicking a dot or picking an item in the header pill pins it
 *   (`store.openId`): it takes focus, contains Tab, and gates shortcuts;
 * - clicking the control itself counts as finding the feature: the beacon
 *   is marked seen and the card shows alongside, without taking focus,
 *   until the next click or a timeout.
 * Reading a card for `seenDwellMs` marks its beacon seen. The layer sits
 * above the composer (50) and its dock (51) but below every modal.
 */

interface Anchor {
  id: BeaconId;
  element: HTMLElement;
  rect: DOMRect;
}

interface LocalCard {
  id: BeaconId;
  mode: 'preview' | 'alongside';
}

interface CardPosition {
  left: number;
  top: number;
}

/* Hit target size; the 10px dot is centred on the anchor's top-right corner,
   or on its left edge at mid-height for `dot: 'inline-start'` beacons. */
const DOT_SIZE = 32;
const DOT_VIEWPORT_MARGIN = 0;
const CARD_OFFSET = 12;
const CARD_VIEWPORT_PADDING = 12;

const store = useFeatureBeaconsStore();

const layerEl = ref<HTMLElement | null>(null);
const cardEl = ref<HTMLElement | null>(null);
const dotEls = new Map<BeaconId, HTMLButtonElement>();
const anchors = ref<Anchor[]>([]);
const localCard = ref<LocalCard | null>(null);
const cardPosition = ref<CardPosition | null>(null);

const dots = computed(() =>
  anchors.value.filter((anchor) => store.isUnseen(anchor.id)));
const pinnedId = computed(() => store.openId);
const cardId = computed<BeaconId | null>(() => pinnedId.value ?? localCard.value?.id ?? null);
const cardBeacon = computed<FeatureBeacon | null>(() =>
  (store.enabled && cardId.value
    ? FEATURE_BEACONS.find((beacon) => beacon.id === cardId.value) ?? null
    : null));
const cardAnchor = computed(() =>
  anchors.value.find((anchor) => anchor.id === cardId.value) ?? null);
const cardVisible = computed(() => cardBeacon.value != null && cardAnchor.value != null);
const pinnedOpen = computed(() => pinnedId.value != null && cardVisible.value);
// Until floating-ui has placed it the card is transparent rather than
// `visibility: hidden`, which would refuse the focus a pinned card takes.
const cardStyle = computed(() => (cardPosition.value
  ? { left: `${cardPosition.value.left}px`, top: `${cardPosition.value.top}px` }
  : { opacity: 0 }));

let frame: number | null = null;
let observer: MutationObserver | null = null;
let anchorGraceTimer: ReturnType<typeof setTimeout> | null = null;
let previewOpenTimer: ReturnType<typeof setTimeout> | null = null;
let previewCloseTimer: ReturnType<typeof setTimeout> | null = null;
let alongsideTimer: ReturnType<typeof setTimeout> | null = null;
let dwellTimer: ReturnType<typeof setTimeout> | null = null;
// Where focus was when the card was pinned (its dot, or the pill's
// trigger), captured at open() because a staged card only activates once
// its host has mounted and possibly taken focus itself.
let pinOrigin: HTMLElement | null = null;
let lastPinnedId: BeaconId | null = null;

watch(pinnedId, (pinned) => {
  if (pinned == null) return;
  lastPinnedId = pinned;
  const active = document.activeElement;
  pinOrigin = active instanceof HTMLElement && active !== document.body ? active : null;
}, { flush: 'sync' });

// Whether focus can go back to where the card was pinned from: the dot
// retires once the card has been read, the pill goes with the last unseen
// beacon, and a host the reveal opened (the composer) can cover the pill.
// Failing that, focus lands on the control itself.
function canRestoreTo(origin: HTMLElement): boolean {
  if (!origin.isConnected) return false;
  const closedDetails = origin.closest('details:not([open])');
  if (closedDetails && origin.closest('summary')?.parentElement !== closedDetails) return false;
  return anchorVisible(origin, origin.getBoundingClientRect());
}

function restoreFocusTarget(): HTMLElement | null {
  const origin = pinOrigin;
  pinOrigin = null;
  if (origin && canRestoreTo(origin)) return origin;
  if (lastPinnedId == null) return null;
  const dot = dotEls.get(lastPinnedId);
  if (dot?.isConnected) return dot;
  const anchor = document.querySelector(beaconById(lastPinnedId).anchor);
  return anchor instanceof HTMLElement ? anchor : null;
}

useModalFocus(cardEl, { active: pinnedOpen, containTab: true, restoreTo: restoreFocusTarget });

onClickOutside(cardEl, () => {
  if (pinnedId.value != null) store.close();
  localCard.value = null;
}, { ignore: ['.feature-beacons__dot'] });

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer != null) clearTimeout(timer);
  return null;
}

function beaconTitle(id: BeaconId): string {
  return FEATURE_BEACONS.find((beacon) => beacon.id === id)?.title ?? '';
}

function setDotEl(id: BeaconId, element: unknown): void {
  if (element instanceof HTMLButtonElement) dotEls.set(id, element);
  else dotEls.delete(id);
}

function dotStyle(anchor: Anchor): Record<string, string> {
  const half = DOT_SIZE / 2;
  const inline = beaconById(anchor.id).dot === 'inline-start';
  const centreX = inline ? anchor.rect.left : anchor.rect.right;
  const centreY = inline ? anchor.rect.top + anchor.rect.height / 2 : anchor.rect.top;
  const left = Math.min(
    Math.max(centreX - half, DOT_VIEWPORT_MARGIN),
    window.innerWidth - DOT_SIZE - DOT_VIEWPORT_MARGIN,
  );
  const top = Math.min(
    Math.max(centreY - half, DOT_VIEWPORT_MARGIN),
    window.innerHeight - DOT_SIZE - DOT_VIEWPORT_MARGIN,
  );
  return { left: `${left}px`, top: `${top}px` };
}

function anchorVisible(anchor: HTMLElement, rect: DOMRect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.bottom <= 0 || rect.right <= 0) return false;
  if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
  if (typeof document.elementFromPoint !== 'function') return true;
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  if (!hit) return false;
  return anchor === hit || anchor.contains(hit);
}

// Unseen beacons get dots; the open card's beacon is tracked too because its
// dot may already have retired while the card is still being read.
function trackedBeacons(): FeatureBeacon[] {
  const tracked = [...store.unseen];
  const open = cardId.value;
  if (open && !tracked.some((beacon) => beacon.id === open)) {
    const beacon = FEATURE_BEACONS.find((entry) => entry.id === open);
    if (beacon) tracked.push(beacon);
  }
  return tracked;
}

function measure(): void {
  frame = null;
  if (typeof document === 'undefined') return;
  const next: Anchor[] = [];
  // The layer's own dots and card must not count as covering an anchor, so
  // they are taken out of hit testing while measuring.
  layerEl.value?.classList.add('is-measuring');
  try {
    for (const beacon of trackedBeacons()) {
      const element = document.querySelector(beacon.anchor);
      if (!(element instanceof HTMLElement)) continue;
      const rect = element.getBoundingClientRect();
      if (!anchorVisible(element, rect)) continue;
      next.push({ id: beacon.id, element, rect });
    }
  } finally {
    layerEl.value?.classList.remove('is-measuring');
  }
  anchors.value = next;
  void positionCard();
}

function scheduleMeasure(): void {
  if (frame != null) return;
  if (typeof requestAnimationFrame === 'undefined') {
    measure();
    return;
  }
  frame = requestAnimationFrame(measure);
}

async function positionCard(): Promise<void> {
  const anchor = cardAnchor.value;
  await nextTick();
  const card = cardEl.value;
  if (!anchor || !card) {
    cardPosition.value = null;
    return;
  }
  // Beside the control when it fits, otherwise above or below it, aligned
  // to its right edge; to the left only as a last resort, because there it
  // covers the neighbouring controls in the anchor's row (Send beside the
  // schedule segment).
  const position = await computePosition(anchor.element, card, {
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [
      offset(CARD_OFFSET),
      flip({ fallbackPlacements: ['bottom-end', 'top-end', 'left-start'] }),
      shift({ padding: CARD_VIEWPORT_PADDING }),
    ],
  });
  if (cardAnchor.value !== anchor || cardEl.value !== card) return;
  cardPosition.value = { left: position.x, top: position.y };
}

// A pinned card whose anchor is not on screen (staged beacon whose host is
// still mounting) waits briefly for it; if it never resolves it is dropped.
watch([pinnedId, cardAnchor], ([pinned, anchor]) => {
  if (pinned == null || anchor) {
    anchorGraceTimer = clearTimer(anchorGraceTimer);
    return;
  }
  if (anchorGraceTimer != null) return;
  anchorGraceTimer = setTimeout(() => {
    anchorGraceTimer = null;
    if (store.openId != null && !cardAnchor.value) store.close();
  }, BEACON_TIMING.anchorGraceMs);
}, { immediate: true });

// A local card whose anchor has gone (composer closed under an alongside
// card) is dropped at once.
watch([() => localCard.value?.id, cardAnchor, () => anchors.value], ([local]) => {
  if (local && !anchors.value.some((anchor) => anchor.id === local)) localCard.value = null;
});

// A pinned card replaces any preview.
watch(pinnedId, (pinned) => {
  if (pinned != null) {
    localCard.value = null;
    previewOpenTimer = clearTimer(previewOpenTimer);
    previewCloseTimer = clearTimer(previewCloseTimer);
  }
  scheduleMeasure();
});

watch(() => localCard.value?.id, () => {
  scheduleMeasure();
});

watch(() => store.unseen, () => {
  scheduleMeasure();
});

// The store keeps the round alive while the last card is still being read.
watch(cardVisible, (visible) => {
  store.setCardShowing(visible);
}, { immediate: true });

// Reading a card counts as seeing the feature.
watch([cardId, cardVisible], ([id, visible]) => {
  dwellTimer = clearTimer(dwellTimer);
  if (!id || !visible || !store.isUnseen(id)) return;
  dwellTimer = setTimeout(() => {
    dwellTimer = null;
    if (cardId.value === id && cardVisible.value) store.markSeen(id);
  }, BEACON_TIMING.seenDwellMs);
}, { immediate: true });

function openPreview(id: BeaconId): void {
  previewCloseTimer = clearTimer(previewCloseTimer);
  if (pinnedId.value != null) return;
  if (localCard.value?.id === id) return;
  previewOpenTimer = clearTimer(previewOpenTimer);
  previewOpenTimer = setTimeout(() => {
    previewOpenTimer = null;
    if (pinnedId.value == null && store.isUnseen(id)) localCard.value = { id, mode: 'preview' };
  }, BEACON_TIMING.previewOpenMs);
}

function schedulePreviewClose(): void {
  previewOpenTimer = clearTimer(previewOpenTimer);
  if (localCard.value?.mode !== 'preview') return;
  if (previewCloseTimer != null) return;
  previewCloseTimer = setTimeout(() => {
    previewCloseTimer = null;
    if (localCard.value?.mode === 'preview') localCard.value = null;
  }, BEACON_TIMING.previewCloseMs);
}

function showAlongside(id: BeaconId): void {
  alongsideTimer = clearTimer(alongsideTimer);
  previewOpenTimer = clearTimer(previewOpenTimer);
  previewCloseTimer = clearTimer(previewCloseTimer);
  if (pinnedId.value != null) store.close();
  localCard.value = { id, mode: 'alongside' };
  alongsideTimer = setTimeout(() => {
    alongsideTimer = null;
    if (localCard.value?.mode === 'alongside') localCard.value = null;
  }, BEACON_TIMING.alongsideMs);
}

function anchorIdAt(target: EventTarget | null): BeaconId | null {
  if (!(target instanceof Node)) return null;
  return anchors.value.find((anchor) => anchor.element.contains(target))?.id ?? null;
}

function onDotClick(id: BeaconId): void {
  if (pinnedId.value === id) {
    store.close();
    return;
  }
  // Focus returns to the dot when the card closes.
  dotEls.get(id)?.focus({ preventScroll: true });
  store.open(id);
}

function onDotFocus(id: BeaconId): void {
  openPreview(id);
}

function onDotBlur(): void {
  // Focus moving into the card keeps the preview up.
  void nextTick(() => {
    if (!layerEl.value?.contains(document.activeElement)) schedulePreviewClose();
  });
}

// One document-level listener covers pointer movement onto and off every
// anchor and dot; the card itself cancels a pending close.
function onDocumentPointerOver(event: PointerEvent): void {
  if (event.pointerType === 'touch') return;
  const target = event.target;
  if (cardEl.value && target instanceof Node && cardEl.value.contains(target)) {
    previewCloseTimer = clearTimer(previewCloseTimer);
    return;
  }
  const dot = target instanceof Element ? target.closest('.feature-beacons__dot') : null;
  const dotId = dot instanceof HTMLElement ? dot.dataset.beacon as BeaconId | undefined : undefined;
  const id = dotId ?? anchorIdAt(target);
  if (id && store.isUnseen(id)) {
    openPreview(id);
    return;
  }
  schedulePreviewClose();
}

// Using the control is discovery: the beacon retires and its card shows
// once beside the control without taking focus.
function onDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (layerEl.value && target instanceof Node && layerEl.value.contains(target)) return;
  const id = anchorIdAt(target);
  if (!id || !store.isUnseen(id)) return;
  store.markSeen(id);
  showAlongside(id);
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (pinnedOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    store.close();
    return;
  }
  if (localCard.value) localCard.value = null;
}

function onGotIt(): void {
  const id = cardId.value;
  if (id) store.markSeen(id);
  if (pinnedId.value != null) store.close();
  localCard.value = null;
}

function onMutations(records: MutationRecord[]): void {
  const layer = layerEl.value;
  if (layer && records.every((record) => layer.contains(record.target))) return;
  scheduleMeasure();
}

onMounted(() => {
  window.addEventListener('resize', scheduleMeasure);
  window.addEventListener('scroll', scheduleMeasure, { capture: true, passive: true });
  window.addEventListener('keydown', onWindowKeydown, true);
  document.addEventListener('pointerover', onDocumentPointerOver, true);
  document.addEventListener('click', onDocumentClick, true);
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'open'],
    });
  }
  scheduleMeasure();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleMeasure);
  window.removeEventListener('scroll', scheduleMeasure, { capture: true });
  window.removeEventListener('keydown', onWindowKeydown, true);
  document.removeEventListener('pointerover', onDocumentPointerOver, true);
  document.removeEventListener('click', onDocumentClick, true);
  observer?.disconnect();
  observer = null;
  if (frame != null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
  frame = null;
  anchorGraceTimer = clearTimer(anchorGraceTimer);
  previewOpenTimer = clearTimer(previewOpenTimer);
  previewCloseTimer = clearTimer(previewCloseTimer);
  alongsideTimer = clearTimer(alongsideTimer);
  dwellTimer = clearTimer(dwellTimer);
  localCard.value = null;
  store.setCardShowing(false);
  store.close();
});
</script>

<template>
  <div ref="layerEl" class="feature-beacons" data-testid="feature-beacons">
    <button
      v-for="dot in dots"
      :key="dot.id"
      :ref="(element) => setDotEl(dot.id, element)"
      class="feature-beacons__dot"
      :class="{ 'is-open': cardId === dot.id }"
      type="button"
      :style="dotStyle(dot)"
      :data-beacon="dot.id"
      :aria-label="`New: ${beaconTitle(dot.id)}`"
      aria-haspopup="dialog"
      :aria-expanded="cardId === dot.id && cardVisible"
      @click="onDotClick(dot.id)"
      @focus="onDotFocus(dot.id)"
      @blur="onDotBlur"
    >
      <span class="feature-beacons__halo" aria-hidden="true" />
      <span class="feature-beacons__core" aria-hidden="true" />
    </button>

    <section
      v-if="cardBeacon && cardAnchor"
      ref="cardEl"
      class="feature-beacons__card"
      :class="{ 'feature-beacons__card--pinned': pinnedOpen }"
      role="dialog"
      tabindex="-1"
      :aria-labelledby="`feature-beacon-title-${cardBeacon.id}`"
      :aria-describedby="`feature-beacon-body-${cardBeacon.id}`"
      :data-beacon-card="cardBeacon.id"
      :data-beacon-card-mode="pinnedOpen ? 'pinned' : localCard?.mode"
      :style="cardStyle"
      @pointerleave="schedulePreviewClose"
    >
      <header class="feature-beacons__card-header">
        <span class="feature-beacons__card-icon" aria-hidden="true">
          <component :is="cardBeacon.icon" :size="18" :stroke-width="1.75" />
        </span>
        <div class="feature-beacons__card-heading">
          <span class="feature-beacons__card-kicker">New</span>
          <h3 :id="`feature-beacon-title-${cardBeacon.id}`" class="feature-beacons__card-title">
            {{ cardBeacon.title }}
          </h3>
        </div>
      </header>
      <p :id="`feature-beacon-body-${cardBeacon.id}`" class="feature-beacons__card-body">
        {{ cardBeacon.body }}
      </p>
      <footer class="feature-beacons__card-actions">
        <button class="feature-beacons__got-it" type="button" @click="onGotIt">
          Got it
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.feature-beacons {
  position: fixed;
  inset: 0;
  z-index: 60;
  pointer-events: none;
}
.feature-beacons.is-measuring .feature-beacons__dot,
.feature-beacons.is-measuring .feature-beacons__card {
  pointer-events: none;
}

.feature-beacons__dot {
  position: fixed;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
}
.feature-beacons__dot:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -4px;
}
.feature-beacons__core,
.feature-beacons__halo {
  grid-area: 1 / 1;
  border-radius: 999px;
}
.feature-beacons__core {
  width: 10px;
  height: 10px;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--panel);
}
.feature-beacons__halo {
  width: 10px;
  height: 10px;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  animation: feature-beacon-pulse 2s ease-out infinite;
}
.feature-beacons__dot:hover .feature-beacons__halo,
.feature-beacons__dot.is-open .feature-beacons__halo {
  animation: none;
  transform: scale(2.2);
  opacity: 0.35;
}
@keyframes feature-beacon-pulse {
  0% {
    transform: scale(1);
    opacity: 0.7;
  }
  100% {
    transform: scale(2.6);
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .feature-beacons__halo {
    animation: none;
    transform: scale(2);
    opacity: 0.3;
  }
}

.feature-beacons__card {
  position: fixed;
  top: 0;
  left: 0;
  width: min(320px, calc(100vw - 24px));
  padding: 14px 16px 12px;
  border: 1px solid var(--modal-border);
  border-radius: 12px;
  background: var(--modal-surface);
  box-shadow: var(--modal-shadow);
  color: var(--text);
  pointer-events: auto;
}
.feature-beacons__card:focus {
  outline: none;
}
.feature-beacons__card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.feature-beacons__card-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.feature-beacons__card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
.feature-beacons__card-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.feature-beacons__card-kicker {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
}
.feature-beacons__card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
}
.feature-beacons__card-body {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text);
}
.feature-beacons__card-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.feature-beacons__got-it {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
}
.feature-beacons__got-it:hover,
.feature-beacons__got-it:focus-visible {
  filter: brightness(1.08);
}
.feature-beacons__got-it:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
