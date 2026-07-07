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
  /* Squarer corners in the Thunderbird desktop style, rather than
     services-ui's rounder 0.5rem default. */
  border-radius: 3px;
  /* Icon-to-label gap matching our original buttons (services-ui: 8px). */
  gap: 6px;
}
/* Bold label; 600 matches the weight our original buttons used. */
.base.app-button :deep(.text) {
  font-weight: 600;
}
/* services-ui clamps slot icons to 0.75rem (12px); our original buttons
   drew them at 16px, matching the label height. The translateY optically
   centers the icon on the label's ink: glyph ink sits ~1.4px below the
   geometric line-box centre (descenders reach further below the midline
   than caps rise above it), and a box-centred icon reads as too high. */
.base.app-button :deep(.icon) {
  width: 16px;
  height: 16px;
  transform: translateY(1.4px);
}
/* Matches the height of our original pre-services-ui buttons. */
.base.app-button--compact {
  height: 34px;
}
</style>
