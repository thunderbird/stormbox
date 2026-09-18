<script setup lang="ts">
import {
  computed, nextTick, onBeforeUnmount, ref, watch,
} from 'vue';

import type { MessageRowLike } from '../utils/message-row-presentation';
import type { MessageTagDefinition } from '../utils/message-tags';
import TagPickerPanel from './TagPickerPanel.vue';

export interface PopoverAnchor {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The tag menu anchored to a point that cannot host a <details>: a
 * button on a virtualized row, the header's More menu, the open
 * message's Tags row. Teleported to <body> and fixed-positioned so no
 * scroll container clips it. Same panel and the same dismissal contract
 * as AppDropdown: a pointer down outside (the trigger excepted, so it
 * can toggle), Escape, Tab, and any scroll or resize close it; focus goes
 * to the first item on open and back to the element that had it on
 * close. It opens below the anchor when its full height fits there, else
 * above; when neither side fits it takes the roomier one and scrolls.
 */
const props = withDefaults(defineProps<{
  /** Viewport rectangle to anchor to; null hides the popover. */
  anchor: PopoverAnchor | null;
  targets: ReadonlyArray<MessageRowLike | null | undefined>;
  definitions: ReadonlyArray<MessageTagDefinition>;
  label?: string;
  /** Element that opened the popover; a pointer down on it does not dismiss. */
  trigger?: HTMLElement | null;
  /** Element to focus on close; the trigger, or the active element at open time, when omitted. */
  returnFocus?: HTMLElement | null;
  /** Which edge of the anchor the panel shares: `end` for controls at a row's end, `start` for one at the left. */
  align?: 'start' | 'end';
}>(), {
  label: 'Tags',
  trigger: null,
  returnFocus: null,
  align: 'end',
});

const emit = defineEmits<{
  close: [];
  toggle: [keyword: string, on: boolean];
  clear: [];
  manage: [];
}>();

const PANEL_WIDTH = 260;
const ANCHOR_GAP = 6;
const VIEWPORT_MARGIN = 8;

const panelRoot = ref<HTMLElement | null>(null);
const panelEl = ref<InstanceType<typeof TagPickerPanel> | null>(null);
/** The popover's uncapped height, measured after each render; 0 until then. */
const naturalHeight = ref(0);

function measure() {
  const root = panelRoot.value;
  const list = root?.querySelector<HTMLElement>('.tag-picker');
  if (!root || !list) return;
  const chrome = root.offsetHeight - list.clientHeight;
  naturalHeight.value = list.scrollHeight + chrome;
}
/** Where focus returns on close, captured at open so a props reset cannot lose it. */
let focusReturn: HTMLElement | null = null;

const style = computed(() => {
  const anchor = props.anchor;
  if (!anchor) return undefined;
  const viewportWidth = globalThis.innerWidth ?? 0;
  const viewportHeight = globalThis.innerHeight ?? 0;
  // Shares the anchor's chosen edge; slides to stay inside the viewport.
  let left = props.align === 'start' ? anchor.left : anchor.left + anchor.width - PANEL_WIDTH;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - PANEL_WIDTH - VIEWPORT_MARGIN));
  const below = anchor.top + anchor.height + ANCHOR_GAP;
  const roomBelow = viewportHeight - VIEWPORT_MARGIN - below;
  const roomAbove = anchor.top - ANCHOR_GAP - VIEWPORT_MARGIN;
  const height = naturalHeight.value;
  let top = below;
  let maxHeight = roomBelow;
  if (viewportHeight && height > roomBelow) {
    if (height <= roomAbove || roomAbove > roomBelow) {
      maxHeight = roomAbove;
      top = anchor.top - ANCHOR_GAP - Math.min(height, roomAbove);
    }
  }
  return {
    position: 'fixed' as const,
    top: `${Math.max(VIEWPORT_MARGIN, top)}px`,
    left: `${left}px`,
    width: `${PANEL_WIDTH}px`,
    maxHeight: viewportHeight ? `${Math.max(0, maxHeight)}px` : undefined,
  };
});

function onOutsidePointerDown(event: Event) {
  const root = panelRoot.value;
  if (!root) return;
  if (!(event.target instanceof Node)) return;
  if (root.contains(event.target)) return;
  if (props.trigger?.contains(event.target)) return;
  emit('close');
}

function onEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  emit('close');
}

/** Tab leaves the popover: it closes and focus resumes where it was. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  emit('close');
}

function onViewportChange(event: Event) {
  // Scrolling inside the panel is not the anchor moving.
  if (event.target instanceof Node && panelRoot.value?.contains(event.target)) return;
  emit('close');
}

function listen() {
  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  document.addEventListener('keydown', onEscape, true);
  document.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
}

function unlisten() {
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('keydown', onEscape, true);
  document.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
}

watch(() => props.anchor, (anchor, previous) => {
  if (anchor && !previous) {
    const active = document.activeElement;
    focusReturn = props.returnFocus
      ?? props.trigger
      ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    // Listeners attach after the first item has focus so the focus
    // itself cannot count as a scroll or an outside pointer.
    void nextTick(() => {
      measure();
      panelEl.value?.focusFirst();
      if (props.anchor) listen();
    });
  } else if (!anchor && previous) {
    unlisten();
    naturalHeight.value = 0;
    const target = focusReturn;
    focusReturn = null;
    if (target?.isConnected) target.focus();
  }
});

// Rows come and go as tags are toggled; re-place the popover to fit.
watch(() => [props.targets, props.definitions], () => {
  if (props.anchor) void nextTick(measure);
});

onBeforeUnmount(unlisten);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="anchor"
      ref="panelRoot"
      class="app-dropdown__menu tag-picker-popover"
      :style="style"
      role="dialog"
      :aria-label="label"
      data-tag-picker-popover
      @keydown="onKeydown"
    >
      <TagPickerPanel
        ref="panelEl"
        :targets="targets"
        :definitions="definitions"
        :label="label"
        @toggle="(keyword, on) => emit('toggle', keyword, on)"
        @clear="emit('clear')"
        @manage="emit('manage')"
        @close="emit('close')"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.tag-picker-popover {
  z-index: 40;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tag-picker-popover > :deep(.tag-picker) {
  min-height: 0;
}
</style>
