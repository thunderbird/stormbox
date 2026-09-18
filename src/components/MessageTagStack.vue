<script setup lang="ts">
/**
 * A message's tags as overlapping tag icons (MK-6.5), after Thunderbird's
 * cards-view `thread-card-tags`: at most three icons in the tags' colors,
 * each drawn over the one before it, then "+N" for the rest. With no tags
 * it draws the same icon hollow, for a control that adds the first.
 * Decorative: the owner names the tags in its own label.
 *
 * The glyph is Thunderbird's `icons/new/tag-sm.svg` (MPL 2.0). Colors
 * follow `threadCardTags.css`: the outline in the tag's color, the body
 * that color mixed half with white (light theme) or black (dark theme).
 */
import { computed } from 'vue';

import type { ResolvedTag } from '../utils/message-tags';

const MAX_ICONS = 3;

const props = defineProps<{
  tags: ReadonlyArray<ResolvedTag>;
}>();

const icons = computed(() => props.tags.slice(0, MAX_ICONS));
const extra = computed(() => props.tags.length - icons.value.length);

const BODY = 'M6 .496A.691.691 0 0 0 5.51.7L.699 5.51a.692.692 0 0 0 0 .981l4.81 4.811c.272.271.71.271.981 0l4.81-4.81c.23-.205.203-.491.2-.682V1.192A.69.69 0 0 0 10.808.5C9.553.501 7.237.501 6 .496Z';
const OUTLINE = 'M6-.004a1.2 1.2 0 0 0-.844.35l-4.81 4.81a1.202 1.202 0 0 0 0 1.688l4.81 4.81a1.202 1.202 0 0 0 1.688 0l4.789-4.79c.416-.372.37-.911.367-1.063V1.19A1.2 1.2 0 0 0 10.808 0 1272.319 1272.319 0 0 1 6-.005zm-.002 1H6c1.238.005 3.553.005 4.808.004.116 0 .192.076.192.192v4.624c.003.231.01.264-.032.301a.53.53 0 0 0-.021.02l-4.81 4.81c-.082.082-.21.097-.274 0l-4.81-4.81a.184.184 0 0 1 0-.274l4.81-4.81a.216.216 0 0 1 .135-.057zM9 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z';
</script>

<template>
  <span class="tag-stack" aria-hidden="true">
    <template v-if="icons.length > 0">
      <svg
        v-for="tag in icons"
        :key="tag.keyword"
        class="tag-stack__icon"
        :style="tag.color ? { '--tag-color': tag.color } : undefined"
        :data-tag-keyword="tag.keyword"
        viewBox="0 0 12 12"
        width="16"
        height="16"
      >
        <path class="tag-stack__body" :d="BODY" />
        <path class="tag-stack__outline" :d="OUTLINE" />
      </svg>
      <span v-if="extra > 0" class="tag-stack__more">+{{ extra }}</span>
    </template>
    <svg
      v-else
      class="tag-stack__icon tag-stack__icon--empty"
      viewBox="0 0 12 12"
      width="16"
      height="16"
    >
      <path class="tag-stack__body" :d="BODY" />
      <path class="tag-stack__outline" :d="OUTLINE" />
    </svg>
  </span>
</template>

<style scoped>
.tag-stack {
  --tag-stack-base: light-dark(white, black);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  line-height: 1;
}
:global(html.dark) .tag-stack {
  --tag-stack-base: black;
}
:global(html.light) .tag-stack {
  --tag-stack-base: white;
}
.tag-stack__icon {
  position: relative;
  flex: none;
  display: block;
}
/* Drawn at 16px rather than Thunderbird's 12px; the overlap scales with
   it, so with the 3px gap each icon sits 5px after the previous one. */
.tag-stack__icon + .tag-stack__icon {
  margin-inline-start: -14px;
}
.tag-stack__body {
  fill: color-mix(in srgb, var(--tag-stack-base) 50%, var(--tag-color, currentColor));
}
.tag-stack__icon--empty .tag-stack__body {
  fill: none;
}
.tag-stack__outline {
  fill: var(--tag-color, currentColor);
}
.tag-stack__more {
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
}
</style>
