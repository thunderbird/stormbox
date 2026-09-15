<script setup lang="ts">
import {
  computed, nextTick, onMounted, ref,
} from 'vue';

import { useColumnResize } from '../composables/useColumnResize';
import { useMailStore } from '../stores/mail-store';
import {
  MESSAGE_COLUMN_MAX_WIDTH,
  MESSAGE_COLUMN_MIN_WIDTH,
  MESSAGE_COLUMN_RESIZER_WIDTH,
  PRIMARY_COLUMN_ID,
  type MessageColumn,
  useMessageColumnsStore,
} from '../stores/message-columns-store';
import MessageList from './MessageList.vue';

/**
 * The message list columns area: one `MessageList` per configured
 * column with a resize handle after each, scrolling horizontally when
 * the columns outgrow the space the shell grants. Owns adding and
 * removing columns and the focus hand-off those imply.
 */
const props = withDefaults(defineProps<{
  quickFilterQuery?: string;
  /** Whether the reading pane sits beside the columns; the last handle resizes against it. */
  readingPaneVisible?: boolean;
}>(), {
  quickFilterQuery: '',
  readingPaneVisible: false,
});

const columnsStore = useMessageColumnsStore();
const mailStore = useMailStore();

const columns = computed(() => columnsStore.columns);

type MessageListHandle = InstanceType<typeof MessageList>;
const listHandles = new Map<string, MessageListHandle>();

function setListHandle(id: string, handle: unknown) {
  if (handle) listHandles.set(id, handle as MessageListHandle);
  else listHandles.delete(id);
}

const {
  activeResizePane,
  onResizeHandleKeydown,
  startColumnResize,
} = useColumnResize<string>({
  panes: () => Object.fromEntries(columns.value.map((column) => [column.id, {
    get: () => column.width,
    max: () => MESSAGE_COLUMN_MAX_WIDTH,
    min: () => MESSAGE_COLUMN_MIN_WIDTH,
    set: (width: number) => columnsStore.setColumnWidth(column.id, width),
    storageKey: column.id,
  }])),
});

function showsResizerAfter(index: number): boolean {
  return index < columns.value.length - 1 || props.readingPaneVisible;
}

function columnStyle(column: MessageColumn) {
  return { '--message-column-width': `${column.width}px` };
}

async function addColumn() {
  const id = columnsStore.addColumn();
  if (!id) return;
  await nextTick();
  listHandles.get(id)?.focusFolderPicker();
}

async function removeColumn(id: string) {
  const index = columns.value.findIndex((column) => column.id === id);
  if (index <= 0) return;
  const previousFolderId = columns.value[index].folderId;
  columnsStore.removeColumn(id);
  await nextTick();
  // The folder's open message, cursor and checked rows go with the column
  // unless another column still shows it.
  mailStore.releaseFolderInteractions(previousFolderId);
  // Focus lands on the neighbour to the left: its remove control, or
  // the primary column's add control when the removed column was second.
  const neighbour = columns.value[Math.min(index - 1, columns.value.length - 1)];
  listHandles.get(neighbour.id)?.focusColumnControl();
}

async function changeFolder(id: string, folderId: number) {
  const previousFolderId = columns.value.find((column) => column.id === id)?.folderId ?? null;
  columnsStore.setColumnFolder(id, folderId);
  await nextTick();
  mailStore.releaseFolderInteractions(previousFolderId);
}

// In the single-column layout the area unmounts while a message is open;
// on return it scrolls back to the column the message was opened from.
const areaEl = ref<HTMLElement | null>(null);
function rememberActiveColumn(id: string) {
  columnsStore.lastActiveColumnId = id;
}
onMounted(async () => {
  const id = columnsStore.lastActiveColumnId;
  if (!id || !areaEl.value) return;
  await nextTick();
  const column = areaEl.value.querySelector<HTMLElement>(`[data-column-id="${id}"]`)
    ?? (id === PRIMARY_COLUMN_ID ? areaEl.value.querySelector<HTMLElement>('.msg-list--primary') : null);
  if (!column) return;
  areaEl.value.scrollLeft = column.offsetLeft - areaEl.value.offsetLeft;
});

defineExpose({ addColumn, removeColumn });
</script>

<template>
  <div
    ref="areaEl"
    class="msg-columns"
    :class="{ 'msg-columns--resizing': activeResizePane !== null }"
    :style="{
      '--message-column-resizer-width': `${MESSAGE_COLUMN_RESIZER_WIDTH}px`,
      '--message-column-min-width': `${MESSAGE_COLUMN_MIN_WIDTH}px`,
    }"
  >
    <template v-for="(column, index) in columns" :key="column.id">
      <MessageList
        :ref="(el) => setListHandle(column.id, el)"
        class="msg-columns__column"
        :class="{ 'msg-columns__column--last': index === columns.length - 1 }"
        :style="columnStyle(column)"
        :folder-id="column.folderId"
        :list-id="column.id"
        :column-index="index + 1"
        :primary="column.primary"
        :quick-filter-query="quickFilterQuery"
        :can-add-column="columnsStore.canAddColumn"
        @add-column="addColumn"
        @remove-column="removeColumn(column.id)"
        @change-folder="changeFolder(column.id, $event)"
        @open="rememberActiveColumn(column.id)"
      />
      <div
        v-if="showsResizerAfter(index)"
        class="column-resizer msg-columns__resizer"
        :class="{ 'is-active': activeResizePane === column.id }"
        role="separator"
        :aria-label="index === 0 && columns.length === 1 ? 'Resize message list' : `Resize column ${index + 1}`"
        aria-orientation="vertical"
        :aria-valuemin="MESSAGE_COLUMN_MIN_WIDTH"
        :aria-valuemax="MESSAGE_COLUMN_MAX_WIDTH"
        :aria-valuenow="column.width"
        tabindex="0"
        @pointerdown="startColumnResize(column.id, $event)"
        @keydown="onResizeHandleKeydown(column.id, $event)"
      />
    </template>
  </div>
</template>

<style scoped>
.msg-columns {
  display: flex;
  align-items: stretch;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}
/* A column asks for its stored width and gives way down to the minimum
   when the area is short of room; only past that does the area scroll.
   The handle after a column draws the divider, so the column's own
   right border would double it. */
.msg-columns > .msg-columns__column {
  flex: 0 1 var(--message-column-width, 360px);
  min-width: var(--message-column-min-width, 280px);
  height: 100%;
  border-right: 0;
}
/* The last column stretches so a lone column fills the area when the
   reading pane is hidden; every other column keeps its width. */
.msg-columns > .msg-columns__column--last {
  flex-grow: 1;
}
.msg-columns__resizer {
  flex: 0 0 var(--message-column-resizer-width, 6px);
}
/* One column fills the screen in the single-column layout (R-10.3); the
   user swipes between columns and the handles have no job there. */
@media (max-width: 639px) {
  /* Swipe/snap is the interaction here; the scrollbar would only take a
     row of height from the list. */
  .msg-columns {
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .msg-columns::-webkit-scrollbar {
    display: none;
  }
  .msg-columns > .msg-columns__column,
  .msg-columns > .msg-columns__column--last {
    flex: 0 0 100%;
    min-width: 0;
    scroll-snap-align: start;
  }
  .msg-columns__resizer {
    display: none;
  }
}
</style>
