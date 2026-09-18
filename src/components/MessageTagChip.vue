<script setup lang="ts">
import { computed } from 'vue';
import { X } from '@lucide/vue';

import type { ResolvedTag } from '../utils/message-tags';

/**
 * One tag on a message: a color dot and the tag's name (MK-6.5). A tag
 * with a definition wears its color; an undefined keyword is neutral.
 * `removable` adds a remove control. Narrow list rows hide the name
 * through the owner's stylesheet.
 */
const props = withDefaults(defineProps<{
  tag: ResolvedTag;
  removable?: boolean;
}>(), {
  removable: false,
});

const emit = defineEmits<{
  remove: [tag: ResolvedTag];
}>();

const style = computed(() => (
  props.tag.color ? { '--tag-color': props.tag.color } : undefined
));
const title = computed(() => (
  props.tag.defined ? props.tag.name : `${props.tag.name} (keyword without a tag definition)`
));
</script>

<template>
  <span
    class="tag-chip"
    :class="{
      'tag-chip--undefined': !tag.defined,
      'tag-chip--removable': removable,
    }"
    :style="style"
    :data-tag-keyword="tag.keyword"
  >
    <span class="tag-chip__body" :title="title">
      <span class="tag-chip__dot" aria-hidden="true" />
      <span class="tag-chip__name">{{ tag.name }}</span>
    </span>
    <button
      v-if="removable"
      class="tag-chip__remove"
      type="button"
      :title="`Remove tag ${tag.name}`"
      :aria-label="`Remove tag ${tag.name}`"
      @click.stop="emit('remove', tag)"
    >
      <X :size="11" :stroke-width="2.25" aria-hidden="true" />
    </button>
  </span>
</template>

<style scoped>
.tag-chip {
  --tag-color: var(--muted, #6b7388);
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-width: 0;
  height: 18px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--tag-color) 45%, transparent);
  background: color-mix(in srgb, var(--tag-color) 14%, transparent);
  color: var(--text);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  vertical-align: middle;
}
.tag-chip--undefined {
  border-style: dashed;
}
.tag-chip__body {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 100%;
  padding: 0 7px 0 6px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
}
.tag-chip__dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tag-color);
}
.tag-chip__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag-chip--removable .tag-chip__body {
  padding-inline-end: 3px;
}
.tag-chip__remove {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  margin-inline-end: 1px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.tag-chip__remove:hover {
  background: color-mix(in srgb, var(--text) 12%, transparent);
  color: var(--text);
}
.tag-chip__remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 0;
}
</style>
