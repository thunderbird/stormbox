<script setup lang="ts">
import { computed } from 'vue';
import { Mail, MailOpen, Trash2 } from '@lucide/vue';

import archiveIcon from '../assets/icons/tb-folder-archive.svg?raw';
import junkIcon from '../assets/icons/tb-folder-spam.svg?raw';
import type { FolderRow } from '../types';

/**
 * The bulk-action buttons for a checkbox selection: archive, junk,
 * delete, mark read/unread, plus "Not junk" inside a Junk folder. Which
 * buttons show depends on the folder the selected rows live in (the
 * managed Scheduled mailbox allows only the read/unread pair). The owner
 * runs the actions; this component only renders the row of buttons.
 */
const props = withDefaults(defineProps<{
  folder: FolderRow | null | undefined;
  /** Whether "Not junk" applies (Junk folder of the primary account). */
  canWhitelist?: boolean;
  whitelisting?: boolean;
}>(), {
  canWhitelist: false,
  whitelisting: false,
});

const emit = defineEmits<{
  (e: 'archive'): void;
  (e: 'junk'): void;
  (e: 'delete'): void;
  (e: 'mark-read'): void;
  (e: 'mark-unread'): void;
  (e: 'whitelist'): void;
}>();

const isInJunkFolder = computed(() => props.folder?.role === 'junk');
const isInScheduledFolder = computed(() => Number(props.folder?.is_scheduled ?? 0) === 1);
</script>

<template>
  <button
    v-if="canWhitelist"
    class="msg-list__bulk-action msg-list__bulk-action--whitelist"
    type="button"
    :disabled="whitelisting"
    @click="emit('whitelist')"
    title="Whitelist senders and move to Inbox"
    aria-label="Not junk — whitelist senders and move the selected messages to Inbox"
  >
    Not junk
  </button>
  <button v-if="!isInScheduledFolder" class="msg-list__bulk-action" type="button" @click="emit('archive')" title="Archive" aria-label="Archive">
    <span class="msg-list__bulk-icon msg-list__bulk-icon--folder" aria-hidden="true" v-html="archiveIcon" />
  </button>
  <button v-if="!isInJunkFolder && !isInScheduledFolder" class="msg-list__bulk-action" type="button" @click="emit('junk')" title="Junk" aria-label="Mark as junk">
    <span class="msg-list__bulk-icon msg-list__bulk-icon--folder" aria-hidden="true" v-html="junkIcon" />
  </button>
  <button v-if="!isInScheduledFolder" class="msg-list__bulk-action msg-list__bulk-action--danger" type="button" @click="emit('delete')" title="Delete" aria-label="Delete">
    <Trash2 :size="18" :stroke-width="1.65" />
  </button>
  <button class="msg-list__bulk-action" type="button" @click="emit('mark-read')" title="Mark as read" aria-label="Mark as read">
    <MailOpen :size="16" :stroke-width="1.75" />
  </button>
  <button class="msg-list__bulk-action" type="button" @click="emit('mark-unread')" title="Mark as unread" aria-label="Mark as unread">
    <Mail :size="16" :stroke-width="1.75" />
  </button>
</template>

<style scoped>
.msg-list__bulk-action {
  display: inline-grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  flex-shrink: 0;
}
.msg-list__bulk-action:hover {
  background: var(--rowHover);
  color: var(--text);
}
.msg-list__bulk-action--danger:hover {
  background: rgba(255, 107, 107, 0.12);
  color: #ff6b6b;
}
/* "Not junk" is the contextual, Junk-only primary action; a filled
   accent button set apart from the icon buttons, matching the same
   action in the open-message toolbar. */
.msg-list__bulk-action--whitelist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: auto;
  padding: 0 12px;
  margin-inline-end: 6px;
  background: var(--accent);
  color: #fff;
  border: 1px solid color-mix(in srgb, var(--accent) 80%, #000);
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 16%, transparent);
  transition: filter 0.12s ease, box-shadow 0.12s ease;
}
.msg-list__bulk-action--whitelist:hover {
  background: var(--accent);
  color: #fff;
  filter: brightness(1.04);
  box-shadow: 0 2px 5px color-mix(in srgb, #000 18%, transparent);
}
.msg-list__bulk-action--whitelist:disabled,
.msg-list__bulk-action--whitelist:disabled:hover {
  opacity: 0.5;
  filter: none;
  background: var(--accent);
  color: #fff;
}
.msg-list__bulk-icon--folder {
  width: 20px;
  height: 20px;
  display: block;
}
.msg-list__bulk-icon--folder :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.msg-list__bulk-icon--folder :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.msg-list__bulk-icon--folder :deep([fill="context-stroke"]) {
  fill: currentColor;
}
</style>
