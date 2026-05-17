<script setup>
import { Mail, Users } from 'lucide-vue-next';

const props = defineProps({
  active: { type: String, default: 'mail' },
  unreadCount: { type: Number, default: 0 },
});
const emit = defineEmits(['change']);
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
