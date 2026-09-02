<script setup lang="ts">
/**
 * One positioned message-list row. Owns the row's markup and styling so
 * every list surface (folder list, kanban columns) renders the same row;
 * selection, focus and drag state come in as props and every interaction
 * is emitted back to the owner.
 */
import { computed } from 'vue';
import { Paperclip, Star } from '@lucide/vue';

import type { JmapViewSort } from '../constants/states';
import { useSenderAvatars } from '../composables/useSenderAvatars';
import {
  correspondentLabel,
  fmtDate,
  rowCorrespondent,
  rowTimestamp,
  type MessageRowLike,
} from '../utils/message-row-presentation';

const props = withDefaults(defineProps<{
  message: MessageRowLike & { id: number };
  index: number;
  start: number;
  size: number;
  focused?: boolean;
  selected?: boolean;
  dragging?: boolean;
  showsRecipients?: boolean;
  sort?: JmapViewSort;
  /** False on surfaces without multi-select: no checkbox is rendered. */
  selectable?: boolean;
}>(), {
  focused: false,
  selected: false,
  dragging: false,
  showsRecipients: false,
  sort: 'received',
  selectable: true,
});

const emit = defineEmits<{
  (e: 'row-click', event: MouseEvent): void;
  (e: 'checkbox-click', event: MouseEvent): void;
  (e: 'dragstart', event: DragEvent): void;
  (e: 'dragend', event: DragEvent): void;
}>();

const { senderAvatar, onAvatarError } = useSenderAvatars();

const isUnread = computed(() => Number(props.message.is_seen) === 0);
const correspondent = computed(() => rowCorrespondent(props.message, props.showsRecipients));
const avatar = computed(() => senderAvatar(correspondent.value));
const label = computed(() => correspondentLabel(props.message, props.showsRecipients));
const dateText = computed(() => fmtDate(rowTimestamp(props.message, props.sort)));
</script>

<template>
  <li
    :id="`msg-row-${message.id}`"
    :data-index="index"
    role="option"
    :aria-selected="selected"
    :class="{
      'is-focused': focused,
      'is-selected': selected,
      'is-dragging': dragging,
      'is-unread': isUnread,
      'is-unselectable': !selectable,
    }"
    :style="{
      position: 'absolute',
      top: '0px',
      left: '0px',
      right: '0px',
      transform: `translateY(${start}px)`,
      height: size + 'px',
    }"
  >
    <div
      class="msg-list__item"
      tabindex="-1"
      :draggable="message.scheduled_undo_status == null"
      @click="emit('row-click', $event)"
      @dragstart="emit('dragstart', $event)"
      @dragend="emit('dragend', $event)"
    >
      <div class="msg-list__state">
        <label v-if="selectable" class="msg-list__check" draggable="false" @click.stop>
          <input
            type="checkbox"
            :checked="selected"
            @click="emit('checkbox-click', $event)"
          />
        </label>
        <span
          v-if="isUnread"
          class="msg-list__unread-dot"
          aria-label="Unread"
        />
      </div>
      <div
        class="msg-list__avatar"
        :style="avatar.style"
        aria-hidden="true"
      >
        <img
          v-if="avatar.imageUrl"
          class="msg-list__avatar-image"
          :src="avatar.imageUrl"
          alt=""
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          @error="onAvatarError(correspondent)"
        />
        <span>{{ avatar.initials }}</span>
      </div>
      <div class="msg-list__content">
        <div class="msg-list__summary">
          <span class="msg-list__from">{{ label }}</span>
          <span class="msg-list__subject">{{ message.subject || '(no subject)' }}</span>
          <span class="msg-list__icons">
            <Star v-if="Number(message.is_flagged) === 1" :size="13" :stroke-width="2" class="msg-list__star" />
            <Paperclip v-if="Number(message.has_attachment) === 1" :size="13" :stroke-width="1.75" class="msg-list__attach" />
          </span>
          <span class="msg-list__date">{{ dateText }}</span>
        </div>
        <p v-if="message.preview" class="msg-list__preview">
          {{ message.preview }}
        </p>
      </div>
    </div>
  </li>
</template>

<style scoped>
/* Fastmail model: the focused row (currently being viewed) gets the
 * solid accent background. Selection state is communicated by the
 * checkbox itself; we tint the row very softly so the user can scan
 * a column of selected rows without it competing with the "what
 * am I reading" highlight. */
.msg-list__items li.is-focused .msg-list__item { background: var(--rowActive); }
.msg-list__items li.is-selected .msg-list__item {
  background: color-mix(in srgb, var(--accent) 6%, var(--panel));
}
.msg-list__items li.is-selected.is-focused .msg-list__item {
  background: var(--rowActive);
}
.msg-list__items li.is-dragging .msg-list__item {
  opacity: 0.55;
}
.msg-list__items li.is-unread .msg-list__from,
.msg-list__items li.is-unread .msg-list__subject {
  font-weight: 600;
  color: var(--text);
}

.msg-list__item {
  position: relative;
  display: grid;
  grid-template-columns: 34px 34px minmax(0, 1fr);
  align-items: center;
  column-gap: 10px;
  width: 100%;
  height: 100%;
  text-align: left;
  padding: 7px 14px 7px 12px;
  border: 0;
  background: transparent;
  cursor: pointer;
  border-bottom: 1px solid var(--border-soft);
  font: inherit;
  color: inherit;
  transition: background 0.06s ease;
  /* Stops Shift-click from accidentally selecting subject text as
   * the user extends a range — the native text-selection range
   * appears on top of the row highlight and is very ugly. */
  user-select: none;
  -webkit-user-select: none;
}
.msg-list__item:hover { background: var(--rowHover); }
.msg-list__content {
  min-width: 0;
}

.msg-list__state {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
}
.msg-list__check {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.08s ease;
}
.msg-list__check input {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent);
}

.msg-list__unread-dot {
  display: block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  transition: opacity 0.08s ease;
  /* Pure visual indicator: never intercept clicks meant for the
   * underlying checkbox (which has inset: 0 within .msg-list__state). */
  pointer-events: none;
}
.msg-list__item:hover .msg-list__check,
.msg-list__items li.is-selected .msg-list__check {
  opacity: 1;
}
.msg-list__item:hover .msg-list__unread-dot,
.msg-list__items li.is-selected .msg-list__unread-dot {
  opacity: 0;
}
/* Without a checkbox there is nothing for the dot to make room for. */
.msg-list__items li.is-unselectable .msg-list__item:hover .msg-list__unread-dot {
  opacity: 1;
}
.msg-list__avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  overflow: hidden;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 22%, transparent);
}
.msg-list__avatar-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.msg-list__summary {
  display: grid;
  grid-template-columns: clamp(86px, 28%, 200px) minmax(0, 1fr) auto auto;
  grid-template-areas: "from subject icons date";
  align-items: baseline;
  column-gap: 8px;
}
.msg-list__from {
  grid-area: from;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__date {
  grid-area: date;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.msg-list__subject {
  grid-area: subject;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__icons {
  grid-area: icons;
  display: inline-flex;
  gap: 4px;
  color: var(--muted);
  min-width: 0;
}
.msg-list__star { color: #f5b700; }
.msg-list__preview {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  line-height: 1.35;
}

.msg-list--card .msg-list__item {
  grid-template-columns: 24px 34px minmax(0, 1fr);
  align-items: start;
  column-gap: 9px;
  padding: 10px 12px;
}
.msg-list--card .msg-list__state {
  width: 24px;
}
.msg-list--card .msg-list__summary {
  grid-template-columns: minmax(0, 1fr) auto auto;
  grid-template-areas:
    "from icons date"
    "subject subject subject";
  row-gap: 2px;
}
.msg-list--card .msg-list__from,
.msg-list--card .msg-list__subject {
  font-size: 13px;
}
.msg-list--card .msg-list__subject {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
}
.msg-list--card .msg-list__preview {
  margin-top: 3px;
  -webkit-line-clamp: 1;
}

@media (max-width: 639px) {
  .msg-list__check {
    opacity: 1;
  }
  .msg-list__unread-dot {
    opacity: 0;
  }
}
</style>
