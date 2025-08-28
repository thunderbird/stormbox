<script>
import { ref, computed } from 'vue'
import { md5 } from '../utils/md5.js'

export default {
  name: 'Avatar',
  props: {
    name: String,
    email: String
  },
  setup(props) {
    const hasImg = ref(true)

    const hash = computed(() => {
      return (props.email || "").trim() ? md5((props.email || "").trim().toLowerCase()) : ""
    })

    const url = computed(() => {
      return hash.value ? `https://seccdn.libravatar.org/avatar/${hash.value}?d=404&s=80` : ""
    })

    const initials = computed(() => {
      const src = (props.name || "").trim() || (props.email || "").trim()
      if (!src) return "?"
      const parts = src.replace(/\s+/g, " ").split(" ")
      if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase()
      return src[0].toUpperCase()
    })

    const backgroundColor = computed(() => {
      const source = props.email || props.name || 'x'
      const hash = Math.abs(source.split('').reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 0))
      const hue = hash % 360
      return `hsl(${hue} 40% 25%)`
    })

    return {
      hasImg,
      hash,
      url,
      initials,
      backgroundColor
    }
  }
}
</script>

<template>
  <div class="avatar" :style="{ background: backgroundColor }">
    <img v-if="hasImg && url" :src="url" referrerpolicy="no-referrer" crossorigin="anonymous" @error="hasImg = false" />
    <span v-else>{{ initials }}</span>
  </div>
</template>

<style scoped>
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: #22273a;
  color: #cfd5e6;
  font-weight: 700;
  font-size: 12px;
  user-select: none;
}

.avatar img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
</style>
