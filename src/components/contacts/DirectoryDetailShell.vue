<script setup lang="ts">
import type {
  DirectoryLayout,
  DirectoryMobilePane,
} from './directory-types';

const props = defineProps<{
  detailVisible: boolean;
  layout: DirectoryLayout;
  mobilePane: DirectoryMobilePane;
}>();

function paneVisible(pane: DirectoryMobilePane): boolean {
  if (pane === 'detail' && !props.detailVisible) return false;
  return props.layout !== 'phone' || props.mobilePane === pane;
}
</script>

<template>
  <div
    class="directory-shell"
    :class="[
      `directory-shell--${layout}`,
      { 'directory-shell--detail-hidden': !detailVisible },
    ]"
    :data-layout="layout"
    :data-mobile-pane="mobilePane"
  >
    <div
      v-if="paneVisible('list')"
      class="directory-shell__list"
      data-directory-pane="list"
    >
      <slot name="list" />
    </div>
    <div
      v-if="layout !== 'phone' && detailVisible"
      class="directory-shell__separator"
    >
      <slot name="separator" />
    </div>
    <div
      v-if="paneVisible('detail')"
      class="directory-shell__detail"
      data-directory-pane="detail"
    >
      <slot name="detail" />
    </div>
  </div>
</template>

<style scoped>
.directory-shell {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns:
    minmax(
      var(--directory-list-min-width, 280px),
      var(--directory-list-width, 360px)
    )
    var(--directory-resizer-width, 6px)
    minmax(var(--directory-detail-min-width, 240px), 1fr);
  background: var(--surface, #fff);
}

.directory-shell__list,
.directory-shell__separator,
.directory-shell__detail {
  min-width: 0;
  min-height: 0;
}

.directory-shell__list {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.directory-shell__list :deep(> *) {
  flex: 1 1 auto;
  min-height: 0;
}

.directory-shell__detail {
  overflow: hidden;
}

.directory-shell--detail-hidden {
  grid-template-columns: minmax(0, 1fr);
}

.directory-shell--phone {
  grid-template-columns: minmax(0, 1fr);
}
</style>
