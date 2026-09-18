<script setup lang="ts">
/**
 * The tag manager: its own modal, reached from the sidebar's Tags heading
 * and from every tag menu's "Manage tags…" (specs/011 MK-6.7). Same
 * chrome and dismissal as the Settings dialog — scrim click, Escape, the
 * close button — with focus landing in the new-tag name field, since
 * adding a tag is the usual reason to open it.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from '@lucide/vue';

import { useModalFocus } from '../../composables/useModalFocus';
import { isComposingKeyEvent } from '../../utils/keyboard';
import TagDefinitionsEditor from './TagDefinitionsEditor.vue';

const emit = defineEmits<{
  close: [];
}>();

const TITLE_ID = 'tag-manager-title';

const dialogEl = ref<HTMLElement | null>(null);
const initialFocus = ref<HTMLElement | null>(null);

useModalFocus(dialogEl, { containTab: true, initialFocus });

function onWindowKeydown(event: KeyboardEvent) {
  if (isComposingKeyEvent(event)) return;
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown);
  initialFocus.value = dialogEl.value?.querySelector<HTMLElement>('[data-tag-editor-name]') ?? null;
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div class="tag-manager" role="presentation" @click.self="emit('close')">
      <section
        ref="dialogEl"
        class="tag-manager__panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="TITLE_ID"
        tabindex="-1"
        data-tag-manager
      >
        <header class="tag-manager__header">
          <h2 :id="TITLE_ID">Tags</h2>
          <button
            type="button"
            class="tag-manager__close"
            aria-label="Close tags"
            @click="emit('close')"
          >
            <X :size="18" :stroke-width="2" aria-hidden="true" />
          </button>
        </header>
        <TagDefinitionsEditor :labelled-by="TITLE_ID" />
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* Chrome mirrors .settings-dialog so the two modals read as one family. */
.tag-manager {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--modal-scrim);
  backdrop-filter: var(--modal-scrim-blur);
}
.tag-manager__panel {
  width: min(520px, 100%);
  max-height: calc(100vh - 32px);
  overflow: auto;
  border: 1px solid var(--modal-border);
  border-radius: 16px;
  background: var(--modal-surface);
  color: var(--text);
  box-shadow: var(--modal-shadow);
}
.tag-manager__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}
.tag-manager__header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.tag-manager__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.tag-manager__close:hover,
.tag-manager__close:focus-visible {
  background: var(--rowHover);
  border-color: var(--border);
  color: var(--text);
  outline: none;
}
</style>
