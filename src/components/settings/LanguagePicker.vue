<script setup lang="ts">
import { computed, ref } from 'vue';
import { availableLocales, localePreference, setLocalePreference } from '../../i18n';
import { t } from '../../i18n/messages';
import { useMenuKeyboard } from '../../composables/useMenuKeyboard';
import { closeContainingDropdown } from '../../utils/dropdown';
import AppDropdown from '../AppDropdown.vue';

const options = computed(() => [
  { value: 'auto', label: t('common.followBrowserLanguage') },
  ...availableLocales.map((value) => ({
    value,
    label: new Intl.DisplayNames([value], { type: 'language' }).of(value) ?? value,
  })),
]);
const selectedLabel = computed(() => options.value.find((item) => item.value === localePreference.value)?.label
  ?? t('common.followBrowserLanguage'));
const menuEl = ref<HTMLElement | null>(null);
const { onToggle, onKeydown } = useMenuKeyboard({
  menuEl,
  itemSelector: '[role="menuitemradio"]',
  initialItem: (items) => items.find((item) => item.getAttribute('aria-checked') === 'true'),
});
function pick(value: string, event: Event): void {
  setLocalePreference(value);
  closeContainingDropdown(event);
}
</script>

<template>
  <AppDropdown class="language-picker" @toggle="onToggle">
    <summary class="app-dropdown__summary settings-dialog__btn" aria-labelledby="settings-language-label settings-language-value">
      <span id="settings-language-value">{{ selectedLabel }}</span>
    </summary>
    <div ref="menuEl" class="app-dropdown__menu" role="menu" aria-labelledby="settings-language-label" @keydown="onKeydown">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="menuitemradio"
        class="app-dropdown__item"
        :lang="option.value === 'auto' ? undefined : option.value"
        :aria-checked="localePreference === option.value"
        @click="pick(option.value, $event)"
      >{{ option.label }}</button>
    </div>
  </AppDropdown>
</template>
