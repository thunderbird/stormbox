<script setup lang="ts">
/**
 * One row of the sidebar's Tags section (MK-3.4): a color dot, the tag's
 * name and how many cached messages carry it. Picking it opens the tag
 * view; dropping messages on it adds the tag to them.
 */
import { computed } from 'vue';
import { Star } from '@lucide/vue';

const props = withDefaults(defineProps<{
  keyword: string;
  name: string;
  /** null for the account-wide Starred view, which shows a star instead of a dot. */
  color: string | null;
  count: number;
  current?: boolean;
  /** Drop feedback while a message drag hovers the row. */
  dropState?: 'tag' | null;
}>(), {
  current: false,
  dropState: null,
});

const emit = defineEmits<{
  pick: [keyword: string];
  dragenter: [keyword: string, event: DragEvent];
  dragover: [keyword: string, event: DragEvent];
  dragleave: [keyword: string, event: DragEvent];
  drop: [keyword: string, event: DragEvent];
}>();

const style = computed(() => (
  props.color ? { '--tag-color': props.color } : undefined
));
</script>

<template>
  <div
    class="tag-view-node"
    :class="{ 'is-current': current, 'is-drop-valid': dropState === 'tag' }"
    :style="style"
    :data-tag-view="keyword"
    @dragenter="emit('dragenter', keyword, $event)"
    @dragover="emit('dragover', keyword, $event)"
    @dragleave="emit('dragleave', keyword, $event)"
    @drop="emit('drop', keyword, $event)"
  >
    <button
      type="button"
      class="tag-view-node__button"
      :aria-current="current ? 'page' : undefined"
      @click="emit('pick', keyword)"
    >
      <span class="tag-view-node__icon-wrap" aria-hidden="true">
        <Star v-if="color === null" class="tag-view-node__star" :size="14" :stroke-width="2" />
        <span v-else class="tag-view-node__dot" />
      </span>
      <span class="tag-view-node__name">{{ name }}</span>
      <span v-if="count > 0" class="tag-view-node__count">{{ count > 99999 ? '99999+' : count }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Same row chrome as FolderNode, with a dot for the folder icon. */
.tag-view-node {
  --tag-color: var(--muted);
  display: flex;
  align-items: center;
  padding: 0 10px 0 28px;
  border-radius: 8px;
}
.tag-view-node:hover { background: var(--rowHover); }
.tag-view-node.is-current { background: var(--rowActive); }
.tag-view-node.is-drop-valid {
  background: color-mix(in srgb, var(--tag-color) 16%, var(--panel));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tag-color) 60%, transparent);
}
.tag-view-node__button {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  appearance: none;
}
.tag-view-node__button:focus-visible {
  box-shadow: 0 0 0 2px var(--accent);
  border-radius: 6px;
  outline: 0;
}
.tag-view-node.is-current .tag-view-node__button { font-weight: 500; }
.tag-view-node__icon-wrap {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
}
.tag-view-node__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--tag-color);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 15%, transparent);
}
.tag-view-node__star {
  color: #f9ab00;
  fill: currentColor;
}
.tag-view-node__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.tag-view-node__count {
  margin-left: auto;
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.tag-view-node.is-current .tag-view-node__count {
  color: var(--accent);
  font-weight: 600;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
</style>
