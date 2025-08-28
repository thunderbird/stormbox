<script>
import { ref, computed, watch, onMounted } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import Avatar from './Avatar.vue'

export default {
  name: 'MessageList',
  components: {
    Avatar
  },
  props: {
    currentMailboxId: String,
    selectedEmailId: String,
    viewMode: String,
    visibleMessages: Array,
    totalCount: Number
  },
  emits: ['set-view', 'select-message', 'virt-range', 'update:filterText'],
  setup(props, { emit }) {
    const filterText = ref('')
    const rows = ref(null)
    const colsRef = ref(null)
    const rowHeight = 56
    const debugInfo = false

    const sortPropForBox = (boxId) => {
      // This would need to be passed from parent or computed differently
      return 'receivedAt'
    }

    const fmtDate = (iso) => {
      try {
        return new Date(iso).toLocaleString();
      } catch {
        return iso || "";
      }
    }

    const corrFor = (m) => {
      const role = (props.currentMailboxId?.role || "").toLowerCase();
      const fname = (props.currentMailboxId?.name || "").toLowerCase();
      const sentish = role === "sent" || fname === "sent" || fname === "sent items";
      if (sentish) {
        const a = (m.to && m.to[0]) || {};
        return {
          name: (a.name || "").trim(),
          email: (a.email || "").trim(),
          display: a.name || a.email || ""
        };
      }
      const a = (m.from && m.from[0]) || {};
      return {
        name: (a.name || "").trim(),
        email: (a.email || "").trim(),
        display: a.name || a.email || ""
      };
    }

    // Removed onRowsScroll - no longer needed

    // Virtualizer over visibleMessages
    const items = computed(() => props.visibleMessages || [])
    const isFiltered = computed(() => !!filterText.value || props.viewMode !== 'all')

    // Use total count when not filtering, otherwise use actual items length
    const virtualCount = computed(() => {
      if (isFiltered.value) {
        return items.value.length;
      }
      // Use the total count from the server if available
      return props.totalCount || items.value.length;
    })

    const virtualizer = useVirtualizer(
      computed(() => ({
        count: virtualCount.value,
        getScrollElement: () => rows.value,
        estimateSize: () => rowHeight,
        overscan: 8,
        // Stable key by index avoids DOM reuse hazards during long jumps/sparse loads
        getItemKey: (i) => i,
        initialRect: { width: rows.value?.clientWidth || 0, height: rows.value?.clientHeight || 0 },
        initialOffset: 0
      }))
    )

    const virtualItems = computed(() => virtualizer.value.getVirtualItems())
    const totalSize = computed(() => virtualizer.value.getTotalSize())
    const size = computed(() => virtualizer.value.getSize())
    const scrollOffset = computed(() => virtualizer.value.getScrollOffset())
    const itemsLength = computed(() => items.value.length)

    const rowsMetrics = ref({ h: 0, ch: 0, sh: 0 })
    const updateRowsMetrics = () => {
      const el = rows.value
      if (!el) return
      rowsMetrics.value = {
        h: el.offsetHeight || 0,
        ch: el.clientHeight || 0,
        sh: el.scrollHeight || 0
      }
    }

    onMounted(() => {
      updateRowsMetrics()
      try {
        const ro = new ResizeObserver(() => updateRowsMetrics())
        if (rows.value) ro.observe(rows.value)
      } catch { }
    })

    // Compute filler height so the header stays pinned to the top when
    // there are fewer rows than the viewport height
    const headerHeight = computed(() => (colsRef.value?.offsetHeight) || 0)
    const fillerHeight = computed(() => Math.max(0, (size.value - totalSize.value - headerHeight.value)))

    const containerStyle = computed(() => ({
      height: totalSize.value + 'px',
      position: 'relative'
    }))

    const itemStyle = (v) => ({
      position: 'absolute',
      top: v.start + 'px',
      left: 0,
      right: 0,
      height: v.size + 'px'
    })

    // Watch for filter text changes and emit to parent
    watch(filterText, (newValue) => {
      emit('update:filterText', newValue)
    })

    // Clear filter function
    const clearFilter = () => {
      filterText.value = ''
    }

    // Console diagnostics
    watch([itemsLength, virtualCount, totalSize, size, scrollOffset], ([il, vc, ts, sz, off]) => {
      if (debugInfo) {
        // eslint-disable-next-line no-console
        console.log('[virt]', { items: il, virtual: vc, totalSize: ts, size: sz, offset: off })
      }
      updateRowsMetrics()
    })

    // Reset scroll and virtualizer on mailbox change to avoid stale measurements
    watch(() => props.currentMailboxId, async () => {
      if (rows.value) rows.value.scrollTop = 0
      await Promise.resolve()
      requestAnimationFrame(() => {
        try {
          if ((items.value?.length || 0) > 0) {
            virtualizer.value.scrollToIndex(0, { align: 'start' })
          }
          virtualizer.value.measure()
        } catch { }
      })
    })

    // Prefetch trigger based on virtual range
    let lastEmit = 0
    watch(virtualItems, (vis) => {
      const end = vis.length ? vis[vis.length - 1].index : 0
      const now = performance.now()
      if (now - lastEmit > 100) { // throttle to ~10/sec
        emit('virt-range', end)
        lastEmit = now
      }
    })

    return {
      filterText,
      clearFilter,
      totalCount: computed(() => props.totalCount),
      rows,
      colsRef,
      rowHeight,
      debugInfo,
      sortPropForBox,
      fmtDate,
      corrFor,
      virtualizer,
      virtualItems,
      items,
      totalSize,
      itemsLength,
      virtualCount,
      size,
      scrollOffset,
      rowsMetrics,
      headerHeight,
      fillerHeight,
      containerStyle,
      itemStyle
    }
  }
}
</script>

<template>
  <section class="list">
    <div class="viewbar">
      <div class="seg">
        <button id="viewAll" :class="{ active: viewMode === 'all' }" @click="$emit('set-view', 'all')">
          All Mail
        </button>
        <button id="viewUnread" :class="{ active: viewMode === 'unread' }" @click="$emit('set-view', 'unread')">
          Unread
        </button>
      </div>
    </div>

    <div class="countbar">
      <div id="folderTotal" class="strong">Total Messages: {{ totalCount ?? '…' }}</div>
    </div>

    <div class="filterbar">
      <label for="q">Quick Filter</label>
      <div class="filter-input-container">
        <input id="q" type="search" v-model.trim="filterText" placeholder="Subject or From…">
        <button v-if="filterText" class="clear-filter" @click="clearFilter" title="Clear filter">×</button>
      </div>
    </div>

    <!-- Virtualization debug info -->
    <div class="vdbg" v-if="debugInfo">
      items: {{ itemsLength }}, virtual: {{ virtualCount }}, totalSize: {{ totalSize }}px, size: {{ size }}px, offset:
      {{ scrollOffset }}, hasEl: {{ !!rows }}
      | rows h/ch/sh: {{ rowsMetrics.h }}/{{ rowsMetrics.ch }}/{{ rowsMetrics.sh }}
    </div>

    <div id="rows" ref="rows">
      <div class="cols" ref="colsRef">
        <div></div>
        <div>Correspondents</div>
        <div>Subject</div>
        <div>Date</div>
      </div>

      <!-- Virtualized rows -->
      <div :style="containerStyle">
        <div v-for="v in virtualItems" :key="v.key" :style="itemStyle(v)">
          <div v-if="items[v.index]" class="rowitem"
            :class="[{ unread: !items[v.index].isSeen }, { selected: items[v.index].id === selectedEmailId }, { 'has-attach': items[v.index].hasAttachment }]"
            @click="$emit('select-message', items[v.index].id)">
            <Avatar :name="corrFor(items[v.index]).name" :email="corrFor(items[v.index]).email" />
            <div class="who">{{ corrFor(items[v.index]).display }}</div>
            <div class="line">
              <div class="subject">{{ items[v.index].subject || '(no subject)' }}</div>
              <div class="snippet">{{ (items[v.index].preview || '').trim() }}</div>
            </div>
            <div class="date">
              <span>{{ fmtDate(sortPropForBox(currentMailboxId) === 'sentAt' ? items[v.index].sentAt :
                items[v.index].receivedAt) }}</span>
            </div>
          </div>
          <div v-else class="rowitem"></div>
        </div>
      </div>

      <!-- Bottom filler to keep header at top when list is shorter than viewport -->
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

/* Fixed row height for virtualization */
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
  border-radius: .6rem;
  padding: 2px;
}

.seg button {
  background: transparent;
  border: 0;
  padding: .4rem .7rem;
  color: var(--muted);
  cursor: pointer;
  border-radius: .45rem;
  font-weight: 600;
}

.seg button.active {
  background: var(--accent);
  color: #fff;
}

.countbar {
  display: flex;
  gap: .6rem;
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
  /* Make it 1/3 the width */
  max-width: 300px;
}

.filterbar input {
  width: 100%;
  padding: .5rem .65rem;
  padding-right: 2rem;
  /* Make room for clear button */
  border: 1px solid var(--border);
  border-radius: .5rem;
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

/* Blue unread dot (left) */
.rowitem.unread::before {
  content: "";
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}

/* Paperclip (after dot, left gutter) */
.rowitem.has-attach::after {
  content: "📎";
  position: absolute;
  left: 28px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 18px;
  line-height: 1;
  opacity: .9;
}

.loading {
  padding: 12px;
  text-align: center;
  color: var(--muted);
}
</style>
