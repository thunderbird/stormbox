<script setup>
defineProps({
  size: { type: Number, default: 56 },
});
</script>

<template>
  <!--
    Stylised Thunderbird circle mark. This is an in-tree placeholder
    inspired by the Thundermail brand glyph; it stays self-contained so
    Stormbox builds without a separate asset pipeline.
  -->
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <radialGradient id="tbird-fill" cx="35%" cy="32%" r="80%">
        <stop offset="0%" stop-color="#71b6ff" />
        <stop offset="55%" stop-color="#4f8cff" />
        <stop offset="100%" stop-color="#2a5dd6" />
      </radialGradient>
    </defs>
    <circle cx="32" cy="32" r="30" fill="url(#tbird-fill)" />
    <path
      fill="#ffffff"
      d="M44.4 21.8c-1.7-1.5-4-2.4-6.6-2.6-3.9-.3-7.6 1.2-10.6 4l-7.3 6.8c-.7.7-.6 1.9.3 2.4l5.6 2.9-1.6 1.6c-1.7 1.7-2.6 4-2.4 6.3.2 2.3 1.4 4.4 3.3 5.8 1.7 1.2 3.7 1.7 5.7 1.5 2-.2 3.9-1.1 5.4-2.6l11.2-11c2-2 3-4.8 2.7-7.6-.3-2.8-1.7-5.4-3.7-7.5Zm-5.7 14.1-9.5 9.3c-.7.7-1.6 1.1-2.5 1.2-1 .1-1.9-.1-2.7-.7-.9-.6-1.5-1.6-1.6-2.7-.1-1.1.3-2.2 1.1-3l3-3 8.5 4.4c.9.4 1.9-.2 2.1-1.2.1-.5-.1-1-.4-1.3l-7.6-7.4 4.5-4.2c1.7-1.6 4-2.4 6.3-2.2 1.7.1 3.3.8 4.5 1.9 1.2 1.1 2 2.6 2.2 4.2.2 1.7-.4 3.4-1.6 4.6l-.3.1Z"
    />
  </svg>
</template>
