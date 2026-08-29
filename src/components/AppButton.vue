<script setup lang="ts">
// Our house button: a thin wrapper around services-ui's PrimaryButton that
// carries Stormbox-specific styling (bold label, compact 34px height by
// default). Colours come from the services-ui palette with our dark-mode
// token overrides in assets/styles.css. Use `size="default"` where the
// services-ui default height (2.875rem) is wanted, e.g. the login card.
// `variant="outline"` is the house secondary button (Cancel/Discard);
// `formAction="submit"` renders a native type="submit" for use in forms.
import { PrimaryButton } from '@thunderbirdops/services-ui';

withDefaults(
  defineProps<{
    size?: 'compact' | 'default';
    variant?: 'filled' | 'outline';
    formAction?: 'none' | 'submit' | 'reset';
    disabled?: boolean;
  }>(),
  { size: 'compact', variant: 'filled', formAction: 'none', disabled: false },
);
</script>

<template>
  <PrimaryButton
    class="app-button"
    :class="{ 'app-button--compact': size === 'compact' }"
    :variant="variant"
    :form-action="formAction"
    :disabled="disabled"
  >
    <template v-if="$slots.iconLeft" #iconLeft>
      <slot name="iconLeft" />
    </template>
    <template v-if="$slots.iconRight" #iconRight>
      <slot name="iconRight" />
    </template>
    <slot />
  </PrimaryButton>
</template>

<style scoped>
/* Both selectors are doubled up with .base (services-ui's own class) so we
   outrank its scoped .base[data-v] rules regardless of stylesheet order. */
.base.app-button {
  align-items: center;
  border-radius: 3px;
  gap: 6px;
}
.base.app-button :deep(.text) {
  font-weight: 600;
}
.base.app-button :deep(.icon) {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transform: none;
}
.base.app-button :deep(.icon > svg) {
  display: block;
  transform: none;
}
.base.app-button--compact {
  height: 34px;
}
</style>
