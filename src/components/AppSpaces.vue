<script setup lang="ts">
import { computed } from 'vue';
import { Mail, Users } from '@lucide/vue';
import AppToggleButton from './AppToggleButton.vue';

const props = defineProps({
  active: { type: String, default: 'mail' },
  unreadCount: { type: Number, default: 0 },
  folderListHidden: { type: Boolean, default: false },
  showFolderListToggle: { type: Boolean, default: true },
});
const emit = defineEmits(['change', 'toggle-folder-list']);
const folderListToggleLabel = computed(() =>
  props.folderListHidden ? 'Show folder list' : 'Hide folder list',
);

function pick(name) { emit('change', name); }
</script>

<template>
  <nav class="app-spaces" aria-label="Spaces">
    <AppToggleButton
      class="app-spaces__item"
      :active="props.active === 'mail'"
      @click="pick('mail')"
      aria-label="Mail"
      title="Mail"
    >
      <Mail :size="20" :stroke-width="1.75" />
      <span v-if="props.unreadCount > 0" class="app-spaces__badge" aria-hidden="true">
        {{ props.unreadCount > 9999 ? '9999+' : props.unreadCount }}
      </span>
    </AppToggleButton>
    <AppToggleButton
      class="app-spaces__item"
      :active="props.active === 'contacts'"
      @click="pick('contacts')"
      aria-label="Contacts"
      title="Contacts"
    >
      <Users :size="20" :stroke-width="1.75" />
    </AppToggleButton>
    <div v-if="props.showFolderListToggle" class="app-spaces__bottom-actions">
      <AppToggleButton
        class="app-spaces__item"
        :active="!props.folderListHidden"
        :aria-label="folderListToggleLabel"
        :title="folderListToggleLabel"
        @click="emit('toggle-folder-list')"
      >
        <span
          class="app-spaces__folder-toggle-icon"
          :class="{ 'is-hidden': props.folderListHidden }"
          aria-hidden="true"
        >
          <span />
        </span>
      </AppToggleButton>
    </div>
  </nav>
</template>

<style scoped>
.app-spaces {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 0 max(14px, env(safe-area-inset-bottom));
  background: var(--space-rail-bg, var(--panel2));
  color: var(--muted);
  width: 56px;
  flex-shrink: 0;
  height: 100%;
  border-right: 1px solid var(--border);
}
/* Sizing, hover, and the active gradient all live in AppToggleButton. */
.app-spaces__bottom-actions {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.app-spaces__folder-toggle-icon {
  position: relative;
  width: 20px;
  height: 16px;
  display: block;
  border: 1.5px solid currentColor;
  border-radius: 3px;
}
.app-spaces__folder-toggle-icon::before {
  content: "";
  position: absolute;
  inset-block: 0;
  left: 6px;
  width: 1.5px;
  background: currentColor;
}
.app-spaces__folder-toggle-icon::after,
.app-spaces__folder-toggle-icon span {
  content: "";
  position: absolute;
  left: 9px;
  right: 3px;
  height: 1.5px;
  background: currentColor;
  border-radius: 999px;
}
.app-spaces__folder-toggle-icon::after { top: 5px; }
.app-spaces__folder-toggle-icon span { top: 9px; }
.app-spaces__folder-toggle-icon.is-hidden::before,
.app-spaces__folder-toggle-icon.is-hidden::after,
.app-spaces__folder-toggle-icon.is-hidden span {
  opacity: 0.38;
}
.app-spaces__badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #c93838;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  letter-spacing: -0.2px;
  text-align: center;
  pointer-events: none;
}

@media (max-width: 639px) {
  .app-spaces {
    position: relative;
    flex-direction: row;
    justify-content: center;
    gap: 8px;
    width: 100%;
    height: var(--spaces-bar-height, 56px);
    padding:
      8px max(56px, env(safe-area-inset-right))
      calc(8px + env(safe-area-inset-bottom))
      max(56px, env(safe-area-inset-left));
    border-right: 0;
    border-top: 1px solid var(--border);
  }
  .app-spaces__bottom-actions {
    position: absolute;
    top: 8px;
    left: max(8px, env(safe-area-inset-left));
    margin-top: 0;
    flex-direction: row;
  }
}
</style>
