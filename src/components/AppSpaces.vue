<script setup lang="ts">
import { computed } from 'vue';
import { Mail, Moon, Sun, Users } from 'lucide-vue-next';

const props = defineProps({
  active: { type: String, default: 'mail' },
  unreadCount: { type: Number, default: 0 },
  folderListHidden: { type: Boolean, default: false },
  theme: { type: String, default: 'dark' },
});
const emit = defineEmits(['change', 'toggle-folder-list', 'toggle-theme']);
const folderListToggleLabel = computed(() =>
  props.folderListHidden ? 'Show folder list' : 'Hide folder list',
);
const themeToggleLabel = computed(() =>
  props.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
);

function pick(name) { emit('change', name); }
</script>

<template>
  <nav class="app-spaces" aria-label="Spaces">
    <button
      class="app-spaces__item"
      :class="{ 'is-active': props.active === 'mail' }"
      @click="pick('mail')"
      aria-label="Mail"
      title="Mail"
    >
      <Mail :size="20" :stroke-width="1.75" />
      <span v-if="props.unreadCount > 0" class="app-spaces__badge" aria-hidden="true">
        {{ props.unreadCount > 99 ? '99+' : props.unreadCount }}
      </span>
    </button>
    <button
      class="app-spaces__item"
      :class="{ 'is-active': props.active === 'contacts' }"
      @click="pick('contacts')"
      aria-label="Contacts"
      title="Contacts"
    >
      <Users :size="20" :stroke-width="1.75" />
    </button>
    <div class="app-spaces__bottom-actions">
      <button
        class="app-spaces__item"
        type="button"
        :aria-label="themeToggleLabel"
        :title="themeToggleLabel"
        @click="emit('toggle-theme')"
      >
        <Sun v-if="props.theme === 'dark'" :size="19" :stroke-width="1.75" />
        <Moon v-else :size="19" :stroke-width="1.75" />
      </button>
      <button
        class="app-spaces__item"
        :class="{ 'is-active': !props.folderListHidden }"
        type="button"
        :aria-label="folderListToggleLabel"
        :title="folderListToggleLabel"
        :aria-pressed="!props.folderListHidden"
        @click="emit('toggle-folder-list')"
      >
        <span
          class="app-spaces__folder-toggle-icon"
          :class="{ 'is-hidden': props.folderListHidden }"
          aria-hidden="true"
        >
          <span />
        </span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.app-spaces {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 0;
  background: var(--panel2);
  color: var(--muted);
  width: 56px;
  flex-shrink: 0;
  height: 100%;
  border-right: 1px solid var(--border);
}
.app-spaces__item {
  position: relative;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.app-spaces__item:hover { background: var(--rowHover); color: var(--text); }
.app-spaces__item.is-active {
  background: var(--accent);
  color: #fff;
}
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
</style>
