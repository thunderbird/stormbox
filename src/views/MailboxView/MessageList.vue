<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useEmailStore } from '../../stores/email-store.js'
import Avatar from '../../components/Avatar.vue'

const emailStore = useEmailStore()

const rows = ref(null)
const colsRef = ref(null)
const rowHeight = 56
const debugInfo = false

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso || ''
  }
}

function corrFor(m) {
  const box = emailStore.currentBox
  const role = (box?.role || '').toLowerCase()
  const fname = (box?.name || '').toLowerCase()
  const sentish =
    role === 'sent' || fname === 'sent' || fname === 'sent items'
  const a = sentish
    ? (m.to && m.to[0]) || {}
    : (m.from && m.from[0]) || {}
  return {
    name: (a.name || '').trim(),
    email: (a.email || '').trim(),
    display: a.name || a.email || '',
  }
}

const items = computed(() => emailStore.visibleMessages || [])
const isFiltered = computed(
  () => !!emailStore.filterText || emailStore.viewMode !== 'all'
)

const virtualCount = computed(() => {
  if (isFiltered.value) return items.value.length
  return emailStore.totalEmailsCount || items.value.length
})

const virtualizer = useVirtualizer(
  computed(() => ({
    count: virtualCount.value,
    getScrollElement: () => rows.value,
    estimateSize: () => rowHeight,
    overscan: 8,
    getItemKey: (i) => i,
    initialRect: {
      width: rows.value?.clientWidth || 0,
      height: rows.value?.clientHeight || 0,
    },
    initialOffset: 0,
  }))
)

const virtualItems = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())
const size = computed(() => virtualizer.value.getSize())
const scrollOffset = computed(() => virtualizer.value.getScrollOffset())
const itemsLength = computed(() => items.value.length)

const rowsMetrics = ref({ h: 0, ch: 0, sh: 0 })
function updateRowsMetrics() {
  const el = rows.value
  if (!el) return
  rowsMetrics.value = {
    h: el.offsetHeight || 0,
    ch: el.clientHeight || 0,
    sh: el.scrollHeight || 0,
  }
}

onMounted(() => {
  updateRowsMetrics()
  try {
    const ro = new ResizeObserver(() => updateRowsMetrics())
    if (rows.value) ro.observe(rows.value)
  } catch {}
})

const headerHeight = computed(() => colsRef.value?.offsetHeight || 0)
const fillerHeight = computed(() =>
  Math.max(0, size.value - totalSize.value - headerHeight.value)
)

const containerStyle = computed(() => ({
  height: totalSize.value + 'px',
  position: 'relative',
}))

function itemStyle(v) {
  return {
    position: 'absolute',
    top: v.start + 'px',
    left: 0,
    right: 0,
    height: v.size + 'px',
  }
}

function clearFilter() {
  emailStore.filterText = ''
}

watch(
  [itemsLength, virtualCount, totalSize, size, scrollOffset],
  ([il, vc, ts, sz, off]) => {
    if (debugInfo) {
      console.log('[virt]', {
        items: il,
        virtual: vc,
        totalSize: ts,
        size: sz,
        offset: off,
      })
    }
    updateRowsMetrics()
  }
)

watch(
  () => emailStore.currentMailboxId,
  async () => {
    if (rows.value) rows.value.scrollTop = 0
    await Promise.resolve()
    requestAnimationFrame(() => {
      try {
        if ((items.value?.length || 0) > 0) {
          virtualizer.value.scrollToIndex(0, { align: 'start' })
        }
        virtualizer.value.measure()
      } catch {}
    })
  }
)

let lastEmit = 0
watch(virtualItems, (vis) => {
  const end = vis.length ? vis[vis.length - 1].index : 0
  const now = performance.now()
  if (now - lastEmit > 100) {
    emailStore.onVirtRange(end)
    lastEmit = now
  }
})
</script>

<template>
  <section class="list">
    <div class="viewbar">
      <div class="seg">
        <button
          id="viewAll"
          :class="{ active: emailStore.viewMode === 'all' }"
          @click="emailStore.setView('all')"
        >
          All Mail
        </button>
        <button
          id="viewUnread"
          :class="{ active: emailStore.viewMode === 'unread' }"
          @click="emailStore.setView('unread')"
        >
          Unread
        </button>
      </div>
    </div>

    <div class="countbar">
      <div id="folderTotal" class="strong">
        Total Messages: {{ emailStore.totalEmailsCount ?? '…' }}
      </div>
    </div>

    <div class="filterbar">
      <label for="q">Quick Filter</label>
      <div class="filter-input-container">
        <input
          id="q"
          type="search"
          v-model.trim="emailStore.filterText"
          placeholder="Subject or From…"
        />
        <button
          v-if="emailStore.filterText"
          class="clear-filter"
          @click="clearFilter"
          title="Clear filter"
        >
          ×
        </button>
      </div>
    </div>

    <div class="vdbg" v-if="debugInfo">
      items: {{ itemsLength }}, virtual: {{ virtualCount }}, totalSize:
      {{ totalSize }}px, size: {{ size }}px, offset: {{ scrollOffset }},
      hasEl: {{ !!rows }} | rows h/ch/sh:
      {{ rowsMetrics.h }}/{{ rowsMetrics.ch }}/{{ rowsMetrics.sh }}
    </div>

    <div id="rows" ref="rows">
      <div class="cols" ref="colsRef">
        <div></div>
        <div>Correspondents</div>
        <div>Subject</div>
        <div>Date</div>
      </div>

      <div :style="containerStyle">
        <div v-for="v in virtualItems" :key="v.key" :style="itemStyle(v)">
          <div
            v-if="items[v.index]"
            class="rowitem"
            :class="[
              { unread: !items[v.index].isSeen },
              {
                selected:
                  items[v.index].id === emailStore.selectedEmailId,
              },
              { 'has-attach': items[v.index].hasAttachment },
            ]"
            @click="emailStore.selectMessage(items[v.index].id)"
          >
            <Avatar
              :name="corrFor(items[v.index]).name"
              :email="corrFor(items[v.index]).email"
            />
            <div class="who">{{ corrFor(items[v.index]).display }}</div>
            <div class="line">
              <div class="subject">
                {{ items[v.index].subject || '(no subject)' }}
              </div>
              <div class="snippet">
                {{ (items[v.index].preview || '').trim() }}
              </div>
            </div>
            <div class="date">
              <span>{{
                fmtDate(
                  emailStore.sortPropForBox(emailStore.currentBox) ===
                    'sentAt'
                    ? items[v.index].sentAt
                    : items[v.index].receivedAt
                )
              }}</span>
            </div>
          </div>
          <div v-else class="rowitem"></div>
        </div>
      </div>

      <div class="filler" :style="{ height: fillerHeight + 'px' }"></div>
    </div>
  </section>
</template>

<style scoped>
.list {
  border-right: 1px solid var(--border);
  display: grid;
  grid-template-rows: auto auto auto 1fr;
  background: var(--panel2);
  min-height: 0;
  height: 100%;
  --colspec: 40px 220px 1fr 140px;
}

#rows {
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  height: 100%;
}

.rowitem {
  height: 56px;
}

.viewbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.seg {
  display: inline-flex;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  padding: 2px;
}

.seg button {
  background: transparent;
  border: 0;
  padding: 0.4rem 0.7rem;
  color: var(--muted);
  cursor: pointer;
  border-radius: 0.45rem;
  font-weight: 600;
}

.seg button.active {
  background: var(--accent);
  color: #fff;
}

.countbar {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}

.countbar .strong {
  color: var(--text);
  font-weight: 600;
}

.filterbar {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.filterbar label {
  color: var(--muted);
  font-size: 12px;
}

.filter-input-container {
  position: relative;
  display: inline-block;
  width: 33%;
  max-width: 300px;
}

.filterbar input {
  width: 100%;
  padding: 0.5rem 0.65rem;
  padding-right: 2rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--panel);
  color: var(--text);
  outline: none;
}

.clear-filter {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  font-size: 18px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

.clear-filter:hover {
  background: var(--border);
  color: var(--text);
}

.filterbar input::placeholder {
  color: #9aa3b2;
}

.filterbar input:-webkit-autofill {
  -webkit-box-shadow: 0 0 0px 1000px var(--panel) inset;
  -webkit-text-fill-color: var(--text);
}

#rows .cols {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel2);
  padding: 10px 12px 10px 50px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
  display: grid;
  grid-template-columns: var(--colspec);
  gap: 10px;
  align-items: center;
}

.rowitem {
  position: relative;
  padding: 10px 12px 10px 50px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  display: grid;
  grid-template-columns: var(--colspec);
  gap: 10px;
  align-items: center;
}

.rowitem:hover {
  background: var(--rowHover);
}

.rowitem.selected {
  background: var(--rowActive);
}

.rowitem .who {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 400;
}

.rowitem .subject {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 400;
}

.rowitem.unread .who,
.rowitem.unread .subject {
  font-weight: 700;
}

.rowitem .snippet {
  color: var(--muted);
  font-weight: 400;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rowitem .date {
  color: var(--muted);
  justify-self: end;
  text-align: right;
  display: flex;
  align-items: center;
  gap: 6px;
}

.rowitem.unread::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}

.rowitem.has-attach::after {
  content: '\U0001F4CE';
  position: absolute;
  left: 28px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 18px;
  line-height: 1;
  opacity: 0.9;
}

.loading {
  padding: 12px;
  text-align: center;
  color: var(--muted);
}
</style>
