<script setup>
const props = defineProps({
  active: { type: String, default: 'mail' },
  unreadCount: { type: Number, default: 0 },
});
const emit = defineEmits(['change']);

function pick(name) {
  emit('change', name);
}
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
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm2 0v.4l6 4.2 6-4.2V6H6Zm12 2.7-5.5 3.85a1 1 0 0 1-1 0L6 8.7V18h12V8.7Z" fill="currentColor" />
      </svg>
      <span v-if="props.unreadCount > 0" class="app-spaces__badge" aria-hidden="true">{{ props.unreadCount > 99 ? '99+' : props.unreadCount }}</span>
    </button>
    <button
      class="app-spaces__item"
      :class="{ 'is-active': props.active === 'contacts' }"
      @click="pick('contacts')"
      aria-label="Contacts"
      title="Contacts"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.5 0-7 1.8-7 5v1h14v-1c0-3.2-3.5-5-7-5Z" fill="currentColor" />
      </svg>
    </button>
  </nav>
</template>

<style scoped>
.app-spaces {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 0;
  background: var(--space-rail-bg, #2a3552);
  color: var(--space-rail-fg, #cfd6e8);
  width: 56px;
  flex-shrink: 0;
  height: 100%;
  border-right: 1px solid rgba(0, 0, 0, 0.15);
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
  transition: background 0.12s ease;
}
.app-spaces__item:hover { background: rgba(255, 255, 255, 0.08); }
.app-spaces__item.is-active {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.app-spaces__badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #c93838;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: grid;
  place-items: center;
}
</style>
